# Health Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-fix capability to NanoClaw's health monitoring — detect known failure patterns, attempt repair, verify the fix, and escalate to Telegram if auto-fix fails.

**Architecture:** Two layers. Layer 1 extends `src/health-monitor.ts` with a fix handler registry and generic check→fix→verify executor. Layer 2 is a minimal external heartbeat bash script (launchd, every 2 min) that detects process stalls and crash-loops. Both layers coordinate via a filesystem lock.

**Tech Stack:** TypeScript (Bun), Bash, launchd, vitest

**Spec:** `docs/superpowers/specs/2026-04-04-health-watchdog-design.md`

---

## File Map

| File | Responsibility | Action |
|---|---|---|
| `src/health-monitor.ts` | Core health monitoring + NEW fix handler registry | Modify |
| `src/health-monitor.test.ts` | Tests for health monitor including new fix handlers | Modify |
| `src/index.ts` | Wire fix handlers, health endpoint, liveness check | Modify |
| `scripts/fixes/restart-simplemem.sh` | Docker restart SimpleMem | Create |
| `scripts/fixes/restart-qmd.sh` | launchctl restart QMD | Create |
| `scripts/fixes/restart-apple-notes.sh` | launchctl restart Apple Notes | Create |
| `scripts/fixes/restart-todoist.sh` | launchctl restart Todoist | Create |
| `scripts/fixes/kill-port-squatter.sh` | Identity-verified port squatter removal | Create |
| `scripts/fixes/kill-sqlite-orphans.sh` | Kill orphaned nanoclaw container processes | Create |
| `scripts/fixes/restart-container-runtime.sh` | Restart Apple Container runtime | Create |
| `scripts/refresh-oauth.sh` | Add flock for race prevention | Modify |
| `scripts/watchdog-heartbeat.sh` | External heartbeat + circuit breaker | Create |
| `launchd/com.nanoclaw.watchdog.plist` | Heartbeat launchd config | Create |

---

## Task 1: FixHandler Types and Registry

**Files:**
- Modify: `src/health-monitor.ts`
- Modify: `src/health-monitor.test.ts`

- [ ] **Step 1: Write failing tests for fix handler registration**

Add to the bottom of `src/health-monitor.test.ts`:

```typescript
describe('HealthMonitor fix handlers', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
  });

  it('registers and retrieves fix handlers', () => {
    const handler: FixHandler = {
      id: 'mcp-simplemem',
      service: 'mcp:SimpleMem',
      fixScript: '/path/to/restart-simplemem.sh',
      verify: { type: 'http', url: 'http://localhost:8200/api/health', expectStatus: 200 },
      cooldownMs: 120_000,
      maxAttempts: 2,
    };
    monitor.addFixHandler(handler);
    expect(monitor.getFixHandler('mcp:SimpleMem')).toBe(handler);
  });

  it('returns undefined for unknown service', () => {
    expect(monitor.getFixHandler('mcp:Unknown')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/health-monitor.test.ts -t "registers and retrieves"`
Expected: FAIL — `addFixHandler` and `getFixHandler` not defined, `FixHandler` type not exported

- [ ] **Step 3: Add FixHandler type and registry to health-monitor.ts**

Add these types after the existing `HealthMonitorConfig` interface (after line 35):

```typescript
export interface FixVerify {
  type: 'http' | 'command';
  url?: string;           // for type: 'http'
  expectStatus?: number;  // for type: 'http' (default: 200)
  cmd?: string;           // for type: 'command' — path to script
  args?: string[];        // for type: 'command'
}

export interface FixHandler {
  id: string;
  service: string;        // matches the service key used in recordInfraEvent
  fixScript: string;      // absolute path to fix script
  fixArgs?: string[];     // optional args for fix script
  verify: FixVerify;
  cooldownMs: number;
  maxAttempts: number;
}
```

Add to the `HealthMonitor` class body (after the existing private fields, around line 47):

```typescript
  private fixHandlers: Map<string, FixHandler> = new Map();

  addFixHandler(handler: FixHandler): void {
    this.fixHandlers.set(handler.service, handler);
  }

  getFixHandler(service: string): FixHandler | undefined {
    return this.fixHandlers.get(service);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/health-monitor.test.ts -t "fix handlers"`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add src/health-monitor.ts src/health-monitor.test.ts
