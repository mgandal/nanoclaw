# Telegram Swarm Membership Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect — and surface to CLAIRE — every case where a pool bot pinned to a persona (e.g. swarm_3 → Marvin) is *not* actually a member of a group where its persona is supposed to speak (e.g. LAB-claw expects Marvin, Warren, Vincent, FranklinClaw). Audit-only: nothing in the runtime send-path changes; misses just become visible instead of being silently swallowed by the 403→main-bot fallback.

**Architecture:** A new scheduled task runs daily at 08:30 ET in the `telegram_claire` group. It (1) reads the persona-pinning intent from a single source-of-truth file `data/agents/swarm-membership.yaml`, (2) iterates over each `(group, persona)` pair, (3) probes membership via `api.getChat(chatId)` from the bot whose token is pinned to that persona, (4) classifies the result as `member`, `not_member`, or `error`, (5) writes a report to `data/agents/swarm-membership-audit.json` and a Markdown digest to `groups/telegram_claire/state/swarm-audit.md`, (6) DMs CLAIRE only when there's a regression vs. the previous run. The send-path code in `src/channels/telegram.ts:319-348` is unchanged — current silent fallback stays as a safety net.

**Tech Stack:** Bun/TypeScript host code, Grammy `Api` class (`src/channels/telegram.ts`), SQLite scheduled-tasks (`src/db.ts:41-50`), YAML config (`yaml` package — already a dep), `vitest` for unit tests, the existing scheduler loop in `src/task-scheduler.ts`.

**Pre-flight reality checks:**
- `data/agents/` contains 9 agent identity dirs (claire, coo, einstein, freud, marvin, simon, steve, vincent, warren). Persona names are read from `name:` in each `identity.md` (verified 2026-04-25).
- `src/config.ts:163-178` parses `TELEGRAM_POOL_PIN` as `bot_username:SenderName` pairs into `Record<string, string>`. Today the inverse direction (sender→token) is reconstructed inside `initBotPool` at `src/channels/telegram.ts:182-223`.
- `src/channels/telegram.ts` keeps `poolApis: Api[]` and `pinnedSenderIdx: Map<string, number>` as module-private state. We need to expose a read-only accessor for them — be careful not to break the existing send path or its 52-test, ~1127-line test suite.
- The current memory-of-record claims:
  - LAB-claw → Marvin, Warren, Vincent, FranklinClaw
  - HOME-claw → Marvin, Warren
  - CODE-claw → Simon, Vincent
  - SCIENCE-claw → Einstein, Simon, Vincent
  - COACH-claw → Freud
  - CLINIC-claw → Steve
  - OPS-claw, VAULT-claw, CLAIRE → no pool personas (main bot only)
  - Treat this as the *initial* config to encode in the YAML, not as live truth — the audit's whole point is that we don't actually know whether it matches reality.
- `getChat(chat_id)` is the right probe. `getChatMember` is officially "guaranteed to work only if the bot is an administrator," but pool bots are non-admin members. `getChat` returns the chat for any member bot and `403 Forbidden: bot is not a member …` otherwise.

---

### Task 1: Add swarm-membership.yaml as the source of truth

**Files:**
- Create: `data/agents/swarm-membership.yaml`
- Inspect: `data/agents/*/identity.md` (read each to confirm persona display names)

- [ ] **Step 1: Confirm persona display names match what's in identity.md**

```bash
for d in /Users/mgandal/Agents/nanoclaw/data/agents/*/; do
  agent=$(basename "$d")
  name=$(awk -F': ' '/^name:/ {print $2; exit}' "$d/identity.md")
  echo "$agent => $name"
done
```

Expected output (this is the canonical persona-name set used everywhere downstream):

```
claire => Claire
coo => FranklinClaw
einstein => Einstein
freud => Freud
marvin => Marvin
simon => Simon
steve => Steve
vincent => Vincent
warren => Warren
```

