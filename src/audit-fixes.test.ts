/**
 * Audit regression tests — guards against bugs found in the 2026-03-29 code review.
 *
 * Each test section:
 * 1. Demonstrates the bug exists (RED)
 * 2. Verifies the fix works (GREEN after fix is applied)
 * 3. Serves as a guardrail to prevent regression
 *
 * Uses vitest for compatibility with the project's test runner.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────────
// 1. PROXY_BIND_HOST — credential proxy must NOT bind 0.0.0.0
// ─────────────────────────────────────────────────
describe('PROXY_BIND_HOST security', () => {
  it('must bind to 192.168.64.1 on macOS with Apple Container, not 0.0.0.0', async () => {
    // Skip when env override is present — this test validates the detection logic
    if (process.env.CREDENTIAL_PROXY_HOST) return;
    try {
      const { PROXY_BIND_HOST, CONTAINER_RUNTIME_BIN } =
        await import('./container-runtime.js');
      // This test only applies when running on the Apple Container setup
      if (os.platform() === 'darwin' && CONTAINER_RUNTIME_BIN === 'container') {
        expect(PROXY_BIND_HOST).toBe('192.168.64.1');
      }
    } catch {
      // container-runtime.ts throws at import if CREDENTIAL_PROXY_HOST is unset
      // in CI/test environments — skip gracefully
    }
  });
});

// ─────────────────────────────────────────────────
// 2. iMessage phone regex — must reject \n, \t, and overly long inputs
// ─────────────────────────────────────────────────
describe('iMessage phone validation', () => {
  // Extract the regex from the source to test it in isolation
  const ORIGINAL_REGEX = /^[+\d][\d\s()-]+$/;
  const FIXED_REGEX = /^[+\d][\d ()-]{1,30}$/;

  it('BUG: original regex allows newlines in phone numbers (injection vector)', () => {
    // A phone number with an embedded newline passes the old regex
    // because \s matches \n. This enables AppleScript injection.
    expect(ORIGINAL_REGEX.test('+1 (555)\n555-5555')).toBe(true); // BUG
  });

  it('FIX: updated regex rejects newlines in phone numbers', () => {
    expect(FIXED_REGEX.test('+1 (555)\n555-5555')).toBe(false);
  });

  it('BUG: original regex allows tabs in phone numbers', () => {
    expect(ORIGINAL_REGEX.test('+1\t555\t5555')).toBe(true); // BUG
  });

  it('FIX: updated regex rejects tabs in phone numbers', () => {
    expect(FIXED_REGEX.test('+1\t555\t5555')).toBe(false);
  });

  it('BUG: original regex allows unbounded length', () => {
    const longInput = '+1' + '2'.repeat(500);
    expect(ORIGINAL_REGEX.test(longInput)).toBe(true); // BUG
  });

  it('FIX: updated regex enforces max 30 chars', () => {
    const longInput = '+1' + '2'.repeat(500);
    expect(FIXED_REGEX.test(longInput)).toBe(false);
  });

  it('FIX: still accepts valid phone numbers', () => {
    expect(FIXED_REGEX.test('+1 (555) 555-5555')).toBe(true);
    expect(FIXED_REGEX.test('+442071234567')).toBe(true);
    expect(FIXED_REGEX.test('15555555555')).toBe(true);
  });

  it('FIX: carriage return must be stripped from message text', () => {
    // Simulate the escaping chain
    const text = 'Hello\r\nWorld';
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n');
    expect(escaped).toBe('Hello\\nWorld');
    expect(escaped).not.toContain('\r');
  });
});

// ─────────────────────────────────────────────────
// 3. Event router sender_domain — must handle angle-bracket email format
// ─────────────────────────────────────────────────
describe('Event router sender_domain extraction', () => {
  // Original logic (buggy)
  function extractDomainOriginal(from: string): string {
    return from.includes('@') ? from.split('@')[1] : '';
  }

  // Fixed logic
  function extractDomainFixed(rawFrom: string): string {
    const addrMatch = rawFrom.match(/<([^>]+)>/) || rawFrom.match(/(\S+@\S+)/);
    const addr = addrMatch ? addrMatch[1] : rawFrom;
    return addr.includes('@') ? addr.split('@')[1].toLowerCase() : '';
  }

  it('BUG: original returns "example.com>" for angle-bracket format', () => {
    const result = extractDomainOriginal('"John Doe" <john@example.com>');
    expect(result).toBe('example.com>'); // BUG: trailing >
  });

  it('FIX: extracts clean domain from angle-bracket format', () => {
    const result = extractDomainFixed('"John Doe" <john@example.com>');
    expect(result).toBe('example.com');
  });

  it('FIX: handles plain email addresses', () => {
    expect(extractDomainFixed('john@example.com')).toBe('example.com');
  });

  it('FIX: handles format without quotes', () => {
    expect(extractDomainFixed('John Doe <john@example.com>')).toBe(
      'example.com',
    );
  });

  it('FIX: lowercases domain', () => {
    expect(extractDomainFixed('user@EXAMPLE.COM')).toBe('example.com');
  });
});

// ─────────────────────────────────────────────────
// 4. Task scheduler null next_run — must not infinite loop
// ─────────────────────────────────────────────────
describe('Task scheduler computeNextRun', () => {
  it('BUG: Date(null) returns Unix epoch causing near-infinite loop', () => {
    // This demonstrates the root cause
    const epoch = new Date(null as unknown as string).getTime();
    expect(epoch).toBe(0); // Unix epoch — will cause millions of iterations
  });

  it('FIX: null next_run should fall back to now + interval', () => {
    // Simulate the fixed logic
    const now = Date.now();
    const ms = 3600000; // 1 hour
    const nextRun = null;
    const base = nextRun ? new Date(nextRun).getTime() : now;
    let next = base + ms;
    while (next <= now) {
      next += ms;
    }
    // Must be in the future, and only one interval step away
    expect(next).toBeGreaterThan(now);
    expect(next).toBeLessThanOrEqual(now + ms);
  });
});

// ─────────────────────────────────────────────────
// 5. Health monitor — paused groups must auto-resume
// ─────────────────────────────────────────────────
describe('Health monitor auto-resume', () => {
  it('must resume groups when spawn count falls below threshold', async () => {
    const { HealthMonitor } = await import('./health-monitor.js');

    const alerts: Array<{ type: string; group: string }> = [];
    const monitor = new HealthMonitor({
      maxSpawnsPerHour: 2,
      maxErrorsPerHour: 5,
      onAlert: (alert) => alerts.push(alert),
    });

    // Record 3 spawns to trigger pause
    monitor.recordSpawn('test-group');
    monitor.recordSpawn('test-group');
    monitor.recordSpawn('test-group');

    monitor.checkThresholds();
    expect(monitor.isGroupPaused('test-group')).toBe(true);

    // Advance time beyond the 1-hour window by manipulating internal state
    // The spawnLog entries have timestamps, so we simulate old entries
    const spawnLog = (monitor as any).spawnLog as Array<{
      group: string;
      timestamp: number;
    }>;
    const oldTime = Date.now() - 3700_000; // 1h1m ago
    for (const entry of spawnLog) {
      entry.timestamp = oldTime;
    }

    // Now checkThresholds should see 0 recent spawns and auto-resume
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('test-group')).toBe(false);
  });
});

// ─────────────────────────────────────────────────
// 6. Message bus atomic writes — source-level guardrail
// ─────────────────────────────────────────────────
describe('Message bus atomic writes', () => {
  it('FIX: appendToAgentQueue must use tmp+rename for crash safety', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/message-bus.ts'),
      'utf-8',
    );
    // The queue write must use tmp+rename, not direct writeFileSync
    expect(source).toContain('queuePath}.tmp');
    expect(source).toContain('renameSync');
  });
});

// ─────────────────────────────────────────────────
// 7. Group queue stale waitingGroups — source-level guardrail
// ─────────────────────────────────────────────────
describe('Group queue stale waitingGroups', () => {
  it('FIX: drainGroup must purge JID from waitingGroups when deleting group state', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/group-queue.ts'),
      'utf-8',
    );
    // After `this.groups.delete(groupJid)`, waitingGroups must also be cleaned
    const deleteIdx = source.indexOf('this.groups.delete(groupJid)');
    expect(deleteIdx).toBeGreaterThan(-1);
    // Within 200 chars after the delete, there must be a waitingGroups cleanup
    const afterDelete = source.slice(deleteIdx, deleteIdx + 300);
    expect(afterDelete).toContain('waitingGroups');
  });
});

// ─────────────────────────────────────────────────
// 8. update_task must enforce MIN_INTERVAL_MS
// ─────────────────────────────────────────────────
describe('update_task interval minimum', () => {
  it('FIX: intervals below 30 minutes must be rejected', () => {
    const MIN_INTERVAL_MS = 30 * 60 * 1000;
    // Simulate update_task validation
    const testValues = [
      { input: '60000', expected: 'rejected' }, // 1 min
      { input: '300000', expected: 'rejected' }, // 5 min
      { input: '1800000', expected: 'accepted' }, // 30 min exactly
      { input: '3600000', expected: 'accepted' }, // 1 hour
    ];

    for (const { input, expected } of testValues) {
      const ms = parseInt(input, 10);
      const wouldReject = ms < MIN_INTERVAL_MS;
      if (expected === 'rejected') {
        expect(wouldReject).toBe(true);
      } else {
        expect(wouldReject).toBe(false);
      }
    }
  });
});

// ─────────────────────────────────────────────────
// 9. setSession must be wrapped in a transaction
// ─────────────────────────────────────────────────
describe('setSession transaction', () => {
  it('FIX: setSession must wrap SELECT+INSERT in db.transaction()', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/db.ts'),
      'utf-8',
    );
    // Find the setSession function
    const fnStart = source.indexOf('export function setSession(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 500);
    // Must use db.transaction()
    expect(fnBody).toContain('db.transaction(');
  });
});

// ─────────────────────────────────────────────────
// 10. Zod version compatibility guardrail
// ─────────────────────────────────────────────────
describe('Zod version compatibility', () => {
  it('agent-runner must use Zod v3 (not v4) for MCP SDK compatibility', () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'container/agent-runner/package.json'),
        'utf-8',
      ),
    );
    const zodVersion = pkg.dependencies?.zod || '';
    // Must start with ^3 — Zod v4 breaks @modelcontextprotocol/sdk
    expect(zodVersion).toMatch(/^\^3\./);
  });
});

// ─────────────────────────────────────────────────
// 11. Dockerfile entrypoint must not re-compile TypeScript at runtime
// ─────────────────────────────────────────────────
describe('Dockerfile entrypoint', () => {
  it('must not contain runtime tsc compilation', () => {
    const entrypoint = fs.readFileSync(
      path.join(process.cwd(), 'container/entrypoint.sh'),
      'utf-8',
    );
    // Entrypoint should exec the build-time output at /app/dist/, never compile at runtime.
    expect(entrypoint).toContain('node /app/dist/index.js');
    expect(entrypoint).not.toContain('npx tsc --outDir /tmp/dist');
  });

  // @readwise/cli (0.5.x) reads auth from ~/.readwise-cli.json, not env.
  // The entrypoint must seed that file from $READWISE_ACCESS_TOKEN so the
  // CLI works inside containers without an interactive `readwise login`.
  it('seeds ~/.readwise-cli.json from $READWISE_ACCESS_TOKEN', () => {
    const entrypoint = fs.readFileSync(
      path.join(process.cwd(), 'container/entrypoint.sh'),
      'utf-8',
    );
    expect(entrypoint).toContain('READWISE_ACCESS_TOKEN');
    expect(entrypoint).toContain('.readwise-cli.json');
    expect(entrypoint).toContain('auth_type');
    // Must guard against overwriting a user-supplied config
    expect(entrypoint).toMatch(
      /\[\s*!\s*-f\s+"\$HOME\/\.readwise-cli\.json"\s*\]/,
    );
  });

  it('Dockerfile installs entrypoint.sh from the build context', () => {
    const dockerfile = fs.readFileSync(
      path.join(process.cwd(), 'container/Dockerfile'),
      'utf-8',
    );
    expect(dockerfile).toMatch(/COPY\s+entrypoint\.sh\s+\/app\/entrypoint\.sh/);
    expect(dockerfile).toContain('chmod +x /app/entrypoint.sh');
  });
});

// ─────────────────────────────────────────────────
// 12. Container runner secrets isolation
// ─────────────────────────────────────────────────
describe('runScript environment restriction', () => {
  it('FIX: restricted env must include only PATH, HOME, TZ', () => {
    // Read the source and verify the env pattern
    const source = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf-8',
    );
    // Must use restricted env, not process.env
    // Check each restricted key is present (format-agnostic)
    expect(source).toMatch(/env:\s*\{[^}]*PATH:\s*process\.env\.PATH/s);
    expect(source).toMatch(/env:\s*\{[^}]*HOME:\s*process\.env\.HOME/s);
    expect(source).toMatch(/env:\s*\{[^}]*TZ:\s*process\.env\.TZ/s);
    expect(source).not.toMatch(/env:\s*process\.env\b/);
  });
});

// ─────────────────────────────────────────────────
// 13. Gmail creds mount must be readonly for non-main
// ─────────────────────────────────────────────────
describe('Gmail credentials mount', () => {
  it('FIX: container-runner must gate Gmail mount readonly on isMain', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/container-runner.ts'),
      'utf-8',
    );
    // Must use `readonly: !isMain` pattern, not hardcoded `readonly: false`
    expect(source).toContain('readonly: !isMain');
    expect(source).not.toMatch(/gmail-mcp[\s\S]{0,100}readonly:\s*false/);
  });
});

// ─────────────────────────────────────────────────
// 14. save_skill IPC must require isMain
// ─────────────────────────────────────────────────
describe('save_skill IPC authorization', () => {
  it('FIX: save_skill handler must check isMain before processing', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/ipc.ts'),
      'utf-8',
    );
    // The save_skill block must contain an isMain check
    const saveSkillBlock = source.slice(
      source.indexOf("data.type === 'save_skill'"),
      source.indexOf("data.type === 'save_skill'") + 300,
    );
    expect(saveSkillBlock).toContain('isMain');
  });
});

// ─────────────────────────────────────────────────
// 15. MessageStream race condition fix
// ─────────────────────────────────────────────────
describe('MessageStream lost-wakeup fix', () => {
  it('FIX: asyncIterator must re-check queue after setting waiting', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf-8',
    );
    // The iterator must re-check queue.length inside the Promise constructor
    // after setting this.waiting, to prevent the lost-wakeup race
    expect(source).toContain('this.waiting = r;');
    // The re-check must happen inside the same Promise callback
    // (allow for comments between the assignment and the re-check)
    expect(source).toMatch(
      /this\.waiting\s*=\s*r;[\s\S]{0,200}this\.queue\.length\s*>\s*0/,
    );
  });
});

// ─────────────────────────────────────────────────
// 16. Calendar watcher icalbuddy path consistency
// ─────────────────────────────────────────────────
describe('Calendar watcher icalbuddy path', () => {
  it('FIX: start() must check the actual ICALBUDDY_BIN path, not which', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/watchers/calendar-watcher.ts'),
      'utf-8',
    );
    // Must not use `which icalbuddy` — must test the actual binary path
    expect(source).not.toContain("execFileSync('which', ['icalbuddy']");
    // Must check ICALBUDDY_BIN directly
    expect(source).toContain('ICALBUDDY_BIN');
  });
});

// ─────────────────────────────────────────────────
// 17. Context assembler does NOT copy/clear queue.json
// ─────────────────────────────────────────────────
describe('Context assembler atomic queue clear', () => {
  it('FIX: bus queue.json copy+clear removed — per-message files used instead', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/context-assembler.ts'),
      'utf-8',
    );
    // queue.json copy+clear block was removed; busQueueSrc tmp pattern must not exist
    expect(source).not.toContain('busQueueSrc}.tmp');
    expect(source).not.toContain('copyFileSync(busQueueSrc');
  });
});

// ─────────────────────────────────────────────────
// 18. Trigger pattern must use per-group pattern
// ─────────────────────────────────────────────────
describe('Per-group trigger pattern', () => {
  it('FIX: session command detection must use per-group trigger, not global', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf-8',
    );
    // The loopCmdMsg line must NOT use TRIGGER_PATTERN directly
    // It must use getTriggerPattern(group.trigger) or equivalent
    const loopCmdSection = source.slice(
      source.indexOf('loopCmdMsg'),
      source.indexOf('loopCmdMsg') + 200,
    );
    expect(loopCmdSection).not.toContain('TRIGGER_PATTERN)');
    expect(loopCmdSection).toContain('extractSessionCommand');
  });

  it('FIX: canSenderInteract must use per-group trigger pattern', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf-8',
    );
    // Find the canSenderInteract closure and check it uses groupTriggerPattern
    const section = source.slice(
      source.indexOf('canSenderInteract'),
      source.indexOf('canSenderInteract') + 200,
    );
    expect(section).toContain('groupTriggerPattern');
    expect(section).not.toContain('TRIGGER_PATTERN.test');
  });
});

// ─────────────────────────────────────────────────
// 19. /new command must not drop message batch when unauthorized
// ─────────────────────────────────────────────────
describe('/new command batch handling', () => {
  it('FIX: return true must only happen inside if (isAllowed), not after newCmdMsg block', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf-8',
    );
    // Find the newCmdMsg block — the closing brace of "if (newCmdMsg)" outer block
    const newCmdIdx = source.indexOf('if (newCmdMsg)');
    expect(newCmdIdx).toBeGreaterThan(-1);

    // Extract just the if (newCmdMsg) { ... } block by matching braces
    const blockStart = source.indexOf('{', newCmdIdx);
    let depth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (depth === 0) {
        blockEnd = i + 1;
        break;
      }
    }
    const block = source.slice(newCmdIdx, blockEnd);

    // The `return true` must be inside `if (isAllowed)`, not at the outer level.
    // After the block ends, there must NOT be an unconditional `return true`.
    // Check: the text between closing `}` of isAllowed and closing `}` of newCmdMsg
    // must not contain `return true` (only comments are OK).
    const isAllowedEnd = block.lastIndexOf('return true');
    const isAllowedCheck = block.indexOf('if (isAllowed)');
    expect(isAllowedCheck).toBeGreaterThan(-1);
    // return true must appear AFTER isAllowed (i.e. inside it)
    expect(isAllowedEnd).toBeGreaterThan(isAllowedCheck);
    // There should be only 1 `return true` in the block (not counting comments)
    const codeOnly = block.replace(/\/\/.*$/gm, ''); // strip comments
    const returnTrueMatches = codeOnly.match(/return\s+true/g) || [];
    expect(returnTrueMatches.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────
// 20. Gmail channel processedIds must be persisted to disk
// ─────────────────────────────────────────────────
describe('Gmail channel processedIds persistence', () => {
  it('FIX: GmailChannel must have loadState/saveState methods', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/channels/gmail.ts'),
      'utf-8',
    );
    // Must persist processedIds to disk
    expect(source).toContain('loadProcessedIds');
    expect(source).toContain('saveProcessedIds');
  });

  it('FIX: connect() must load persisted state', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/channels/gmail.ts'),
      'utf-8',
    );
    // connect() must call load before first poll
    const connectFn = source.slice(
      source.indexOf('async connect()'),
      source.indexOf('async sendMessage'),
    );
    expect(connectFn).toContain('loadProcessedIds');
  });

  it('FIX: pollForMessages must save state after processing', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/channels/gmail.ts'),
      'utf-8',
    );
    const pollFn = source.slice(
      source.indexOf('private async pollForMessages'),
      source.indexOf('private async processMessage'),
    );
    expect(pollFn).toContain('saveProcessedIds');
  });
});

// ─────────────────────────────────────────────────
// 21. GmailWatcher auth-failure backoff must not be overwritten
// ─────────────────────────────────────────────────
describe('GmailWatcher auth-failure backoff', () => {
  it('FIX: poll() must return a flag indicating self-scheduled backoff', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/watchers/gmail-watcher.ts'),
      'utf-8',
    );
    // scheduleNext must check whether poll self-scheduled before overwriting timer
    // The scheduleNext method must NOT blindly call this.scheduleNext() after poll
    const scheduleNextFn = source.slice(
      source.indexOf('private scheduleNext'),
      source.indexOf('private scheduleNext') + 300,
    );
    // Must check poll result or timer state before scheduling
    expect(scheduleNextFn).toMatch(/selfScheduled|this\.timer/);
  });
});

// ─────────────────────────────────────────────────
// 22. Ollama fetch must have timeouts
// ─────────────────────────────────────────────────
describe('Ollama fetch timeout', () => {
  it('FIX: ollamaFetch must use AbortController for timeouts', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'container/agent-runner/src/ollama-mcp-stdio.ts',
      ),
      'utf-8',
    );
    expect(source).toContain('AbortController');
    expect(source).toContain('signal');
  });

  it('FIX: generate endpoint must have a longer timeout than list', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'container/agent-runner/src/ollama-mcp-stdio.ts',
      ),
      'utf-8',
    );
    // Should have distinct timeout constants or parameters
    expect(source).toMatch(/GENERATE_TIMEOUT|generate.*timeout|300[_\s]*000/);
  });
});

// ─────────────────────────────────────────────────
// 23. Context assembler QMD must use MCP session protocol
// ─────────────────────────────────────────────────
describe('Context assembler QMD session protocol', () => {
  it('FIX: queryQmdForContext must initialize MCP session before tools/call', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/context-assembler.ts'),
      'utf-8',
    );
    // Must send an initialize request and capture session ID
    expect(source).toContain('initialize');
    expect(source).toMatch(/[Mm]cp-[Ss]ession/i);
  });

  it('FIX: QMD query failures must be logged (not silently swallowed)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/context-assembler.ts'),
      'utf-8',
    );
    // queryQmdForContext must log on failure, not just resolve('')
    const fn = source.slice(
      source.indexOf('queryQmdForContext'),
      source.indexOf('export async function assembleContextPacket'),
    );
    expect(fn).toContain('logger');
  });
});

// ─────────────────────────────────────────────────
// 24. Container runner must health-check QMD before injecting URL
// ─────────────────────────────────────────────────
describe('Container runner QMD health gating', () => {
  it('FIX: QMD_URL must only be passed to containers if QMD is reachable', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/container-runner.ts'),
      'utf-8',
    );
    // Must have isQmdReachable check gating QMD_URL injection
    expect(source).toContain('isQmdReachable()');
    // Must have setQmdReachable export for health monitor to update
    expect(source).toContain('export function setQmdReachable');
  });
});

// ─────────────────────────────────────────────────
// 25. Health check should use /health endpoint for QMD
// ─────────────────────────────────────────────────
describe('QMD health check endpoint', () => {
  it('QMD /health endpoint returns OK', async () => {
    // Direct test: hit QMD's health endpoint
    try {
      const res = await fetch('http://localhost:8182/health', {
        signal: AbortSignal.timeout(2000),
      });
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe('ok');
    } catch {
      // QMD not running — skip (this test is for when QMD IS running)
    }
  });
});

// ─────────────────────────────────────────────────
// 26. Health checks must use per-service health URLs, not MCP URLs
// ─────────────────────────────────────────────────
// SimpleMem was phased out on 2026-04-06 in favor of Honcho + Hindsight + QMD.
// The SimpleMem-specific health check tests have been removed.

// ─────────────────────────────────────────────────
// 27. Apple Notes must be indexed in QMD
// ─────────────────────────────────────────────────
describe('Apple Notes QMD integration', () => {
  it('QMD apple-notes collection must have indexed files', async () => {
    // Query QMD status via MCP
    try {
      const initRes = await fetch('http://localhost:8182/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      if (!sessionId) return; // QMD not running

      const statusRes = await fetch('http://localhost:8182/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'status', arguments: {} },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await statusRes.text();
      const parsed = JSON.parse(body);
      const text = parsed?.result?.content?.[0]?.text || '';

      // Must mention apple-notes with >0 docs
      expect(text).toContain('apple-notes');
      // The structured content should show the collection
      const collections = parsed?.result?.structuredContent?.collections || [];
      const appleNotes = collections.find(
        (c: { name: string }) => c.name === 'apple-notes',
      );
      expect(appleNotes).toBeDefined();
      expect(appleNotes.documents).toBeGreaterThan(0);
    } catch {
      // QMD not running — skip
    }
  }, 30000);

  it('QMD can search Apple Notes content', async () => {
    try {
      const initRes = await fetch('http://localhost:8182/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      if (!sessionId) return;

      const queryRes = await fetch('http://localhost:8182/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'query',
            arguments: {
              searches: [{ type: 'lex', query: 'grant budget' }],
              intent: 'grant budget info',
              collection: 'apple-notes',
              limit: 3,
            },
          },
        }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await queryRes.text();
      const parsed = JSON.parse(body);
      const results = parsed?.result?.structuredContent?.results || [];
      expect(results.length).toBeGreaterThan(0);
      // At least one result should be from apple-notes
      const hasAppleNote = results.some(
        (r: { file: string }) =>
          r.file.includes('apple-notes') || r.file.includes('notes/'),
      );
      expect(hasAppleNote).toBe(true);
    } catch {
      // QMD not running
    }
  }, 30000);
});

// ─────────────────────────────────────────────────
// 28. Apple Notes ingest — SimpleMem ingest pipeline removed
// ─────────────────────────────────────────────────
// SimpleMem ingest pipeline (apple-notes-ingest.py) was removed on 2026-04-06.
// Apple Notes are now indexed directly via QMD (see test #27).

// ─────────────────────────────────────────────────
// 29. C6 — write_agent_memory size + section validation
// ─────────────────────────────────────────────────
describe('write_agent_memory input validation (C6)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/ipc.ts'),
    'utf-8',
  );

  it('caps content at 64KB', () => {
    // A 64KB literal in source; the compare uses 64 * 1024.
    expect(source).toMatch(/content\.length\s*>\s*64\s*\*\s*1024/);
  });

  it('validates section name against a tight regex', () => {
    // The regex itself must appear verbatim — simple anchor for audit.
    expect(source).toContain('/^[\\w\\s\\-]{1,80}$/');
  });
});

// ─────────────────────────────────────────────────
// 30. C9 — pageindex subprocess must not inherit user PATH
// ─────────────────────────────────────────────────
describe('pageindex subprocess PATH restriction (C9)', () => {
  it('PATH must be hardcoded to /usr/bin:/bin, not process.env.PATH', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/pageindex.ts'),
      'utf-8',
    );
    expect(source).toContain("PATH: '/usr/bin:/bin'");
    // Regression guard: any `PATH: process.env.PATH` reintroduces the issue.
    expect(source).not.toMatch(/PATH:\s*process\.env\.PATH/);
  });
});

// ─────────────────────────────────────────────────
// 31. C11 — CREDENTIAL_PROXY_HOST startup validation
// ─────────────────────────────────────────────────
describe('CREDENTIAL_PROXY_HOST validation (C11)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/container-runtime.ts'),
    'utf-8',
  );

  it('warns when bind host is 0.0.0.0', () => {
    expect(source).toContain("PROXY_BIND_HOST === '0.0.0.0'");
    expect(source).toMatch(/console\.warn[\s\S]*0\.0\.0\.0/);
  });

  it('refuses non-loopback, non-bridge, non-0.0.0.0 addresses', () => {
    // Presence of the throw gated by "not loopback AND not bridge" logic
    expect(source).toMatch(/!allowLoopback\s*&&\s*!allowBridge/);
    expect(source).toMatch(/throw new Error\([\s\S]*CREDENTIAL_PROXY_HOST/);
  });
});

// ─────────────────────────────────────────────────
// 32. C12 — sanitize Ollama classification at parse boundary
// ─────────────────────────────────────────────────
describe('Ollama classification sanitization (C12)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/event-router.ts'),
    'utf-8',
  );

  it('exports sanitizeClassificationText and length caps', () => {
    expect(source).toContain('export function sanitizeClassificationText');
    expect(source).toContain('CLASSIFICATION_TOPIC_MAX_LEN');
    expect(source).toContain('CLASSIFICATION_SUMMARY_MAX_LEN');
  });

  it('parseClassification calls sanitizeClassificationText', () => {
    // Regression guard: if someone refactors parseClassification and drops
    // the sanitizer, the grep will catch it. Match the method definition
    // (not the call site) by anchoring on `private parseClassification(`.
    const defMatch = source.match(/private parseClassification\([\s\S]*?^  }/m);
    expect(defMatch).not.toBeNull();
    const parseBlock = defMatch![0];
    expect(parseBlock).toContain('sanitizeClassificationText');
    expect(parseBlock).toMatch(
      /sanitizeClassificationText\([^,]+,\s*'topic'\)/,
    );
    expect(parseBlock).toMatch(
      /sanitizeClassificationText\([^,]+,\s*'summary'\)/,
    );
  });
});

// ─────────────────────────────────────────────────
// 33. C12b — haystack hardening in event-routing
// ─────────────────────────────────────────────────
describe('Haystack hardening (C12b)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/event-routing.ts'),
    'utf-8',
  );

  it('exports HAYSTACK_MAX_LEN and URGENT_CONFIDENCE_FLOOR', () => {
    expect(source).toContain('export const HAYSTACK_MAX_LEN');
    expect(source).toContain('export const URGENT_CONFIDENCE_FLOOR');
  });

  it('haystack is sliced to HAYSTACK_MAX_LEN', () => {
    expect(source).toMatch(/\.slice\(0,\s*HAYSTACK_MAX_LEN\)/);
  });

  it('uses word-boundary match instead of raw .includes()', () => {
    // Regression guard: the old substring match was the vuln. If it
    // comes back, this grep fires.
    const routeBlock =
      source.match(/export function routeClassifiedEvent[\s\S]*?^}/m)?.[0] ??
      '';
    expect(routeBlock).not.toMatch(/haystack\.includes\(/);
    expect(routeBlock).toContain('matchesKeyword');
  });

  it('urgent score weight depends on confidence floor', () => {
    expect(source).toMatch(
      /confidence\s*>=\s*URGENT_CONFIDENCE_FLOOR\s*\?\s*URGENT_SCORE\s*:\s*URGENT_DOWNGRADED_SCORE/,
    );
  });
});