git commit -m "feat(watchdog): add FixHandler types and registry to HealthMonitor"
```

---

## Task 2: Fix Attempt Executor with Cooldown and Lock

**Files:**
- Modify: `src/health-monitor.ts`
- Modify: `src/health-monitor.test.ts`

- [ ] **Step 1: Write failing tests for attemptFix**

Add to the `HealthMonitor fix handlers` describe block in `src/health-monitor.test.ts`:

```typescript
  describe('attemptFix', () => {
    const mockActions: FixActions = {
      execScript: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
      httpCheck: vi.fn().mockResolvedValue({ reachable: true, statusCode: 200 }),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      (mockActions.execScript as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, stdout: '', stderr: '' });
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: true, statusCode: 200 });
      (mockActions.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      monitor.setFixActions(mockActions);
    });

    it('executes fix script and verifies success', async () => {
      const handler: FixHandler = {
        id: 'mcp-simplemem',
        service: 'mcp:SimpleMem',
        fixScript: '/scripts/fixes/restart-simplemem.sh',
        verify: { type: 'http', url: 'http://localhost:8200/api/health', expectStatus: 200 },
        cooldownMs: 120_000,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      const result = await monitor.attemptFix('mcp:SimpleMem');
      expect(result).toBe('fixed');
      expect(mockActions.execScript).toHaveBeenCalledWith('/scripts/fixes/restart-simplemem.sh', undefined);
      expect(mockActions.httpCheck).toHaveBeenCalledWith('http://localhost:8200/api/health');
      expect(mockActions.acquireLock).toHaveBeenCalled();
      expect(mockActions.releaseLock).toHaveBeenCalled();
    });

    it('skips fix during cooldown period', async () => {
      const handler: FixHandler = {
        id: 'test-service',
        service: 'mcp:Test',
        fixScript: '/scripts/fixes/test.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
        cooldownMs: 120_000,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      // First attempt succeeds
      await monitor.attemptFix('mcp:Test');
      // Second attempt within cooldown should be skipped
      const result = await monitor.attemptFix('mcp:Test');
      expect(result).toBe('cooldown');
      expect(mockActions.execScript).toHaveBeenCalledTimes(1);
    });

    it('escalates after maxAttempts failures', async () => {
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: false, statusCode: undefined });
      const handler: FixHandler = {
        id: 'fail-service',
        service: 'mcp:Failing',
        fixScript: '/scripts/fixes/fail.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
        cooldownMs: 0, // no cooldown for test
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      await monitor.attemptFix('mcp:Failing');
      const result = await monitor.attemptFix('mcp:Failing');
      expect(result).toBe('escalated');
      expect(alertFn).toHaveBeenCalled();
      const call = (alertFn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: [HealthAlert]) => c[0].type === 'fix_escalation',
      );
      expect(call).toBeDefined();
    });

    it('skips fix if lock cannot be acquired', async () => {
      (mockActions.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const handler: FixHandler = {
        id: 'locked',
        service: 'mcp:Locked',
        fixScript: '/scripts/fixes/test.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
        cooldownMs: 0,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      const result = await monitor.attemptFix('mcp:Locked');
      expect(result).toBe('locked');
      expect(mockActions.execScript).not.toHaveBeenCalled();
    });

    it('returns no-handler for unknown services', async () => {
      const result = await monitor.attemptFix('mcp:Unknown');
      expect(result).toBe('no-handler');
    });

    it('resets attempt count after successful fix', async () => {
      const handler: FixHandler = {
        id: 'reset-test',
        service: 'mcp:Reset',
        fixScript: '/scripts/fixes/test.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
        cooldownMs: 0,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      // Fail once
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ reachable: false });
      await monitor.attemptFix('mcp:Reset');

      // Succeed
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ reachable: true, statusCode: 200 });
      await monitor.attemptFix('mcp:Reset');

      // Fail again — should NOT escalate (count was reset)
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: false });
      const result = await monitor.attemptFix('mcp:Reset');
      expect(result).toBe('verify-failed');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/health-monitor.test.ts -t "attemptFix"`
Expected: FAIL — `FixActions` type not defined, `setFixActions` and `attemptFix` not implemented, `fix_escalation` not in HealthAlert type

- [ ] **Step 3: Implement attemptFix in health-monitor.ts**

First, update the `HealthAlert` type union to include `fix_escalation`:

```typescript
export interface HealthAlert {
  type: 'excessive_spawns' | 'excessive_errors' | 'infra_error' | 'fix_escalation';
  group: string;
  detail: string;
  timestamp: number;
}
```

Add the `FixActions` interface after `FixHandler` (this is the injectable actions interface for testability):

```typescript
export type FixResult = 'fixed' | 'verify-failed' | 'escalated' | 'cooldown' | 'locked' | 'no-handler' | 'script-failed';