If any persona name surprises you, **stop and check with the user** — the YAML in Step 2 must use these exact strings (case matters; they're the same strings the bot pool renames `setMyName` to).

- [ ] **Step 2: Write the YAML config**

```bash
cat > /Users/mgandal/Agents/nanoclaw/data/agents/swarm-membership.yaml <<'EOF'
# Source of truth: which personas are expected to be reachable in which groups
# via the Telegram bot pool. Audited daily by the swarm-membership-audit task.
#
# group_folder: matches groups/<folder>/ and registered_groups.folder in store/messages.db.
# personas: list of agent display names from data/agents/<id>/identity.md (the `name:` field).
#
# A persona listed here MUST be pinned in TELEGRAM_POOL_PIN (.env) — otherwise the
# audit will report `unpinned` for that persona regardless of which group it's listed in.
# Groups not listed below are not audited (they default to main-bot only).

groups:
  telegram_lab-claw:
    personas: [Marvin, Warren, Vincent, FranklinClaw]
  telegram_home-claw:
    personas: [Marvin, Warren]
  telegram_code-claw:
    personas: [Simon, Vincent]
  telegram_science-claw:
    personas: [Einstein, Simon, Vincent]
  telegram_coach-claw:
    personas: [Freud]
  telegram_clinic-claw:
    personas: [Steve]
EOF
```

- [ ] **Step 3: Validate the YAML parses**

```bash
bun -e "
const fs = require('fs');
const yaml = require('yaml');
const cfg = yaml.parse(fs.readFileSync('/Users/mgandal/Agents/nanoclaw/data/agents/swarm-membership.yaml', 'utf8'));
console.log(JSON.stringify(cfg, null, 2));
console.log('Group count:', Object.keys(cfg.groups).length);
"
```

Expected: prints the structure with 6 group entries.

- [ ] **Step 4: Commit**

```bash
git add data/agents/swarm-membership.yaml
git commit -m "feat(swarm): add swarm-membership.yaml as audit source of truth"
```

---

### Task 2: Expose a read-only accessor for the pool bot APIs by persona

**Files:**
- Modify: `src/channels/telegram.ts` (after the `pinnedSenderIdx` declaration)
- Test: `src/channels/telegram.test.ts` (extend; baseline is 52 tests in ~1127 lines as of 2026-04-25)

- [ ] **Step 1: Read the existing pool-state module-private declarations**

```bash
grep -n "^const poolApis\|^const pinnedSenderIdx\|^const senderBotMap\|^let nextPoolIndex" /Users/mgandal/Agents/nanoclaw/src/channels/telegram.ts
```

Expected: line numbers for `poolApis: Api[]`, `pinnedSenderIdx: Map<string, number>`, `senderBotMap: Map<string, number>`, `nextPoolIndex: number`. Note the line of `pinnedSenderIdx` — the new export goes immediately after.

- [ ] **Step 2: Write a failing test**

Append to `src/channels/telegram.test.ts` (find the existing `describe('initBotPool', ...)` block; add this `describe` next to it):

```typescript
describe('getPoolBotForPersona', () => {
  beforeEach(() => {
    // Reset pool state between tests
    vi.resetModules();
  });

  it('returns the Api for a pinned persona', async () => {
    const mod = await import('./telegram.js');
    await mod.initBotPool(['t1', 't2'], { bot_t2: 'Freud' });
    const api = mod.getPoolBotForPersona('Freud');
    expect(api).toBeDefined();
    // The pinned bot must be index 1 (we pinned the second one)
    expect((api as { token: string }).token).toBe('t2');
  });

  it('returns undefined for an unpinned persona', async () => {
    const mod = await import('./telegram.js');
    await mod.initBotPool(['t1'], {});
    expect(mod.getPoolBotForPersona('NoSuchPersona')).toBeUndefined();
  });

  it('returns undefined when the pool is empty', async () => {
    const mod = await import('./telegram.js');
    // Don't call initBotPool
    expect(mod.getPoolBotForPersona('Freud')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
bun --bun vitest run src/channels/telegram.test.ts -t "getPoolBotForPersona"
```

Expected: FAIL with "getPoolBotForPersona is not a function" (or similar). If the existing test mocks block the import, study how the existing `initBotPool` tests mock `Api` and follow the same pattern.

- [ ] **Step 4: Implement the accessor**

In `src/channels/telegram.ts`, immediately after the line declaring `pinnedSenderIdx` (use the line number from Step 1; insert as a new export):

```typescript
/**
 * Read-only accessor for audit/diagnostic code: returns the Grammy `Api`
 * instance pinned to a given persona display name (e.g. "Freud", "Marvin").
 * Returns `undefined` if the persona is not pinned or the pool is empty.
 *
 * Does NOT trigger round-robin assignment — this is intentional. The audit
 * only cares about *pinned* personas. Dynamic round-robin assignments are
 * per-session and not auditable as a stable mapping.
 */
export function getPoolBotForPersona(persona: string): Api | undefined {
  const idx = pinnedSenderIdx.get(persona);
  if (idx === undefined) return undefined;
  return poolApis[idx];
}
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
bun --bun vitest run src/channels/telegram.test.ts -t "getPoolBotForPersona"
```

Expected: 3 PASS. If still failing, check that the mock for `Api` in the existing tests carries a `token` property forward (the test in Step 2 inspects `api.token` — the mock must pass through `new Api(token)` constructor argument).

- [ ] **Step 6: Run the full telegram test suite to confirm no regression**

```bash
bun --bun vitest run src/channels/telegram.test.ts
```

Expected: all tests PASS — baseline is 52 tests, post-change should be 52 + the 3 new `getPoolBotForPersona` tests = 55.

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat(telegram-pool): expose getPoolBotForPersona read-only accessor"
```

---

### Task 3: Build the audit script

**Files:**
- Create: `scripts/swarm-audit.ts`
- Test: `scripts/swarm-audit.test.ts`

The script is invokable from a scheduled task as `bun run scripts/swarm-audit.ts`, and produces:
1. `data/agents/swarm-membership-audit.json` — full machine-readable result
2. `groups/telegram_claire/state/swarm-audit.md` — human Markdown digest
3. exit code 0 always (the *next-run-comparison* logic decides whether to alert)

The audit looks up `(group_folder → telegram chat_jid)` from `registered_groups` in `store/messages.db`, then for each persona in the YAML probes `getChat(chatId)` and classifies the outcome.

- [ ] **Step 1: Write the failing test for `classifyChatProbe()`**

Create `scripts/swarm-audit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyChatProbe } from './swarm-audit.js';

