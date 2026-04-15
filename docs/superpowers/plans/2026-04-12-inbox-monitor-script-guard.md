# Inbox Monitor Script Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-side pre-check mechanism to the task scheduler so scheduled tasks with a `script` field run that script first and skip the agent container if the script exits non-zero. Apply it to the inbox monitor to avoid ~90% of unnecessary agent invocations on quiet days.

**Architecture:** The scheduler's `runTask()` gains a pre-check step: if `task.script` is set, `execFile()` it with a short timeout. Exit 0 → proceed; non-zero → log "skipped (guard)" and advance `next_run` without spawning a container. The inbox monitor's guard script uses the existing Gmail API credentials (same chain as `email_ingest/gmail_adapter.py`) to check for unread messages at `to:mgandal+cc@gmail.com`.

**Tech Stack:** TypeScript (task-scheduler.ts), Python 3 (guard script), Gmail API v1, existing OAuth token chain (`~/.cache/email-ingest/gmail-token.json`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/guards/inbox-has-unread.py` | Create | Gmail unread-check: exit 0 if unread mail exists, exit 1 if inbox is empty |
| `src/task-scheduler.ts` | Modify | Add `runGuardScript()` and call it in `runTask()` before spawning container |
| `tests/task-scheduler-guard.test.ts` | Create | Tests for guard logic: script passes, script fails, script times out, no script |
| `docs/inbox-monitor-task-prompt.md` | No change | Already correct — `mgandal+cc@gmail.com` is the intended target |

---

### Task 1: Guard Script — Gmail Unread Check

**Files:**
- Create: `scripts/guards/inbox-has-unread.py`

- [ ] **Step 1: Write the guard script**

```python
#!/usr/bin/env python3
"""Guard script for inbox-monitor task.

Exit 0 if there are unread emails at mgandal+cc@gmail.com.
Exit 1 if the inbox is empty (no agent needed).
Exit 2 on error (treat as "run the agent" to be safe).

Uses the same credential chain as email_ingest/gmail_adapter.py.
"""

import json
import sys
from pathlib import Path

QUERY = "to:mgandal+cc@gmail.com is:unread"
TOKEN_FILE = Path.home() / ".cache" / "email-ingest" / "gmail-token.json"
CRED_PATHS = [
    Path.home() / ".google_workspace_mcp" / "credentials" / "mgandal@gmail.com.json",
    Path.home() / ".gmail-mcp" / "credentials.json",
]
OAUTH_KEYS = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"


def load_credentials():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    if TOKEN_FILE.exists():
        data = json.loads(TOKEN_FILE.read_text())
        creds = Credentials(
            token=data.get("token"),
            refresh_token=data.get("refresh_token"),
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=data.get("client_id"),
            client_secret=data.get("client_secret"),
            scopes=data.get("scopes", []),
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_FILE.write_text(json.dumps({
                "token": creds.token,
                "refresh_token": creds.refresh_token,
                "token_uri": creds.token_uri,
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "scopes": list(creds.scopes or []),
            }))
        return creds

    for cred_path in CRED_PATHS:
        if not cred_path.exists():
            continue
        data = json.loads(cred_path.read_text())
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")
        if not client_id and OAUTH_KEYS.exists():
            oauth = json.loads(OAUTH_KEYS.read_text())
            installed = oauth.get("installed", {})
            client_id = installed.get("client_id")
            client_secret = installed.get("client_secret")
        creds = Credentials(
            token=data.get("token") or data.get("access_token"),
            refresh_token=data.get("refresh_token"),
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
        return creds

    return None


def main():
    try:
        creds = load_credentials()
        if not creds:
            print("No Gmail credentials found — running agent as fallback")
            sys.exit(0)

        from googleapiclient.discovery import build
        service = build("gmail", "v1", credentials=creds)
        result = service.users().messages().list(
            userId="me", q=QUERY, maxResults=1
        ).execute()

        count = result.get("resultSizeEstimate", 0)
        if count > 0:
            print(f"Found {count} unread message(s) — agent should run")
            sys.exit(0)
        else:
            print("No unread messages — skipping agent")
            sys.exit(1)

    except Exception as e:
        print(f"Guard error: {e} — running agent as fallback")
        sys.exit(0)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make it executable and test manually**

Run:
```bash
chmod +x scripts/guards/inbox-has-unread.py
python3 scripts/guards/inbox-has-unread.py; echo "exit: $?"
```
Expected: Either "Found N unread message(s)" with exit 0, or "No unread messages" with exit 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/guards/inbox-has-unread.py
git commit -m "feat: add Gmail unread guard script for inbox monitor"
```

---

### Task 2: Scheduler Pre-Check — Guard Script Support

**Files:**
- Modify: `src/task-scheduler.ts:111-291` (the `runTask` function)
- Create: `tests/task-scheduler-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/task-scheduler-guard.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { runGuardScript } from '../src/task-scheduler.js';

describe('runGuardScript', () => {
  it('returns true when script exits 0', async () => {
    const result = await runGuardScript('echo "ok" && exit 0', 5000);
    expect(result.shouldRun).toBe(true);
  });

  it('returns false when script exits 1', async () => {
    const result = await runGuardScript('exit 1', 5000);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toContain('exit code 1');
  });

  it('returns true (fail-open) when script times out', async () => {
    const result = await runGuardScript('sleep 10', 500);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toContain('timed out');
  });

  it('returns true (fail-open) when script errors', async () => {
    const result = await runGuardScript('/nonexistent/script', 5000);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toContain('error');
  });

  it('returns true when script is null/undefined', async () => {
    const result = await runGuardScript(null, 5000);
    expect(result.shouldRun).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/task-scheduler-guard.test.ts`
Expected: FAIL — `runGuardScript` not exported from task-scheduler

- [ ] **Step 3: Implement `runGuardScript` in task-scheduler.ts**

Add this function above `runTask()` in `src/task-scheduler.ts`:

```typescript
import { execFile } from 'child_process';

const GUARD_TIMEOUT_MS = 15_000; // 15 seconds max for guard scripts

export interface GuardResult {
  shouldRun: boolean;
  reason?: string;
}

/**
 * Run a guard script before spawning the agent container.
 * Exit 0 → run agent. Non-zero → skip agent. Errors/timeouts → run agent (fail-open).
 */
export function runGuardScript(
  script: string | null | undefined,
  timeoutMs: number = GUARD_TIMEOUT_MS,
): Promise<GuardResult> {
  if (!script) return Promise.resolve({ shouldRun: true });

  return new Promise((resolve) => {
    const proc = execFile(
      '/bin/bash',
      ['-c', script],
      { timeout: timeoutMs, env: { ...process.env, PATH: process.env.PATH } },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            // Timed out — fail open
            resolve({ shouldRun: true, reason: `Guard timed out after ${timeoutMs}ms` });
          } else if (error.code === 'ENOENT' || error.code === 'EACCES') {
            resolve({ shouldRun: true, reason: `Guard script error: ${error.message}` });
          } else {
            // Non-zero exit — skip agent
            const code = error.code ?? 'unknown';
            const output = (stdout || stderr || '').trim();
            resolve({ shouldRun: false, reason: `Guard exit code ${code}: ${output}` });
          }
        } else {
          // Exit 0
          resolve({ shouldRun: true });
        }
      },
    );
  });
}
```

- [ ] **Step 4: Wire guard into `runTask()`**

In `runTask()`, add the guard check right after the group-folder resolution and before the container spawn (after line 165, before the "Update tasks snapshot" block):

```typescript
  // --- Guard script pre-check ---
  if (task.script) {
    const guard = await runGuardScript(task.script);
    if (!guard.shouldRun) {
      logger.info(
        { taskId: task.id, reason: guard.reason },
        'Task skipped by guard script',
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'skipped',
        result: guard.reason || 'Guard returned non-zero',
        error: null,
      });
      // Advance next_run so the task fires again at the next scheduled time
      const nextRun = computeNextRun(task);
      updateTaskAfterRun(task.id, nextRun, `Skipped: ${guard.reason}`);
      return;
    }
  }
```

- [ ] **Step 5: Update `logTaskRun` to accept 'skipped' status**

Check `src/db.ts` for the `logTaskRun` function signature — the `status` field likely allows any string. If it's typed to only `'success' | 'error'`, widen it to include `'skipped'`.

In `src/db.ts`, find the `logTaskRun` function and ensure `status` accepts `'skipped'`:

```typescript
// In the logTaskRun params type:
status: 'success' | 'error' | 'skipped';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/task-scheduler-guard.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/task-scheduler.ts tests/task-scheduler-guard.test.ts src/db.ts
git commit -m "feat: add guard script pre-check to task scheduler

Scheduled tasks with a 'script' field now run it before spawning
a container. Exit 0 = run agent, non-zero = skip. Errors and
timeouts fail-open (run the agent). Skipped runs are logged as
'skipped' in task_run_logs."
```

---

### Task 3: Wire Up the Inbox Monitor

**Files:**
- No file changes — database update only

- [ ] **Step 1: Update the scheduled task to set its guard script**

Run:
```bash
sqlite3 store/messages.db "UPDATE scheduled_tasks SET script = 'python3 /Users/mgandal/Agents/nanoclaw/scripts/guards/inbox-has-unread.py' WHERE id = 'nanoclaw-inbox-monitor';"
```

- [ ] **Step 2: Verify the update**

Run:
```bash
sqlite3 store/messages.db "SELECT id, script, status, next_run FROM scheduled_tasks WHERE id = 'nanoclaw-inbox-monitor';"
```
Expected: Shows the script path, status=active, next_run for Monday 9 AM.

- [ ] **Step 3: Test the full flow manually**

Restart NanoClaw so the updated task is picked up:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Then check logs for the next scheduled run to confirm the guard fires:
```bash
tail -f logs/nanoclaw.log | grep -E 'guard|inbox-monitor|skipped'
```

---

### Task 4: Build and Verify

- [ ] **Step 1: Build TypeScript**

Run: `cd /Users/mgandal/Agents/nanoclaw && bun run build`
Expected: Clean compilation, no errors.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All existing tests pass + new guard tests pass.

- [ ] **Step 3: Commit any build artifacts if needed**

Only if the build step produced changes to tracked files.