export interface FixActions {
  execScript: (script: string, args?: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  httpCheck: (url: string) => Promise<{ reachable: boolean; statusCode?: number }>;
  acquireLock: (action: string) => Promise<boolean>;
  releaseLock: () => Promise<void>;
}
```

Add these private fields to the `HealthMonitor` class (after `fixHandlers`):

```typescript
  private fixActions?: FixActions;
  private fixAttemptCounts: Map<string, number> = new Map();  // service → consecutive failed attempts
  private fixLastAttempt: Map<string, number> = new Map();    // service → timestamp of last attempt
```

Add `setFixActions`:

```typescript
  setFixActions(actions: FixActions): void {
    this.fixActions = actions;
  }
```

Add `attemptFix`:

```typescript
  async attemptFix(service: string): Promise<FixResult> {
    const handler = this.fixHandlers.get(service);
    if (!handler) return 'no-handler';
    if (!this.fixActions) return 'no-handler';

    // Cooldown check
    const lastAttempt = this.fixLastAttempt.get(service) ?? 0;
    if (Date.now() - lastAttempt < handler.cooldownMs) return 'cooldown';

    // Max attempts check — escalate if exceeded
    const attempts = this.fixAttemptCounts.get(service) ?? 0;
    if (attempts >= handler.maxAttempts) {
      this.config.onAlert({
        type: 'fix_escalation',
        group: service,
        detail: `Auto-fix failed after ${attempts} attempts for ${handler.id}`,
        timestamp: Date.now(),
      });
      // Reset so it can try again next cycle after cooldown
      this.fixAttemptCounts.set(service, 0);
      this.fixLastAttempt.set(service, Date.now());
      return 'escalated';
    }

    // Acquire lock
    const locked = await this.fixActions.acquireLock(handler.id);
    if (!locked) return 'locked';

    try {
      this.fixLastAttempt.set(service, Date.now());
      logger.info({ service, handler: handler.id }, 'watchdog: attempting fix');

      // Execute fix script
      const execResult = await this.fixActions.execScript(handler.fixScript, handler.fixArgs);
      if (!execResult.ok) {
        this.fixAttemptCounts.set(service, attempts + 1);
        logger.warn({ service, stderr: execResult.stderr }, 'watchdog: fix script failed');
        return 'script-failed';
      }

      // Verify
      const verified = await this.verifyFix(handler.verify);
      if (verified) {
        this.fixAttemptCounts.set(service, 0); // reset on success
        this.clearInfraEvent(service);
        logger.info({ service, handler: handler.id }, 'watchdog: fix verified');
        return 'fixed';
      }

      this.fixAttemptCounts.set(service, attempts + 1);
      logger.warn({ service, handler: handler.id }, 'watchdog: fix verification failed');
      return 'verify-failed';
    } finally {
      await this.fixActions.releaseLock();
    }
  }