describe('classifyChatProbe', () => {
  it('classifies a successful getChat as member', () => {
    expect(classifyChatProbe(null, { id: -1003892106437, type: 'supergroup' })).toEqual({
      status: 'member',
      detail: 'getChat ok',
    });
  });

  it('classifies error_code 403 as not_member', () => {
    const err = { error_code: 403, description: 'Forbidden: bot is not a member of the supergroup chat' };
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'not_member',
      detail: 'Forbidden: bot is not a member of the supergroup chat',
    });
  });

  it('classifies error_code 400 chat not found as not_member', () => {
    const err = { error_code: 400, description: 'Bad Request: chat not found' };
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'not_member',
      detail: 'Bad Request: chat not found',
    });
  });

  it('classifies generic errors as error (not not_member)', () => {
    const err = { error_code: 500, description: 'Internal Server Error' };
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'error',
      detail: 'Internal Server Error',
    });
  });

  it('classifies network errors with no error_code as error', () => {
    const err = new Error('ECONNREFUSED');
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'error',
      detail: 'ECONNREFUSED',
    });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun --bun vitest run scripts/swarm-audit.test.ts
```

Expected: FAIL with "Cannot find module './swarm-audit.js'".

- [ ] **Step 3: Implement the audit script**

Create `scripts/swarm-audit.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Swarm membership audit: probes whether each persona pinned in
 * data/agents/swarm-membership.yaml can actually reach the groups
 * where it's listed. Writes a JSON report and a Markdown digest;
 * the scheduled task (or any caller) decides whether to alert.
 *
 * Run manually:
 *   bun run scripts/swarm-audit.ts
 */
// Load .env BEFORE importing config — config.ts reads process.env at import time.
// Without this, ad-hoc CLI invocations (smoke-tests, manual reruns) silently see an
// empty TELEGRAM_BOT_POOL and the audit throws.
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import Database from 'better-sqlite3';
import { initBotPool, getPoolBotForPersona } from '../src/channels/telegram.js';
import { TELEGRAM_BOT_POOL, TELEGRAM_POOL_PIN } from '../src/config.js';
import { logger } from '../src/logger.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const YAML_PATH = path.join(REPO_ROOT, 'data/agents/swarm-membership.yaml');
const JSON_OUT = path.join(REPO_ROOT, 'data/agents/swarm-membership-audit.json');
const MD_OUT = path.join(
  REPO_ROOT,
  'groups/telegram_claire/state/swarm-audit.md',
);
const DB_PATH = path.join(REPO_ROOT, 'store/messages.db');

interface Membership {
  groups: Record<string, { personas: string[] }>;
}

interface ProbeResult {
  status: 'member' | 'not_member' | 'error' | 'unpinned' | 'no_chat';
  detail: string;
}

interface AuditRow {
  group_folder: string;
  group_jid: string | null;
  persona: string;
  status: ProbeResult['status'];
  detail: string;
  probed_at: string;
}

interface AuditReport {
  generated_at: string;
  rows: AuditRow[];
  summary: {
    total: number;
    member: number;
    not_member: number;
    error: number;
    unpinned: number;
    no_chat: number;
  };
}

export function classifyChatProbe(err: unknown, chat: unknown): ProbeResult {
  if (!err && chat) return { status: 'member', detail: 'getChat ok' };
  if (err && typeof err === 'object' && 'error_code' in err) {
    const e = err as { error_code: number; description?: string };
    const desc = e.description || `Telegram error ${e.error_code}`;
    if (
      e.error_code === 403 ||
      (e.error_code === 400 && /chat not found/i.test(desc))
    ) {
      return { status: 'not_member', detail: desc };
    }
    return { status: 'error', detail: desc };
  }
  if (err instanceof Error) return { status: 'error', detail: err.message };
  return { status: 'error', detail: String(err) };
}

async function main() {
  // 1. Load YAML config
  const cfg = yaml.parse(fs.readFileSync(YAML_PATH, 'utf8')) as Membership;
  if (!cfg?.groups) throw new Error(`Bad YAML at ${YAML_PATH}`);

  // 2. Initialize the bot pool (needed for getPoolBotForPersona to work)
  if (TELEGRAM_BOT_POOL.length === 0) {
    throw new Error(
      'TELEGRAM_BOT_POOL is empty in .env — audit cannot run without pool bots',
    );
  }
  await initBotPool(TELEGRAM_BOT_POOL, TELEGRAM_POOL_PIN);

  // 3. Resolve group_folder → chat_jid via DB.
  // IMPORTANT: registered_groups has multiple rows per folder for multi-channel
  // groups (e.g. telegram_lab-claw has both `tg:-100…` and `slack:C0AB…`).
  // Filter to Telegram-only: api.getChat() takes a Telegram numeric id, not a Slack id.
  const db = new Database(DB_PATH, { readonly: true });
  const folderToJid = new Map<string, string>();
  const rows = db
    .prepare("SELECT folder, jid FROM registered_groups WHERE jid LIKE 'tg:%'")
    .all() as Array<{ folder: string; jid: string }>;
  for (const r of rows) folderToJid.set(r.folder, r.jid);
  db.close();

  // 4. Probe each (group, persona) pair
  const auditRows: AuditRow[] = [];
  const probedAt = new Date().toISOString();

  for (const [groupFolder, group] of Object.entries(cfg.groups)) {
    const jid = folderToJid.get(groupFolder);
    const numericId = jid ? jid.replace(/^tg:/, '') : null;

    for (const persona of group.personas) {
      const baseRow: Omit<AuditRow, 'status' | 'detail'> = {
        group_folder: groupFolder,
        group_jid: jid ?? null,
        persona,
        probed_at: probedAt,
      };

      if (!jid) {
        auditRows.push({
          ...baseRow,
          status: 'no_chat',
          detail: `${groupFolder} not in registered_groups`,
        });
        continue;
      }

      const api = getPoolBotForPersona(persona);
      if (!api) {
        auditRows.push({
          ...baseRow,
          status: 'unpinned',
          detail: `No pool bot pinned to "${persona}" — check TELEGRAM_POOL_PIN`,
        });
        continue;
      }

      try {
        const chat = await api.getChat(numericId!);
        const result = classifyChatProbe(null, chat);
        auditRows.push({ ...baseRow, ...result });
      } catch (err) {
        const result = classifyChatProbe(err, null);
        auditRows.push({ ...baseRow, ...result });
      }
    }
  }

  // 5. Build report
  const summary = {
    total: auditRows.length,
    member: auditRows.filter((r) => r.status === 'member').length,
    not_member: auditRows.filter((r) => r.status === 'not_member').length,
    error: auditRows.filter((r) => r.status === 'error').length,
    unpinned: auditRows.filter((r) => r.status === 'unpinned').length,
    no_chat: auditRows.filter((r) => r.status === 'no_chat').length,
  };
  const report: AuditReport = { generated_at: probedAt, rows: auditRows, summary };

  // 6. Write JSON
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

  // 7. Write Markdown digest
  const md = renderMarkdown(report);
  fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
  fs.writeFileSync(MD_OUT, md);

  logger.info({ summary }, 'Swarm membership audit complete');
  console.log(JSON.stringify(summary, null, 2));
}