  private async verifyFix(verify: FixVerify): Promise<boolean> {
    if (!this.fixActions) return false;

    if (verify.type === 'http' && verify.url) {
      const result = await this.fixActions.httpCheck(verify.url);
      const expectedStatus = verify.expectStatus ?? 200;
      return result.reachable && result.statusCode === expectedStatus;
    }

    if (verify.type === 'command' && verify.cmd) {
      const result = await this.fixActions.execScript(verify.cmd, verify.args);
      return result.ok;
    }

    return false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/health-monitor.test.ts -t "attemptFix"`
Expected: ALL PASS (6 tests)

- [ ] **Step 5: Run full test suite**

Run: `bun test src/health-monitor.test.ts`
Expected: ALL PASS (existing tests + new tests)

- [ ] **Step 6: Commit**

```bash
git add src/health-monitor.ts src/health-monitor.test.ts
git commit -m "feat(watchdog): add attemptFix executor with cooldown, lock, and escalation"
```

---

## Task 3: Fix Scripts

**Files:**
- Create: `scripts/fixes/restart-simplemem.sh`
- Create: `scripts/fixes/restart-qmd.sh`
- Create: `scripts/fixes/restart-apple-notes.sh`
- Create: `scripts/fixes/restart-todoist.sh`
- Create: `scripts/fixes/restart-container-runtime.sh`
- Create: `scripts/fixes/kill-sqlite-orphans.sh`
- Create: `scripts/fixes/kill-port-squatter.sh`
- Modify: `scripts/refresh-oauth.sh`

- [ ] **Step 1: Create scripts/fixes/ directory and restart-simplemem.sh**

```bash
#!/bin/bash
# Restart SimpleMem Docker container
set -euo pipefail
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would run 'docker restart simplemem'"
  exit 0
fi
docker restart simplemem 2>&1
sleep 3  # wait for container to be ready
```

- [ ] **Step 2: Create restart-qmd.sh**

```bash
#!/bin/bash
# Restart QMD server and proxy via launchd
set -euo pipefail
UID_NUM=$(id -u)
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would restart com.qmd-server and com.qmd-proxy"
  exit 0
fi
launchctl kickstart -k "gui/${UID_NUM}/com.qmd-server" 2>&1
sleep 1
launchctl kickstart -k "gui/${UID_NUM}/com.qmd-proxy" 2>&1
sleep 2
```

- [ ] **Step 3: Create restart-apple-notes.sh**

```bash
#!/bin/bash
# Restart Apple Notes MCP via launchd
set -euo pipefail
UID_NUM=$(id -u)
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would restart com.apple-notes-mcp"
  exit 0
fi
launchctl kickstart -k "gui/${UID_NUM}/com.apple-notes-mcp" 2>&1
sleep 2
```

- [ ] **Step 4: Create restart-todoist.sh**

```bash
#!/bin/bash
# Restart Todoist MCP via launchd
set -euo pipefail
UID_NUM=$(id -u)
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would restart com.todoist-mcp"
  exit 0
fi
launchctl kickstart -k "gui/${UID_NUM}/com.todoist-mcp" 2>&1
sleep 2
```

- [ ] **Step 5: Create restart-container-runtime.sh**

```bash
#!/bin/bash
# Restart Apple Container runtime
set -euo pipefail
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would run 'container system start'"
  exit 0
fi
/usr/local/bin/container system start 2>&1
sleep 2
```

- [ ] **Step 6: Create kill-sqlite-orphans.sh**

```bash
#!/bin/bash
# Kill orphaned nanoclaw container processes that may hold SQLite locks
set -euo pipefail
if [ "${1:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would kill orphaned nanoclaw-* container processes"
  # Show what would be killed
  pgrep -f "nanoclaw-" 2>/dev/null | while read -r pid; do
    echo "  Would kill PID $pid: $(ps -p "$pid" -o command= 2>/dev/null || echo unknown)"
  done
  exit 0
fi

KILLED=0
pgrep -f "nanoclaw-" 2>/dev/null | while read -r pid; do
  CMD=$(ps -p "$pid" -o command= 2>/dev/null || echo "unknown")
  echo "Killing orphaned process PID=$pid CMD=$CMD"
  kill "$pid" 2>/dev/null || true
  KILLED=$((KILLED + 1))
done

if [ "$KILLED" -eq 0 ]; then
  echo "No orphaned nanoclaw processes found"
fi
```

- [ ] **Step 7: Create kill-port-squatter.sh**

This script takes a port number and expected process pattern as arguments.

```bash
#!/bin/bash
# Kill a process squatting on a NanoClaw port (only if NOT the expected service)
# Usage: kill-port-squatter.sh <port> <expected_pattern>
set -euo pipefail

PORT="${1:?Usage: kill-port-squatter.sh <port> <expected_pattern>}"
EXPECTED="${2:?Usage: kill-port-squatter.sh <port> <expected_pattern>}"

# Find PID on the port
PID=$(lsof -ti ":${PORT}" -sTCP:LISTEN 2>/dev/null | head -1)
if [ -z "$PID" ]; then
  echo "No process found on port $PORT"
  exit 0
fi

CMD=$(ps -p "$PID" -o command= 2>/dev/null || echo "unknown")
USER_NAME=$(ps -p "$PID" -o user= 2>/dev/null || echo "unknown")

# Check if this IS the expected service
if echo "$CMD" | grep -qi "$EXPECTED"; then
  echo "Port $PORT held by expected process (PID=$PID CMD=$CMD)"
  exit 0
fi

if [ "${3:-}" = "--dry-run" ]; then
  echo "DRY-RUN: would kill PID=$PID USER=$USER_NAME CMD=$CMD on port $PORT (expected: $EXPECTED)"
  exit 0
fi

echo "Killing port squatter: PORT=$PORT PID=$PID USER=$USER_NAME CMD=$CMD (expected: $EXPECTED)"
kill "$PID" 2>/dev/null || true
sleep 1

# Verify port is free
if lsof -ti ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "WARNING: Port $PORT still occupied after kill"
  exit 1
fi
echo "Port $PORT freed"
```

- [ ] **Step 8: Add flock to refresh-oauth.sh**

Add this line after `set -euo pipefail` (line 8) in `scripts/refresh-oauth.sh`:

```bash
exec 200>/tmp/nanoclaw-oauth.lock
flock -n 200 || { echo "Another OAuth refresh is running, skipping"; exit 0; }
```

- [ ] **Step 9: Make all scripts executable**

```bash
chmod +x scripts/fixes/*.sh
```

- [ ] **Step 10: Test dry-run mode for each script**

Run each:
```bash
scripts/fixes/restart-simplemem.sh --dry-run
scripts/fixes/restart-qmd.sh --dry-run
scripts/fixes/restart-apple-notes.sh --dry-run
scripts/fixes/restart-todoist.sh --dry-run
scripts/fixes/restart-container-runtime.sh --dry-run
scripts/fixes/kill-sqlite-orphans.sh --dry-run
scripts/fixes/kill-port-squatter.sh 8181 qmd --dry-run
```

Expected: Each prints its DRY-RUN message and exits 0.

- [ ] **Step 11: Commit**

```bash
git add scripts/fixes/ scripts/refresh-oauth.sh
git commit -m "feat(watchdog): add fix scripts with dry-run support and OAuth flock"
```

---

## Task 4: Wire Fix Handlers into index.ts

**Files:**
- Modify: `src/index.ts`
- Modify: `src/health-monitor.ts` (import `execFile`)

- [ ] **Step 1: Create the default FixActions implementation in health-monitor.ts**

Add this exported factory function at the bottom of `src/health-monitor.ts` (after the class):

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';

const execFileAsync = promisify(execFile);

const LOCK_PATH = path.join(
  process.env.HOME || '/tmp',
  '.nanoclaw',
  'watchdog.lock',
);

export function createDefaultFixActions(): FixActions {
  return {
    execScript: async (script: string, args?: string[]) => {
      try {
        const { stdout, stderr } = await execFileAsync(script, args ?? [], {
          timeout: 30_000,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '' },
        });
        return { ok: true, stdout, stderr };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
      }
    },

    httpCheck: async (url: string) => {
      return new Promise((resolve) => {
        try {
          const parsed = new URL(url);
          const req = http.request(
            {
              hostname: parsed.hostname,
              port: parsed.port,
              path: parsed.pathname,
              method: 'GET',
              timeout: 5000,
            },
            (res) => {
              res.resume();
              resolve({ reachable: true, statusCode: res.statusCode });
            },
          );
          req.on('error', () => resolve({ reachable: false }));
          req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
          req.end();
        } catch {
          resolve({ reachable: false });
        }
      });
    },

    acquireLock: async (action: string) => {
      try {
        await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
        // Check existing lock
        try {
          const content = await fs.readFile(LOCK_PATH, 'utf-8');
          const lock = JSON.parse(content) as { pid: number; started: string };
          const age = Date.now() - new Date(lock.started).getTime();
          // If lock is fresh (< 5 min) and PID is alive, skip
          if (age < 300_000) {
            try { process.kill(lock.pid, 0); return false; } catch { /* PID dead, take lock */ }
          }
        } catch { /* no lock file or invalid, proceed */ }
        // Write lock atomically
        const tmp = LOCK_PATH + '.tmp';
        await fs.writeFile(tmp, JSON.stringify({
          pid: process.pid,
          action,
          started: new Date().toISOString(),
        }));
        await fs.rename(tmp, LOCK_PATH);
        return true;
      } catch {
        return false;
      }
    },

    releaseLock: async () => {
      try { await fs.unlink(LOCK_PATH); } catch { /* ignore */ }
    },
  };
}
```

- [ ] **Step 2: Wire fix handlers and auto-fix into the health check interval in index.ts**

In `src/index.ts`, find the health monitor construction (around line 790). After the `healthMonitor = new HealthMonitor({...})` block (after line 810), add:

```typescript
  // Wire watchdog fix handlers
  const fixScriptsDir = path.join(process.cwd(), 'scripts', 'fixes');
  const oauthScript = path.join(process.cwd(), 'scripts', 'refresh-oauth.sh');

  healthMonitor.addFixHandler({
    id: 'mcp-simplemem', service: 'mcp:SimpleMem',
    fixScript: path.join(fixScriptsDir, 'restart-simplemem.sh'),
    verify: { type: 'http', url: 'http://localhost:8200/api/health', expectStatus: 200 },
    cooldownMs: 120_000, maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'mcp-qmd', service: 'mcp:QMD',
    fixScript: path.join(fixScriptsDir, 'restart-qmd.sh'),
    verify: { type: 'http', url: 'http://localhost:8181/health', expectStatus: 200 },
    cooldownMs: 120_000, maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'mcp-apple-notes', service: 'mcp:Apple Notes',
    fixScript: path.join(fixScriptsDir, 'restart-apple-notes.sh'),
    verify: { type: 'http', url: 'http://localhost:8184/mcp', expectStatus: 405 },
    cooldownMs: 120_000, maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'mcp-todoist', service: 'mcp:Todoist',
    fixScript: path.join(fixScriptsDir, 'restart-todoist.sh'),
    verify: { type: 'http', url: 'http://localhost:8186/mcp', expectStatus: 405 },
    cooldownMs: 120_000, maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'container-runtime', service: 'container-runtime',
    fixScript: path.join(fixScriptsDir, 'restart-container-runtime.sh'),
    verify: { type: 'command', cmd: '/usr/local/bin/container', args: ['system', 'status'] },
    cooldownMs: 120_000, maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'sqlite-lock', service: 'sqlite-lock',
    fixScript: path.join(fixScriptsDir, 'kill-sqlite-orphans.sh'),
    verify: { type: 'command', cmd: '/bin/sh', args: ['-c', 'echo "SELECT 1" | sqlite3 store/messages.db'] },
    cooldownMs: 60_000, maxAttempts: 2,
  });

  healthMonitor.setFixActions(createDefaultFixActions());