export function renderMarkdown(report: AuditReport): string {
  const { generated_at, rows, summary } = report;
  const groups = new Map<string, AuditRow[]>();
  for (const r of rows) {
    if (!groups.has(r.group_folder)) groups.set(r.group_folder, []);
    groups.get(r.group_folder)!.push(r);
  }
  const lines: string[] = [];
  lines.push(`# Swarm Membership Audit — ${generated_at}`);
  lines.push('');
  lines.push(
    `**Summary:** ${summary.member}/${summary.total} reachable · ${summary.not_member} not_member · ${summary.error} error · ${summary.unpinned} unpinned · ${summary.no_chat} no_chat`,
  );
  lines.push('');
  for (const [groupFolder, groupRows] of groups) {
    lines.push(`## ${groupFolder}`);
    for (const r of groupRows) {
      const icon =
        r.status === 'member'
          ? '✓'
          : r.status === 'not_member'
            ? '✗'
            : r.status === 'unpinned'
              ? '○'
              : r.status === 'no_chat'
                ? '?'
                : '⚠';
      lines.push(`- ${icon} **${r.persona}** — ${r.status}: ${r.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error({ err }, 'Swarm audit failed');
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run unit test to verify `classifyChatProbe` passes**

```bash
bun --bun vitest run scripts/swarm-audit.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Add a test for `renderMarkdown`**

Append to `scripts/swarm-audit.test.ts`:

```typescript
import { renderMarkdown } from './swarm-audit.js';

describe('renderMarkdown', () => {
  it('groups rows by group_folder and uses status icons', () => {
    const md = renderMarkdown({
      generated_at: '2026-04-25T12:00:00.000Z',
      rows: [
        {
          group_folder: 'telegram_lab-claw',
          group_jid: 'tg:-1003892106437',
          persona: 'Marvin',
          status: 'member',
          detail: 'getChat ok',
          probed_at: '2026-04-25T12:00:00.000Z',
        },
        {
          group_folder: 'telegram_lab-claw',
          group_jid: 'tg:-1003892106437',
          persona: 'Steve',
          status: 'not_member',
          detail: 'Forbidden: bot is not a member of the supergroup chat',
          probed_at: '2026-04-25T12:00:00.000Z',
        },
      ],
      summary: { total: 2, member: 1, not_member: 1, error: 0, unpinned: 0, no_chat: 0 },
    });
    expect(md).toContain('# Swarm Membership Audit — 2026-04-25T12:00:00.000Z');
    expect(md).toContain('## telegram_lab-claw');
    expect(md).toContain('✓ **Marvin** — member: getChat ok');
    expect(md).toContain(
      '✗ **Steve** — not_member: Forbidden: bot is not a member of the supergroup chat',
    );
    expect(md).toContain('1/2 reachable');
  });
});
```

- [ ] **Step 6: Run all unit tests**

```bash
bun --bun vitest run scripts/swarm-audit.test.ts
```

Expected: 6 PASS.

- [ ] **Step 7: Smoke-test against live data**

```bash
cd /Users/mgandal/Agents/nanoclaw
bun run scripts/swarm-audit.ts
```

Expected: prints a JSON summary like `{ "total": 13, "member": 12, "not_member": 1, ... }`. The numeric values depend on actual reality. Open the two output files and review:

```bash
cat data/agents/swarm-membership-audit.json | head -40
cat groups/telegram_claire/state/swarm-audit.md
```

The Markdown should be human-readable. **Whatever the numbers are, this is the first time we have ground truth — read the report carefully and confirm with the user that the misses (if any) match expectations.**

- [ ] **Step 8: Commit**

```bash
git add scripts/swarm-audit.ts scripts/swarm-audit.test.ts \
  data/agents/swarm-membership-audit.json \
  groups/telegram_claire/state/swarm-audit.md
git commit -m "feat(swarm): add membership audit script (audit-only, no enforcement)"
```

---

### Task 4: Add regression-only alerting (compare to last run)

**Files:**
- Modify: `scripts/swarm-audit.ts` (add diff logic + `--alert` flag handling)
- Test: `scripts/swarm-audit.test.ts`

We don't want to spam CLAIRE every morning. Only alert when:
- A `(group, persona)` pair regressed from `member` → `not_member`/`error`
- A new persona row appeared as `not_member`/`error` for the first time

Member→member, not_member→not_member, etc. stay silent. The Markdown digest in `groups/telegram_claire/state/swarm-audit.md` is rewritten every run anyway, so CLAIRE can read it on demand.

- [ ] **Step 1: Write the failing test for `diffAudits()`**

Append to `scripts/swarm-audit.test.ts`:

```typescript
import { diffAudits } from './swarm-audit.js';

const row = (
  group: string,
  persona: string,
  status: 'member' | 'not_member' | 'error' | 'unpinned' | 'no_chat',
) => ({
  group_folder: group,
  group_jid: `tg:fake-${group}`,
  persona,
  status,
  detail: '',
  probed_at: '2026-04-25T12:00:00.000Z',
});

describe('diffAudits', () => {
  it('returns empty when prev and curr are identical', () => {
    const r = [row('telegram_lab-claw', 'Marvin', 'member')];
    expect(diffAudits(r, r)).toEqual([]);
  });

  it('flags a member→not_member regression', () => {
    const prev = [row('telegram_lab-claw', 'Marvin', 'member')];
    const curr = [row('telegram_lab-claw', 'Marvin', 'not_member')];
    expect(diffAudits(prev, curr)).toEqual([
      {
        group_folder: 'telegram_lab-claw',
        persona: 'Marvin',
        from: 'member',
        to: 'not_member',
        kind: 'regression',
      },
    ]);
  });

  it('flags a brand-new not_member row as new_miss', () => {
    const prev: ReturnType<typeof row>[] = [];
    const curr = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    expect(diffAudits(prev, curr)).toEqual([
      {
        group_folder: 'telegram_clinic-claw',
        persona: 'Steve',
        from: null,
        to: 'not_member',
        kind: 'new_miss',
      },
    ]);
  });

  it('does NOT flag not_member→not_member (still broken, but not new)', () => {
    const prev = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    const curr = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    expect(diffAudits(prev, curr)).toEqual([]);
  });

  it('flags not_member→member as recovery', () => {
    const prev = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    const curr = [row('telegram_clinic-claw', 'Steve', 'member')];
    expect(diffAudits(prev, curr)).toEqual([
      {
        group_folder: 'telegram_clinic-claw',
        persona: 'Steve',
        from: 'not_member',
        to: 'member',
        kind: 'recovery',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun --bun vitest run scripts/swarm-audit.test.ts -t "diffAudits"
```

Expected: FAIL with "diffAudits is not a function".

- [ ] **Step 3: Implement `diffAudits` and wire `--alert` flag**

Add to `scripts/swarm-audit.ts` (above `main()`):

```typescript
export interface AuditDiff {
  group_folder: string;
  persona: string;
  from: ProbeResult['status'] | null;
  to: ProbeResult['status'];
  kind: 'regression' | 'new_miss' | 'recovery';
}

export function diffAudits(prev: AuditRow[], curr: AuditRow[]): AuditDiff[] {
  const key = (r: AuditRow) => `${r.group_folder}::${r.persona}`;
  const prevMap = new Map(prev.map((r) => [key(r), r.status] as const));
  const out: AuditDiff[] = [];
  for (const r of curr) {
    const before = prevMap.get(key(r)) ?? null;
    if (before === r.status) continue;
    if (r.status === 'member' && before && before !== 'member') {
      out.push({
        group_folder: r.group_folder,
        persona: r.persona,
        from: before,
        to: r.status,
        kind: 'recovery',
      });
    } else if (
      (r.status === 'not_member' || r.status === 'error') &&
      before === 'member'
    ) {
      out.push({
        group_folder: r.group_folder,
        persona: r.persona,
        from: before,
        to: r.status,
        kind: 'regression',
      });
    } else if (
      (r.status === 'not_member' || r.status === 'error') &&
      before === null
    ) {
      out.push({
        group_folder: r.group_folder,
        persona: r.persona,
        from: null,
        to: r.status,
        kind: 'new_miss',
      });
    }
  }
  return out;
}
```

Modify `main()` to load the previous JSON (if it exists) and emit a diff:

Find the lines in `main()` that write JSON (`fs.writeFileSync(JSON_OUT, ...)`) and add **before** that:

```typescript
  // Diff against previous run for alert-worthy changes
  let prevReport: AuditReport | null = null;
  try {
    if (fs.existsSync(JSON_OUT)) {
      prevReport = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')) as AuditReport;
    }
  } catch (err) {
    logger.warn({ err }, 'Could not parse previous audit JSON, treating as empty');
  }
  const diffs = diffAudits(prevReport?.rows ?? [], auditRows);
  if (diffs.length > 0) {
    logger.info({ diffs }, 'Swarm membership audit diffs detected');
    console.log('DIFFS:', JSON.stringify(diffs, null, 2));
  } else {
    console.log('DIFFS: none');
  }
  // Also write the diffs alongside the report so the scheduled-task prompt can read them
  fs.writeFileSync(
    path.join(REPO_ROOT, 'data/agents/swarm-membership-audit-diffs.json'),
    JSON.stringify({ generated_at: probedAt, diffs }, null, 2),
  );
```

- [ ] **Step 4: Run all tests**

```bash
bun --bun vitest run scripts/swarm-audit.test.ts
```

Expected: 11 PASS.

- [ ] **Step 5: Smoke-test the diff path**

Run the audit twice. The first run sets the baseline; the second should report `DIFFS: none`:

```bash
cd /Users/mgandal/Agents/nanoclaw
bun run scripts/swarm-audit.ts | tail -5
echo "--- second run ---"
bun run scripts/swarm-audit.ts | tail -5
```

Expected: first run prints DIFFS containing the initial set of `new_miss` entries (or `none` if everything is `member`). Second run prints `DIFFS: none`.

- [ ] **Step 6: Commit**

```bash
git add scripts/swarm-audit.ts scripts/swarm-audit.test.ts \
  data/agents/swarm-membership-audit.json \
  data/agents/swarm-membership-audit-diffs.json
git commit -m "feat(swarm): add diff logic — alert only on regressions and new misses"
```

---

### Task 5: Wire the audit as a daily scheduled task in CLAIRE

**Files:**
- Modify: `store/messages.db` (insert into `scheduled_tasks`)

The scheduled-tasks table is the runtime source of truth (see `src/db.ts:41-50`). Tasks are normally inserted via the in-container `task_add` IPC tool; for an ops-level recurring audit, direct SQL is acceptable.

- [ ] **Step 1: Sanity-check the table shape**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  ".schema scheduled_tasks"
```

Expected: a `CREATE TABLE` ddl with columns including `id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, status, next_run, context_mode, surface_outputs, proactive`. Note the columns — the INSERT in Step 2 must match.

- [ ] **Step 2: Confirm CLAIRE's group_folder and chat_jid**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT folder, jid FROM registered_groups WHERE folder='telegram_claire' AND jid LIKE 'tg:%';"
```

Expected: one row, `folder=telegram_claire`, `jid=tg:8475020901` (or similar — capture the actual value).

- [ ] **Step 3: Compute `next_run` for the first fire**

`next_run` is **TEXT (ISO 8601)** in SQLite — verified via `SELECT typeof(next_run), next_run FROM scheduled_tasks LIMIT 1` which returns `text|2026-04-27T13:00:00.000Z`. The scheduler does string comparison `next_run <= ?`, NOT integer arithmetic. Earlier plan drafts used epoch ms; that was wrong.

08:30 ET tomorrow, as ISO 8601:

```bash
node -e "
const d = new Date();
d.setDate(d.getDate() + 1);
d.setHours(8, 30, 0, 0);
console.log(d.toISOString());
"
```

Capture the output (a string like `2026-04-26T12:30:00.000Z` — note this is UTC since the .ts conversion strips local-tz offset; SQLite ISO strings sort correctly).

- [ ] **Step 4: Insert the task**

Substitute `<CLAIRE_JID>` with the value from Step 2 and `<NEXT_RUN_ISO>` with the ISO string from Step 3 (wrapped in single quotes — it's a TEXT column).

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db <<EOF
INSERT INTO scheduled_tasks (
  id, group_folder, chat_jid, prompt, script,
  schedule_type, schedule_value, status, next_run,
  context_mode, surface_outputs, proactive, created_at
) VALUES (
  'swarm-membership-audit',
  'telegram_claire',
  '<CLAIRE_JID>',
  'Run \`bun run scripts/swarm-audit.ts\` and read \`data/agents/swarm-membership-audit-diffs.json\`. If \`diffs\` is non-empty, send a brief Telegram message summarizing each entry (group/persona/from/to/kind). If empty, exit silently.',
  NULL,
  'cron',
  '30 8 * * *',
  'active',
  '<NEXT_RUN_ISO>',
  'isolated',
  0,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
EOF
```

Notes:
- `created_at` uses `strftime('%Y-%m-%dT%H:%M:%fZ','now')` to match the ISO 8601 TEXT format the rest of the schema uses (verified against existing rows).
- `script` is `NULL` because we want the prompt path (LLM agent decides what to do based on prompt body), not a raw script.

- [ ] **Step 5: Verify the row landed**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT id, schedule_value, status, next_run, created_at FROM scheduled_tasks WHERE id='swarm-membership-audit';"
```

Expected: one row, `schedule_value=30 8 * * *`, `status=active`, `next_run` is the ISO string from Step 3, `created_at` is an ISO string from "now". **No `datetime()` math** — `next_run` is already a readable ISO string.

- [ ] **Step 6: Tell NanoClaw to reload its scheduler view**

The scheduler watches the DB; restarts re-read it. To be safe:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
grep -i "swarm-membership-audit\|scheduler" /Users/mgandal/Agents/nanoclaw/logs/nanoclaw.log | tail -10
```

Expected: scheduler-loop log line acknowledging the new task (or at least no errors mentioning `swarm-membership-audit`).

- [ ] **Step 7: Commit a runbook note (the SQL itself isn't tracked, but document it)**

Create `docs/swarm-membership-audit.md`:

```bash
cat > /Users/mgandal/Agents/nanoclaw/docs/swarm-membership-audit.md <<'EOF'
# Swarm Membership Audit Runbook

## What it does
Daily 08:30 ET task in `telegram_claire`. Probes each `(group, persona)` listed
in `data/agents/swarm-membership.yaml` via `api.getChat()` from the persona's
pinned pool bot. Writes:
- `data/agents/swarm-membership-audit.json` — full report
- `data/agents/swarm-membership-audit-diffs.json` — regressions vs. last run
- `groups/telegram_claire/state/swarm-audit.md` — human digest

CLAIRE only DMs when `diffs[]` is non-empty (regression / new_miss / recovery).

## Adjusting the audit set
Edit `data/agents/swarm-membership.yaml`. Add or remove `(group, persona)`
pairs and the next run picks up the change automatically. No code changes
required for routine reconfiguration.

## Manual run
```bash
cd /Users/mgandal/Agents/nanoclaw
bun run scripts/swarm-audit.ts
cat data/agents/swarm-membership-audit-diffs.json
```

## Triage when CLAIRE reports a miss
1. `not_member`: the pool bot for that persona isn't in that Telegram group.
   Add it via the group admin: invite `@nanoclaw_1838_swarm_<N>_bot` (look up
   N from `TELEGRAM_POOL_PIN` in `.env`).
2. `unpinned`: the persona isn't in `TELEGRAM_POOL_PIN`. Either add a pin or
   remove the persona from `swarm-membership.yaml`.
3. `error`: read the `detail` field. Network/transient errors will self-clear.
4. `no_chat`: the group isn't registered in `registered_groups`. Likely a
   stale entry in the YAML — remove it.

## Out of scope
The audit does not enforce membership. The runtime send path
(`src/channels/telegram.ts:319-348`) still falls back to the main bot on 403.
EOF
git add docs/swarm-membership-audit.md
git commit -m "docs(swarm): runbook for daily membership audit"
```

---

### Task 6: Verify first scheduled fire and commit memory update

**Files:**
- Inspect: `store/messages.db` `task_run_logs` for `task_id=swarm-membership-audit`
- Update: `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md`
- Create: `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_swarm_membership_audit.md`

- [ ] **Step 1: Wait for first fire (08:30 ET tomorrow) and inspect the run log**

`task_run_logs` columns are `run_at TEXT, status TEXT, result TEXT, error TEXT, duration_ms INTEGER` — verified via `.schema task_run_logs`. There is **no `stdout`/`stderr` column**; the agent's textual output goes into `result` (or `error` on failure).

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT run_at, status, duration_ms, substr(result, 1, 400) AS result_head, substr(error, 1, 200) AS error_head FROM task_run_logs WHERE task_id='swarm-membership-audit' ORDER BY run_at DESC LIMIT 1;"
```

Expected: one row with `status=success`, `result_head` containing either:
- the agent's "diffs are empty, exiting" acknowledgement, OR
- a brief Telegram-message summary if `diffs[]` was non-empty.

**Stronger check** — also confirm the audit ran (the *script* succeeded, not just the agent):

```bash
ls -la /Users/mgandal/Agents/nanoclaw/data/agents/swarm-membership-audit-diffs.json
stat -f "%Sm" /Users/mgandal/Agents/nanoclaw/data/agents/swarm-membership-audit-diffs.json
```

The mtime should be within an hour of the scheduled fire. If the file's mtime is from before the fire, the agent didn't actually run the script — investigate.

- [ ] **Step 2: Confirm the report files were updated by the scheduled run**

```bash
ls -la /Users/mgandal/Agents/nanoclaw/data/agents/swarm-membership-audit.json
ls -la /Users/mgandal/Agents/nanoclaw/groups/telegram_claire/state/swarm-audit.md
stat -f "%Sm" /Users/mgandal/Agents/nanoclaw/data/agents/swarm-membership-audit.json
```

Expected: mtime within the last hour (matches the scheduled-fire time).

- [ ] **Step 3: Write the project memory file**

```bash
cat > /Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_swarm_membership_audit.md <<'EOF'
---
name: Swarm membership audit
description: Daily 08:30 ET task probes whether each pinned-persona pool bot is actually a member of the groups where it's expected to speak; alerts CLAIRE only on regressions
type: project
---
# Swarm membership audit (`swarm-membership-audit`)

**Status (2026-04-25):** Live. Reads `data/agents/swarm-membership.yaml`, probes via `api.getChat()` from each pinned bot, writes JSON + Markdown reports, alerts CLAIRE only on regressions/new_miss/recovery.

**Why:** Persona-pinning shipped earlier (swarm pool bots renamed to Marvin/Warren/etc.) but membership ("did Steve actually get added to CLINIC-claw?") was doc-only. Silent 403→main-bot fallback was masking misconfigurations.

**How to apply:**
- Source of truth: `data/agents/swarm-membership.yaml`. Edit and the next 08:30 fire picks it up.
- Outputs: `data/agents/swarm-membership-audit.json` (full), `swarm-membership-audit-diffs.json` (alert payload), `groups/telegram_claire/state/swarm-audit.md` (human digest).
- The runtime send path is unchanged — this is audit-only.
- Runbook: `docs/swarm-membership-audit.md`.
EOF
```

Then update `MEMORY.md` index. Use Edit tool to insert under the "## Linked topic files" section:

```
- [Swarm membership audit](project_swarm_membership_audit.md) — daily 08:30 ET probe; alerts CLAIRE only on (group, persona) regressions
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-25-swarm-membership-audit.md
git commit -m "docs(plans): mark swarm membership audit plan complete

First scheduled fire verified via task_run_logs. Outputs landing
at data/agents/swarm-membership-audit{,-diffs}.json. Memory updated."
```

---

## Self-review notes

- Spec coverage: ✅ source of truth (Task 1), accessor (Task 2), audit script + tests (Task 3), regression-only alerting (Task 4), scheduled task install (Task 5), verification + memory (Task 6).
- Placeholders: none — every test has the actual code; every command has expected output.
- Type consistency: `ProbeResult['status']`, `AuditRow`, `AuditDiff`, `AuditReport`, `Membership` all referenced consistently. Function names `getPoolBotForPersona`, `classifyChatProbe`, `renderMarkdown`, `diffAudits` consistent across tasks.
- Safety: no changes to the runtime send path. Audit script is read-only against Telegram (`getChat` is a query) and against the DB (`{ readonly: true }`). The scheduled task is `surface_outputs=0` so `console.log` doesn't leak to chat — only the explicit prompt-driven message does.
- Out of scope (do not let the engineer expand into these without a new plan):
  - Auto-inviting missing bots via `createChatInviteLink` (that's the **B** scope from brainstorming).
  - Hard-rejecting sends from disallowed personas (the **C** scope).
  - Including dynamic round-robin assignments in the audit (intentionally excluded — see Task 2 docstring).

---

### Task 7: Rollback procedure (only run if implementation needs to be reversed)

This is reference material — only execute if the audit produces unexpected behavior or you need to undo the work for a different reason. The plan is structurally low-risk (no runtime send-path changes), so rollback should be needed only in unusual circumstances.

**Files affected by rollback:**
- Delete row from `store/messages.db` `scheduled_tasks`
- `git rm` or `git revert` for: `data/agents/swarm-membership.yaml`, `scripts/swarm-audit.ts`, `scripts/swarm-audit.test.ts`, `docs/swarm-membership-audit.md`
- `git revert` the export commit in `src/channels/telegram.ts` (the `getPoolBotForPersona` accessor)
- Remove run-state files: `data/agents/swarm-membership-audit.json`, `data/agents/swarm-membership-audit-diffs.json`, `groups/telegram_claire/state/swarm-audit.md`

- [ ] **Step 1: Stop the scheduled task**

```bash
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "DELETE FROM scheduled_tasks WHERE id='swarm-membership-audit';"
sqlite3 /Users/mgandal/Agents/nanoclaw/store/messages.db \
  "SELECT COUNT(*) FROM scheduled_tasks WHERE id='swarm-membership-audit';"
```

Expected: `0`.

- [ ] **Step 2: Remove run-state artifacts**

```bash
cd /Users/mgandal/Agents/nanoclaw/.worktrees/swarm-audit
rm -f data/agents/swarm-membership-audit.json \
      data/agents/swarm-membership-audit-diffs.json \
      groups/telegram_claire/state/swarm-audit.md
```

These are run-state, not source. They should already be gitignored (see Task 3 sub-step below) but `rm -f` is idempotent.

- [ ] **Step 3: Revert the feature commits**

```bash
cd /Users/mgandal/Agents/nanoclaw/.worktrees/swarm-audit
# Find the commits to revert
git log --oneline feat/swarm-membership-audit ^main
# Revert in reverse chronological order (newest first), or use a single revert range
git revert --no-edit <oldest_commit>..<newest_commit>
```

Or, if you want to throw the branch away entirely:

```bash
cd /Users/mgandal/Agents/nanoclaw
git worktree remove .worktrees/swarm-audit
git branch -D feat/swarm-membership-audit
```

- [ ] **Step 4: Restart NanoClaw to drop the deleted task from in-memory scheduler**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
grep -i "swarm-membership-audit" /Users/mgandal/Agents/nanoclaw/logs/nanoclaw.log | tail -5
```

Expected: no recent log entries referencing the task; if there are old ones, that's fine — just confirm no scheduler-loop errors.

---

### Task 3 sub-step: gitignore run-state artifacts (added per peer review)

Insert this between Task 3 Step 7 (smoke-test) and Task 3 Step 8 (commit) of the live execution flow:

- [ ] **Sub-step 7b: Gitignore audit run-state files**

The audit produces three run-state files on every fire. They MUST NOT be tracked, or every audit run produces a churn-y git diff:

```bash
cd /Users/mgandal/Agents/nanoclaw/.worktrees/swarm-audit
cat >> .gitignore <<'EOF'

# Swarm membership audit run-state (regenerated daily by scheduled task)
data/agents/swarm-membership-audit.json
data/agents/swarm-membership-audit-diffs.json
groups/telegram_claire/state/swarm-audit.md
EOF
git check-ignore -v data/agents/swarm-membership-audit.json
```

Expected: prints the gitignore rule that matches.

Then **change the Task 3 Step 8 commit** to drop the run-state files from `git add`:

```bash
# Old:
# git add scripts/swarm-audit.ts scripts/swarm-audit.test.ts \
#   data/agents/swarm-membership-audit.json \
#   groups/telegram_claire/state/swarm-audit.md
# New:
git add scripts/swarm-audit.ts scripts/swarm-audit.test.ts .gitignore
git commit -m "feat(swarm): add membership audit script (audit-only, no enforcement)"
```

Same fix applies to Task 4 Step 6 commit — `git add` should NOT include the JSON outputs.

---

## Implementation status (2026-04-25)

**Tasks 1-5 SHIPPED.** Task 6 deferred-fire variant: memory written and plan committed today; first scheduled fire verification pending 2026-04-26T08:30 EDT.

Commits on `feat/swarm-membership-audit`:
- `bd752308` Task 1 — swarm-membership.yaml
- `cafdd1d3` Task 2 — getPoolBotForPersona accessor
- `a7d7e475` Task 2 followup — multi-persona test + cast cleanup
- `71cdfa72` Task 3 — audit script (classifyChatProbe, renderMarkdown)
- `238eac2c` Task 3 followup — pool-size guard + import.meta.dirname
- `174a9298` Task 4 — diffAudits regression-only alerting
- `ae4d1884` Task 5 — scheduled_tasks row + runbook

Smoke-tests passed throughout. Plan deviations were corrections of plan errors (peer review caught: stealth-token claim wrong, JID clobber, schema mismatches; commit `09796ddf` patched the plan before implementation began).