```

Also add the import at the top of `index.ts`:

```typescript
import { createDefaultFixActions } from './health-monitor.js';
```

- [ ] **Step 3: Add auto-fix call to the existing health check interval**

In the existing `setInterval` block (around line 842-863), modify the `else` branch that records infra events to also attempt auto-fix. Replace the block:

```typescript
      } else {
        healthMonitor.recordInfraEvent(
          `mcp:${ep.name}`,
          `MCP server ${ep.name} is unreachable`,
        );
      }
```

With:

```typescript
      } else {
        healthMonitor.recordInfraEvent(
          `mcp:${ep.name}`,
          `MCP server ${ep.name} is unreachable`,
        );
        // Auto-fix: attempt repair if handler registered and threshold met
        const failCount = healthMonitor.getInfraFailureCount(`mcp:${ep.name}`);
        if (failCount >= 3) {
          void healthMonitor.attemptFix(`mcp:${ep.name}`);
        }
      }
```

- [ ] **Step 4: Expose getInfraFailureCount in health-monitor.ts**

Add this method to the `HealthMonitor` class:

```typescript
  getInfraFailureCount(service: string): number {
    return this.infraFailureCounts.get(service) ?? 0;
  }
```

- [ ] **Step 5: Build and verify no compilation errors**

Run: `bun run build`
Expected: No errors

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/health-monitor.ts src/index.ts
git commit -m "feat(watchdog): wire fix handlers into health check interval with auto-fix"
```

---

## Task 5: Health Endpoint and Liveness Self-Check

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add health endpoint to credential proxy server**

In `src/index.ts`, find the credential proxy start (around line 962). After `const proxyServer = await startCredentialProxy(...)`, but before `restoreRemoteControl()`, add:

```typescript
  // Health endpoint for external heartbeat (piggyback on proxy server port)
  const startTime = Date.now();
  let startupComplete = false;
  const healthServer = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: Math.floor((Date.now() - startTime) / 1000),
        startupComplete,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const HEALTH_PORT = CREDENTIAL_PROXY_PORT + 1; // e.g. 3002
  healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
    logger.info({ port: HEALTH_PORT }, 'Health endpoint started');
  });
```

Add the import at the top of `src/index.ts` (if `createServer` from `http` isn't already imported):

```typescript
import { createServer } from 'http';
```

- [ ] **Step 2: Add event loop liveness self-check**

After the health server setup, add:

```typescript
  // Event loop liveness: if the loop is blocked >30s, exit and let launchd restart
  let lastEventLoopTick = Date.now();
  setInterval(() => { lastEventLoopTick = Date.now(); }, 5000);
  setInterval(() => {
    if (Date.now() - lastEventLoopTick > 30_000) {
      logger.fatal('Event loop stalled for >30s, exiting for launchd restart');
      process.exit(1);
    }
  }, 10_000);
```

- [ ] **Step 3: Set startupComplete flag at end of main()**

After all initialization is complete (after the shutdown signal handlers), add:

```typescript
  startupComplete = true;
  logger.info('NanoClaw startup complete');
```

Move the `let startupComplete = false;` declaration to before the health server setup.

- [ ] **Step 4: Build and verify**

Run: `bun run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(watchdog): add health endpoint and event loop liveness self-check"
```

---

## Task 6: External Heartbeat Script

**Files:**
- Create: `scripts/watchdog-heartbeat.sh`
- Create: `launchd/com.nanoclaw.watchdog.plist`

- [ ] **Step 1: Create scripts/watchdog-heartbeat.sh**

```bash
#!/bin/bash
# NanoClaw external heartbeat monitor
# Runs via launchd every 2 minutes. Detects process stalls and crash-loops.
# Coordinates with in-process watchdog via filesystem lock.
set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_PORT="${NANOCLAW_HEALTH_PORT:-3002}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
LOG_FILE="${NANOCLAW_DIR}/logs/watchdog-heartbeat.log"
LOCK_FILE="${HOME}/.nanoclaw/watchdog.lock"
STATE_FILE="${HOME}/.nanoclaw/heartbeat-state"
BOT_TOKEN_FILE="${HOME}/.config/nanoclaw/watchdog-bot-token"
MAX_LOG_SIZE=1048576  # 1MB

# Ensure directories exist
mkdir -p "${HOME}/.nanoclaw" "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Log rotation: truncate if over 1MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
  tail -100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

# Health check
if curl -sf --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  # Healthy — clear any restart tracking
  exit 0
fi

log "Health check failed for $HEALTH_URL"

# Check filesystem lock — if Layer 1 is mid-fix, skip this cycle
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f%m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    LOCK_PID=$(python3 -c "import json; print(json.load(open('$LOCK_FILE'))['pid'])" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
      log "Skipping restart: Layer 1 mid-fix (PID=$LOCK_PID, age=${LOCK_AGE}s)"
      exit 0
    fi
  fi
fi

# Circuit breaker: check recent restart count
if [ -f "$STATE_FILE" ]; then
  RECENT_RESTARTS=$(python3 -c "
import json, time
try:
    state = json.load(open('$STATE_FILE'))
    cutoff = time.time() - 1800  # 30 minutes
    recent = [r for r in state.get('restarts', []) if r['ts'] > cutoff]
    print(len(recent))
except:
    print(0)
" 2>/dev/null || echo 0)

  if [ "$RECENT_RESTARTS" -ge 3 ]; then
    log "CRITICAL: Circuit breaker tripped — $RECENT_RESTARTS restarts in 30min, NOT restarting"
    # Send critical alert if we have bot token
    if [ -f "$BOT_TOKEN_FILE" ]; then
      TOKEN=$(cat "$BOT_TOKEN_FILE" | head -1)
      CHAT_ID=$(cat "$BOT_TOKEN_FILE" | sed -n '2p')
      if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
        MSG="CRITICAL: NanoClaw crash-looping. $RECENT_RESTARTS restarts in 30min. Manual intervention required."
        curl -sf --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
          -d "chat_id=${CHAT_ID}" -d "text=${MSG}" >/dev/null 2>&1 || true
      fi
    fi
    exit 1
  fi
fi

# Capture pre-restart diagnostics
log "Capturing diagnostics before restart..."
{
  echo "=== Last 50 log lines ==="
  tail -50 "${NANOCLAW_DIR}/logs/nanoclaw.log" 2>/dev/null || echo "(no log file)"
  echo ""
  echo "=== NanoClaw ports ==="
  lsof -i :3001 -i :3002 -i :8181 -i :8200 2>/dev/null || echo "(none)"
  echo ""
  echo "=== Process list ==="
  ps aux | grep -E "nanoclaw|bun.*index" | grep -v grep || echo "(no processes)"
} >> "$LOG_FILE" 2>&1

# Restart NanoClaw
log "Restarting NanoClaw via launchctl..."
UID_NUM=$(id -u)
launchctl kickstart -k "gui/${UID_NUM}/com.nanoclaw" 2>&1 | tee -a "$LOG_FILE" || true

# Record restart in state file
python3 -c "
import json, time, os
state_file = '$STATE_FILE'
try:
    state = json.load(open(state_file))
except:
    state = {'restarts': []}
state['restarts'].append({'ts': time.time()})
# Keep only last 30 min
cutoff = time.time() - 1800
state['restarts'] = [r for r in state['restarts'] if r['ts'] > cutoff]
tmp = state_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(state, f)
os.rename(tmp, state_file)
" 2>/dev/null || log "WARNING: Failed to update state file"

# Send Telegram alert
if [ -f "$BOT_TOKEN_FILE" ]; then
  TOKEN=$(cat "$BOT_TOKEN_FILE" | head -1)
  CHAT_ID=$(cat "$BOT_TOKEN_FILE" | sed -n '2p')
  if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
    DIAG=$(tail -20 "$LOG_FILE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null | tr -d '"' || echo "diagnostics unavailable")
    MSG="NanoClaw restarted by heartbeat watchdog. Last diagnostics: ${DIAG:0:500}"
    curl -sf --max-time 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" -d "text=${MSG}" >/dev/null 2>&1 || true
  fi
fi

log "Restart complete"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/watchdog-heartbeat.sh
```

- [ ] **Step 3: Create launchd/com.nanoclaw.watchdog.plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.watchdog</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/timeout</string>
        <string>60</string>
        <string>{{PROJECT_ROOT}}/scripts/watchdog-heartbeat.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/watchdog-heartbeat.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/watchdog-heartbeat.error.log</string>
</dict>
</plist>
```

Note: `{{PROJECT_ROOT}}` and `{{HOME}}` are template placeholders — the user fills these in during setup (same pattern as the existing `com.nanoclaw.plist`).

- [ ] **Step 4: Test heartbeat script against running health endpoint**

First verify NanoClaw has the health endpoint (after Task 5 is deployed). For now, test the failure path:

```bash
NANOCLAW_HEALTH_PORT=19999 scripts/watchdog-heartbeat.sh
```

Expected: Health check fails, but since no launchd service is running in this context, it will log the diagnostics and attempt restart. Check `logs/watchdog-heartbeat.log` for the diagnostic capture.

- [ ] **Step 5: Commit**

```bash
git add scripts/watchdog-heartbeat.sh launchd/com.nanoclaw.watchdog.plist
git commit -m "feat(watchdog): add external heartbeat script and launchd plist"
```

---

## Task 7: Setup Bot Token File for Heartbeat

**Files:**
- Modify: `scripts/watchdog-heartbeat.sh` (already handles missing file gracefully)

This is a manual setup step, not code. Document it.

- [ ] **Step 1: Create the bot token config file**

```bash
mkdir -p ~/.config/nanoclaw
```

Write two lines to `~/.config/nanoclaw/watchdog-bot-token`:
- Line 1: Telegram bot token (same as TELEGRAM_BOT_TOKEN in .env)
- Line 2: CODE-claw chat ID

To find the chat ID:
```bash
sqlite3 store/messages.db "SELECT chat_jid FROM chats WHERE group_folder = 'telegram_code-claw' LIMIT 1"
```

```bash
# Extract bot token from .env
BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)
CHAT_ID=$(sqlite3 store/messages.db "SELECT chat_jid FROM chats WHERE group_folder = 'telegram_code-claw' LIMIT 1")
printf '%s\n%s\n' "$BOT_TOKEN" "$CHAT_ID" > ~/.config/nanoclaw/watchdog-bot-token
chmod 600 ~/.config/nanoclaw/watchdog-bot-token
```

- [ ] **Step 2: Verify the file**

```bash
wc -l ~/.config/nanoclaw/watchdog-bot-token
```
Expected: `2 /Users/mgandal/.config/nanoclaw/watchdog-bot-token`

- [ ] **Step 3: No commit needed (config file, not code)**

---

## Task 8: Integration Test

**Files:**
- Modify: `src/health-monitor.test.ts`

- [ ] **Step 1: Write integration test for full fix cycle**

Add to `src/health-monitor.test.ts`:

```typescript
describe('HealthMonitor fix integration', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);
  let mockActions: FixActions;

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
    mockActions = {
      execScript: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
      httpCheck: vi.fn().mockResolvedValue({ reachable: true, statusCode: 200 }),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    monitor.setFixActions(mockActions);
  });

  it('full cycle: detect → fix → verify → clear', async () => {
    // Register handler
    monitor.addFixHandler({
      id: 'mcp-test',
      service: 'mcp:Test',
      fixScript: '/test/fix.sh',
      verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
      cooldownMs: 0,
      maxAttempts: 2,
    });

    // Simulate 3 consecutive failures
    monitor.recordInfraEvent('mcp:Test', 'unreachable');
    monitor.recordInfraEvent('mcp:Test', 'unreachable');
    monitor.recordInfraEvent('mcp:Test', 'unreachable');

    // Threshold reached
    expect(monitor.getInfraFailureCount('mcp:Test')).toBe(3);

    // Auto-fix
    const result = await monitor.attemptFix('mcp:Test');
    expect(result).toBe('fixed');

    // Infra event should be cleared
    expect(monitor.getInfraFailureCount('mcp:Test')).toBe(0);

    // No infra alerts should show
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(0);
  });

  it('full cycle: detect → fail fix x2 → escalate', async () => {
    (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: false });

    monitor.addFixHandler({
      id: 'mcp-fail',
      service: 'mcp:Fail',
      fixScript: '/test/fail.sh',
      verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
      cooldownMs: 0,
      maxAttempts: 2,
    });

    // Simulate failures
    for (let i = 0; i < 3; i++) {
      monitor.recordInfraEvent('mcp:Fail', 'unreachable');
    }

    // First fix attempt — verify fails
    const r1 = await monitor.attemptFix('mcp:Fail');
    expect(r1).toBe('verify-failed');

    // Second fix attempt — escalates
    const r2 = await monitor.attemptFix('mcp:Fail');
    expect(r2).toBe('escalated');

    // Alert was sent
    const escalationCalls = (alertFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: [HealthAlert]) => c[0].type === 'fix_escalation',
    );
    expect(escalationCalls).toHaveLength(1);
    expect(escalationCalls[0][0].group).toBe('mcp:Fail');
  });

  it('verify with command type', async () => {
    (mockActions.execScript as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })   // fix script
      .mockResolvedValueOnce({ ok: true, stdout: '1', stderr: '' }); // verify command

    monitor.addFixHandler({
      id: 'cmd-verify',
      service: 'test:cmd',
      fixScript: '/test/fix.sh',
      verify: { type: 'command', cmd: '/bin/echo', args: ['ok'] },
      cooldownMs: 0,
      maxAttempts: 2,
    });

    const result = await monitor.attemptFix('test:cmd');
    expect(result).toBe('fixed');
    expect(mockActions.execScript).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `bun test src/health-monitor.test.ts -t "fix integration"`
Expected: ALL PASS (3 tests)

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/health-monitor.test.ts
git commit -m "test(watchdog): add integration tests for full fix cycle"
```

---

## Task 9: Build, Verify, and Final Commit

**Files:** All modified files

- [ ] **Step 1: Full build**

Run: `bun run build`
Expected: No errors

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Verify fix scripts exist and are executable**

```bash
ls -la scripts/fixes/
```
Expected: 7 scripts, all with execute permission

- [ ] **Step 4: Verify dry-run mode works**

```bash
for script in scripts/fixes/*.sh; do
  echo "--- $script ---"
  "$script" --dry-run 2>&1 || echo "(needs args)"
done
```

- [ ] **Step 5: Test health endpoint manually (if NanoClaw is running)**

```bash
curl -s http://127.0.0.1:3002/health
```
Expected: `{"uptime":...,"startupComplete":true}`

- [ ] **Step 6: Verify heartbeat script handles healthy endpoint**

```bash
NANOCLAW_HEALTH_PORT=3002 scripts/watchdog-heartbeat.sh && echo "OK: heartbeat passed"
```
Expected: exits 0 silently (healthy)

- [ ] **Step 7: Final commit if any uncommitted changes**

```bash
git status
# If clean, skip. If changes, commit:
git add -A
git commit -m "chore(watchdog): final verification and cleanup"
```
