# Proactive Claire v1 Implementation Plan

> **Status: SHIPPED.** v1 substrate live: `src/outbound-governor.ts` (governor with quiet-hours/cooldown/dedup), `src/proactive-log.ts` + tests (audit log of every proactive send), `src/proactive-pause.ts` + tests (per-group pause toggle), `src/proactive-e2e.test.ts` (3-test E2E covering the full pipeline). 17/17 vitest pass. Per design intent, v1 ships zero correlation rules — the substrate is what's needed; v2 (cross-surface correlator) is gated on 2-4 weeks of governor-log data. Open `- [ ]` boxes never updated retroactively.

**Goal:** Ship the measurement substrate for proactive Claire — expanded watchers, outbound governor with quiet-hours / cooldown / dedup, proactive audit log, and a daily review digest. Correlator deferred to v2.

**Architecture:** Three-layer separation (generation / routing / delivery). Reuses EventRouter + MessageBus + bus-watcher + task-scheduler unchanged. New components inject at one chokepoint: `ipc.ts:deliverSendMessage`, gated by `payload.proactive === true`. All state in SQLite (`proactive_log` table) so crash-recovery is file-based.

**Tech Stack:** TypeScript (Bun runtime), SQLite (bun:sqlite), vitest, Ollama phi4-mini (existing), Gmail API (existing).

**Spec:** `docs/superpowers/specs/2026-04-18-proactive-claire-design.md`

---

## File Structure

**New files:**
- `src/outbound-governor.ts` + test
- `src/proactive-log.ts` + test
- `src/proactive-pause.ts` + test
- `src/quiet-hours.ts` + test
- `src/watchers/vault-delta-watcher.ts` + test
- `src/watchers/thread-silence-watcher.ts` + test
- `src/watchers/qmd-email-adapter.ts` + test
- `src/watchers/task-outcome-watcher.ts` + test
- `src/watchers/deferred-send-processor.ts` + test
- `src/startup/proactive-watchers.ts`
- `src/proactive-e2e.test.ts`
- `scripts/proactive/install-daily-review.ts`
- `scripts/proactive/archive-old-logs.ts`
- `groups/global/state/proactive-daily-review-prompt.md`

**Modified:**
- `src/db.ts` — proactive_log table + `surface_outputs`/`outcome_emitted`/`proactive` columns
- `src/config.ts` — new env vars
- `src/event-router.ts` — RawEvent union + buildPrompt dispatch
- `src/classification-prompts.ts` — three new prompt builders
- `src/ipc.ts` — governor intercept at deliverSendMessage + `set_proactive_pause` action
- `src/index.ts` — wire watchers + reaction backfill
- `src/task-scheduler.ts` — PROACTIVE_CORRELATION_ID env threading
- `src/container-runner.ts` — forward env var
- `scripts/sync/email-ingest.py` — Sent-folder ingestion with `direction` tag

## Conventions

- **Tests:** vitest, colocated `*.test.ts`. Run: `bun --bun vitest run src/path/foo.test.ts`.
- **Time:** all `proactive_log` timestamps are UTC ISO 8601. Local-time reasoning only inside `quiet-hours.ts`.
- **DB writes:** prefer `db.prepare(sql).run(...)` over `db.exec(...)`. Reserve multi-statement DDL only for schema creation.
- **Commits:** small, conventional-commit style; one per task at minimum.
- **Feature flags:** `PROACTIVE_GOVERNOR=false` → `deliverSendMessage` ignores `proactive: true`. `PROACTIVE_ENABLED=false` → governor runs but returns `drop: kill_switch`.

---

## Task 1: Config env vars

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Add failing test** in `src/config.test.ts`:

```ts
describe('proactive env vars', () => {
  it('defaults PROACTIVE_ENABLED to false', () => {
    delete process.env.PROACTIVE_ENABLED;
    const c = require('./config.js');
    expect(c.PROACTIVE_ENABLED).toBe(false);
  });
  it('defaults PROACTIVE_GOVERNOR to false', () => {
    delete process.env.PROACTIVE_GOVERNOR;
    const c = require('./config.js');
    expect(c.PROACTIVE_GOVERNOR).toBe(false);
  });
  it('parses quiet hours and days off', () => {
    process.env.QUIET_HOURS_START = '21:00';
    process.env.QUIET_HOURS_END = '07:30';
    process.env.QUIET_DAYS_OFF = 'Sat,Sun';
    const c = require('./config.js');
    expect(c.QUIET_HOURS_START).toBe('21:00');
    expect(c.QUIET_HOURS_END).toBe('07:30');
    expect(c.QUIET_DAYS_OFF).toEqual(['Sat', 'Sun']);
  });
  it('defaults QUIET_OVERRIDE_THRESHOLD to 0.8', () => {
    delete process.env.QUIET_OVERRIDE_THRESHOLD;
    const c = require('./config.js');
    expect(c.QUIET_OVERRIDE_THRESHOLD).toBe(0.8);
  });
  it('defaults AGENT_COOLDOWN_MINUTES to 20 and DEDUP_WINDOW_HOURS to 24', () => {
    delete process.env.AGENT_COOLDOWN_MINUTES;
    delete process.env.DEDUP_WINDOW_HOURS;
    const c = require('./config.js');
    expect(c.AGENT_COOLDOWN_MINUTES).toBe(20);
    expect(c.DEDUP_WINDOW_HOURS).toBe(24);
  });
});
```

- [ ] **Step 2: Run** `bun --bun vitest run src/config.test.ts` → FAIL.

- [ ] **Step 3: Append to `src/config.ts`**:

```ts
// --- Proactive Claire ---
export const PROACTIVE_ENABLED =
  (process.env.PROACTIVE_ENABLED || 'false').toLowerCase() === 'true';
export const PROACTIVE_GOVERNOR =
  (process.env.PROACTIVE_GOVERNOR || 'false').toLowerCase() === 'true';
export const PROACTIVE_GOVERNOR_STRICT =
  (process.env.PROACTIVE_GOVERNOR_STRICT || 'true').toLowerCase() === 'true';
export const PROACTIVE_WATCHERS_ENABLED =
  (process.env.PROACTIVE_WATCHERS_ENABLED || 'false').toLowerCase() === 'true';
export const QUIET_HOURS_START = process.env.QUIET_HOURS_START || '20:00';
export const QUIET_HOURS_END = process.env.QUIET_HOURS_END || '08:00';
export const QUIET_DAYS_OFF = (process.env.QUIET_DAYS_OFF || 'Sat,Sun')
  .split(',').map((s) => s.trim()).filter(Boolean);
export const QUIET_OVERRIDE_THRESHOLD = parseFloat(
  process.env.QUIET_OVERRIDE_THRESHOLD || '0.8');
export const AGENT_COOLDOWN_MINUTES = parseInt(
  process.env.AGENT_COOLDOWN_MINUTES || '20', 10);
export const DEDUP_WINDOW_HOURS = parseInt(
  process.env.DEDUP_WINDOW_HOURS || '24', 10);
export const PROACTIVE_LOG_RETENTION_DAYS = parseInt(
  process.env.PROACTIVE_LOG_RETENTION_DAYS || '90', 10);
export const PROACTIVE_PAUSE_PATH = path.join(DATA_DIR, 'proactive', 'pause.json');
```

- [ ] **Step 4: Run** `bun --bun vitest run src/config.test.ts` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(proactive): env vars for governor, quiet hours, cooldown, dedup"`

---

## Task 2: Proactive log schema + migrations

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db-migration.test.ts`

- [ ] **Step 1: Failing test** in `src/db-migration.test.ts`:

```ts
describe('proactive_log schema', () => {
  it('creates proactive_log with required columns', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('proactive_log')").all() as {name: string}[];
    expect(cols.map(c => c.name)).toEqual(
      expect.arrayContaining([
        'id','timestamp','from_agent','to_group','decision','reason',
        'urgency','rule_id','correlation_id','message_preview',
        'contributing_events','deliver_at','dispatched_at','delivered_at',
        'reaction_kind','reaction_value',
      ]));
  });
  it('adds surface_outputs to scheduled_tasks, proactive column too', () => {
    const cols = getDb().prepare("PRAGMA table_info('scheduled_tasks')").all() as {name:string}[];
    const names = cols.map(c => c.name);
    expect(names).toContain('surface_outputs');
    expect(names).toContain('proactive');
  });
  it('adds outcome_emitted to task_run_logs', () => {
    const cols = getDb().prepare("PRAGMA table_info('task_run_logs')").all() as {name:string}[];
    expect(cols.map(c => c.name)).toContain('outcome_emitted');
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Add schema + migration** in `src/db.ts`. Inside the existing schema-creation SQL block, add:

```sql
CREATE TABLE IF NOT EXISTS proactive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_group TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  urgency REAL,
  rule_id TEXT,
  correlation_id TEXT NOT NULL,
  message_preview TEXT,
  contributing_events TEXT,
  deliver_at TEXT,
  dispatched_at TEXT,
  delivered_at TEXT,
  reaction_kind TEXT,
  reaction_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_proactive_log_time ON proactive_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_log_dedup ON proactive_log(correlation_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_log_pending ON proactive_log(decision, delivered_at);
```

Add a new migration function:

```ts
function migrateProactive(database: Database): void {
  const addCol = (table: string, col: string, defn: string) => {
    const cols = database.prepare(`PRAGMA table_info('${table}')`).all() as {name:string}[];
    if (!cols.some((c) => c.name === col)) {
      database.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${defn}`).run();
    }
  };
  addCol('scheduled_tasks', 'surface_outputs', 'INTEGER DEFAULT 0');
  addCol('scheduled_tasks', 'proactive', 'INTEGER DEFAULT 0');
  addCol('task_run_logs', 'outcome_emitted', 'INTEGER DEFAULT 0');
}
```

Call `migrateProactive(database)` in the same init path that calls other migrations (search for existing `migrate*` calls).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(proactive): proactive_log table + migrations`.

---

## Task 3: Quiet hours pure-function module

**Files:**
- Create: `src/quiet-hours.ts`, `src/quiet-hours.test.ts`

- [ ] **Step 1: Failing test**:

```ts
import { isInQuietHours, nextQuietEnd } from './quiet-hours.js';

describe('isInQuietHours', () => {
  const cfg = { start: '20:00', end: '08:00', daysOff: ['Sat','Sun'], timezone: 'America/New_York' };
  it('true at 22:00 Tuesday', () => {
    expect(isInQuietHours(new Date('2026-04-14T22:00:00-04:00'), cfg)).toBe(true);
  });
  it('false at 10:00 Tuesday', () => {
    expect(isInQuietHours(new Date('2026-04-14T10:00:00-04:00'), cfg)).toBe(false);
  });
  it('true all day Saturday', () => {
    expect(isInQuietHours(new Date('2026-04-18T12:00:00-04:00'), cfg)).toBe(true);
  });
  it('true at 07:00 before end', () => {
    expect(isInQuietHours(new Date('2026-04-14T07:00:00-04:00'), cfg)).toBe(true);
  });
  it('false exactly at 08:00 end', () => {
    expect(isInQuietHours(new Date('2026-04-14T08:00:00-04:00'), cfg)).toBe(false);
  });
});

describe('nextQuietEnd', () => {
  const cfg = { start: '20:00', end: '08:00', daysOff: ['Sat','Sun'], timezone: 'America/New_York' };
  it('Fri 22:00 → Mon 08:00 EDT (12:00 UTC)', () => {
    const next = nextQuietEnd(new Date('2026-04-17T22:00:00-04:00'), cfg);
    expect(next.toISOString()).toBe('2026-04-20T12:00:00.000Z');
  });
  it('Tue 22:00 → Wed 08:00 EDT', () => {
    const next = nextQuietEnd(new Date('2026-04-14T22:00:00-04:00'), cfg);
    expect(next.toISOString()).toBe('2026-04-15T12:00:00.000Z');
  });
  it('Sat noon → Mon 08:00 EDT', () => {
    const next = nextQuietEnd(new Date('2026-04-18T12:00:00-04:00'), cfg);
    expect(next.toISOString()).toBe('2026-04-20T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/quiet-hours.ts`:

```ts
export interface QuietConfig {
  start: string;
  end: string;
  daysOff: string[];
  timezone: string;
}

function parseHHMM(s: string): { h: number; m: number } {
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return { h, m };
}

function localParts(d: Date, tz: string): { day: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  let day = '', hour = 0, minute = 0;
  for (const p of fmt.formatToParts(d)) {
    if (p.type === 'weekday') day = p.value;
    else if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return { day, hour, minute };
}

export function isInQuietHours(now: Date, cfg: QuietConfig): boolean {
  const { day, hour, minute } = localParts(now, cfg.timezone);
  if (cfg.daysOff.includes(day)) return true;
  const s = parseHHMM(cfg.start), e = parseHHMM(cfg.end);
  const cur = hour * 60 + minute;
  const sMin = s.h * 60 + s.m, eMin = e.h * 60 + e.m;
  if (sMin > eMin) return cur >= sMin || cur < eMin;
  return cur >= sMin && cur < eMin;
}

function offsetMin(utc: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(utc).map((p) => [p.type, p.value]));
  const local = Date.UTC(
    parseInt(parts.year,10), parseInt(parts.month,10)-1, parseInt(parts.day,10),
    parseInt(parts.hour,10)%24, parseInt(parts.minute,10), parseInt(parts.second,10));
  return (local - utc.getTime()) / 60_000;
}

export function nextQuietEnd(now: Date, cfg: QuietConfig): Date {
  const e = parseHHMM(cfg.end);
  let candidate = new Date(now.getTime());
  for (let i = 0; i < 14; i++) {
    const { day } = localParts(candidate, cfg.timezone);
    if (!cfg.daysOff.includes(day)) {
      const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(candidate);
      const naive = new Date(`${ymd}T${String(e.h).padStart(2,'0')}:${String(e.m).padStart(2,'0')}:00`);
      const utc = new Date(naive.getTime() - offsetMin(naive, cfg.timezone) * 60_000);
      if (utc.getTime() > now.getTime()) return utc;
    }
    candidate = new Date(candidate.getTime() + 86400_000);
  }
  throw new Error('nextQuietEnd: no eligible day in 14d window');
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(proactive): quiet-hours module, tz-aware wrap-midnight`.

---

## Task 4: Proactive log CRUD

**Files:** Create `src/proactive-log.ts`, `src/proactive-log.test.ts`.

- [ ] **Step 1: Failing test**:

```ts
import { getDb } from './db.js';
import {
  insertLog, hasDeliveredOrDispatchedRecent, getLastAgentSend,
  markDispatched, markDelivered, clearDispatch, getDueDefers,
  backfillReaction,
} from './proactive-log.js';

beforeEach(() => { getDb().prepare('DELETE FROM proactive_log').run(); });

describe('proactive-log CRUD', () => {
  it('inserts and dedup finds delivered rows', () => {
    const id = insertLog({
      timestamp: new Date().toISOString(), fromAgent: 'a', toGroup: 'j',
      decision: 'send', reason: 'approved', correlationId: 'c1', contributingEvents: [],
    });
    markDispatched(id, new Date().toISOString());
    markDelivered(id, new Date().toISOString());
    expect(hasDeliveredOrDispatchedRecent('c1', 24)).toBe(true);
    expect(hasDeliveredOrDispatchedRecent('other', 24)).toBe(false);
  });
  it('getLastAgentSend returns only send decisions', () => {
    insertLog({ timestamp: new Date().toISOString(), fromAgent: 'ein', toGroup: 'j',
      decision: 'drop', reason: 'kill_switch', correlationId: 'x', contributingEvents: [] });
    const id = insertLog({ timestamp: new Date().toISOString(), fromAgent: 'ein', toGroup: 'j',
      decision: 'send', reason: 'approved', correlationId: 'y', contributingEvents: [] });
    expect(getLastAgentSend('ein')?.id).toBe(id);
  });
  it('clearDispatch nulls dispatched_at', () => {
    const id = insertLog({ timestamp: new Date().toISOString(), fromAgent: 'a', toGroup: 'j',
      decision: 'send', reason: 'approved', correlationId: 'c2', contributingEvents: [] });
    markDispatched(id, new Date().toISOString());
    clearDispatch(id);
    const row = getDb().prepare('SELECT dispatched_at FROM proactive_log WHERE id=?').get(id) as any;
    expect(row.dispatched_at).toBeNull();
  });
  it('getDueDefers returns pending defers with deliver_at <= now', () => {
    insertLog({ timestamp: '2026-04-18T01:00Z', fromAgent: 'a', toGroup: 'j',
      decision: 'defer', reason: 'quiet_hours', correlationId: 'd1',
      deliverAt: '2026-04-18T11:00Z', contributingEvents: [] });
    insertLog({ timestamp: '2026-04-18T01:00Z', fromAgent: 'a', toGroup: 'j',
      decision: 'defer', reason: 'quiet_hours', correlationId: 'd2',
      deliverAt: '2026-04-19T11:00Z', contributingEvents: [] });
    const due = getDueDefers('2026-04-18T12:00Z');
    expect(due.map(r => r.correlation_id)).toEqual(['d1']);
  });
  it('backfillReaction tags most recent matching send within 1h', () => {
    const ts = new Date(Date.now() - 30 * 60_000).toISOString();
    const id = insertLog({ timestamp: ts, fromAgent: 'claire', toGroup: 'main',
      decision: 'send', reason: 'approved',
      correlationId: 'task:proactive-daily-review:2026-04-18', contributingEvents: [] });
    markDelivered(id, ts);
    expect(backfillReaction('main', /^task:proactive-daily-review:/, 'reply', 'thanks')).toBe(true);
    const row = getDb().prepare('SELECT * FROM proactive_log WHERE id=?').get(id) as any;
    expect(row.reaction_kind).toBe('reply');
    expect(row.reaction_value).toBe('thanks');
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/proactive-log.ts`**:

```ts
import { getDb } from './db.js';

export interface ProactiveLogRow {
  id: number; timestamp: string; from_agent: string; to_group: string;
  decision: 'send'|'defer'|'drop'; reason: string;
  urgency: number|null; rule_id: string|null; correlation_id: string;
  message_preview: string|null; contributing_events: string|null;
  deliver_at: string|null; dispatched_at: string|null; delivered_at: string|null;
  reaction_kind: 'emoji'|'reply'|null; reaction_value: string|null;
}

export interface InsertLog {
  timestamp: string; fromAgent: string; toGroup: string;
  decision: 'send'|'defer'|'drop'; reason: string;
  urgency?: number; ruleId?: string; correlationId: string;
  messagePreview?: string; contributingEvents: string[]; deliverAt?: string;
}

export function insertLog(row: InsertLog): number {
  const res = getDb().prepare(
    `INSERT INTO proactive_log
      (timestamp, from_agent, to_group, decision, reason, urgency, rule_id,
       correlation_id, message_preview, contributing_events, deliver_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.timestamp, row.fromAgent, row.toGroup, row.decision, row.reason,
    row.urgency ?? null, row.ruleId ?? null, row.correlationId,
    row.messagePreview ?? null, JSON.stringify(row.contributingEvents),
    row.deliverAt ?? null,
  );
  return Number(res.lastInsertRowid);
}

export function hasDeliveredOrDispatchedRecent(correlationId: string, hoursBack: number): boolean {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const row = getDb().prepare(
    `SELECT id FROM proactive_log
     WHERE correlation_id = ? AND timestamp >= ?
       AND (delivered_at IS NOT NULL OR dispatched_at IS NOT NULL)
     LIMIT 1`,
  ).get(correlationId, since);
  return !!row;
}

export function getLastAgentSend(fromAgent: string): ProactiveLogRow | null {
  return (getDb().prepare(
    `SELECT * FROM proactive_log WHERE from_agent = ? AND decision = 'send'
     ORDER BY timestamp DESC LIMIT 1`,
  ).get(fromAgent) as ProactiveLogRow | undefined) ?? null;
}

export function markDispatched(id: number, at: string): void {
  getDb().prepare('UPDATE proactive_log SET dispatched_at = ? WHERE id = ?').run(at, id);
}

export function markDelivered(id: number, at: string): void {
  getDb().prepare('UPDATE proactive_log SET delivered_at = ? WHERE id = ?').run(at, id);
}

export function clearDispatch(id: number): void {
  getDb().prepare('UPDATE proactive_log SET dispatched_at = NULL WHERE id = ?').run(id);
}

export function getDueDefers(nowIso: string): ProactiveLogRow[] {
  return getDb().prepare(
    `SELECT * FROM proactive_log
     WHERE decision = 'defer' AND delivered_at IS NULL AND deliver_at <= ?
     ORDER BY deliver_at ASC`,
  ).all(nowIso) as ProactiveLogRow[];
}

export function backfillReaction(
  toGroup: string,
  correlationPattern: RegExp,
  kind: 'emoji'|'reply',
  value: string,
  windowMs = 3600_000,
): boolean {
  const since = new Date(Date.now() - windowMs).toISOString();
  const candidates = getDb().prepare(
    `SELECT * FROM proactive_log
     WHERE to_group = ? AND decision = 'send' AND reaction_kind IS NULL
       AND delivered_at >= ?
     ORDER BY delivered_at DESC LIMIT 20`,
  ).all(toGroup, since) as ProactiveLogRow[];
  const match = candidates.find((r) => correlationPattern.test(r.correlation_id));
  if (!match) return false;
  getDb().prepare(
    `UPDATE proactive_log SET reaction_kind = ?, reaction_value = ? WHERE id = ?`,
  ).run(kind, value.slice(0, 500), match.id);
  return true;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): proactive_log CRUD`.

---

## Task 5: Pause file module

**Files:** Create `src/proactive-pause.ts`, `src/proactive-pause.test.ts`.

- [ ] **Step 1: Failing test**:

```ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPause, writePause, isPaused, clearPauseCache } from './proactive-pause.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-'));
const pauseFile = path.join(tmp, 'pause.json');

beforeEach(() => {
  try { fs.unlinkSync(pauseFile); } catch { /* noop */ }
  clearPauseCache();
});

describe('proactive-pause', () => {
  it('null when file missing', () => {
    expect(readPause(pauseFile)).toBe(null);
    expect(isPaused(pauseFile)).toBe(false);
  });
  it('round-trips', () => {
    writePause(pauseFile, '2026-04-18T23:00Z');
    expect(readPause(pauseFile)?.pausedUntil).toBe('2026-04-18T23:00Z');
  });
  it('paused true when future', () => {
    writePause(pauseFile, new Date(Date.now() + 3600_000).toISOString());
    expect(isPaused(pauseFile)).toBe(true);
  });
  it('paused false when past', () => {
    writePause(pauseFile, '2020-01-01T00:00Z');
    expect(isPaused(pauseFile)).toBe(false);
  });
  it('paused true when null (indefinite)', () => {
    writePause(pauseFile, null);
    expect(isPaused(pauseFile)).toBe(true);
  });
  it('corrupt file → fail closed (paused)', () => {
    fs.writeFileSync(pauseFile, '{not valid');
    expect(isPaused(pauseFile)).toBe(true);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/proactive-pause.ts`:

```ts
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface PauseState { pausedUntil: string | null; setBy: string; setAt: string; }
const CACHE_TTL_MS = 5000;
let cache: { value: PauseState | 'corrupt' | null; readAt: number } | null = null;

export function clearPauseCache(): void { cache = null; }

export function readPause(pauseFile: string): PauseState | null {
  if (cache && Date.now() - cache.readAt < CACHE_TTL_MS) {
    if (cache.value === 'corrupt') return { pausedUntil: null, setBy: 'corrupt', setAt: '' };
    return cache.value;
  }
  try {
    if (!fs.existsSync(pauseFile)) {
      cache = { value: null, readAt: Date.now() };
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(pauseFile, 'utf-8')) as PauseState;
    cache = { value: parsed, readAt: Date.now() };
    return parsed;
  } catch (err) {
    logger.error({ err, pauseFile }, 'pause file unreadable → fail closed');
    cache = { value: 'corrupt', readAt: Date.now() };
    return { pausedUntil: null, setBy: 'corrupt', setAt: '' };
  }
}

export function writePause(pauseFile: string, pausedUntil: string | null): void {
  fs.mkdirSync(path.dirname(pauseFile), { recursive: true });
  const state: PauseState = { pausedUntil, setBy: 'user', setAt: new Date().toISOString() };
  const tmp = pauseFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, pauseFile);
  clearPauseCache();
}

export function isPaused(pauseFile: string): boolean {
  const s = readPause(pauseFile);
  if (!s) return false;
  if (s.setBy === 'corrupt') return true;
  if (s.pausedUntil === null) return true;
  return new Date(s.pausedUntil).getTime() > Date.now();
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): pause file with fail-closed corrupt handling`.

---

## Task 6: Governor

**Files:** Create `src/outbound-governor.ts`, `src/outbound-governor.test.ts`.

- [ ] **Step 1: Failing test**: covers each decision path (kill_switch, paused, duplicate_recent, agent_cooldown, quiet_hours deferral, urgency override, approved, missing correlation_id, every decision logs).

```ts
import { getDb } from './db.js';
import { insertLog, markDispatched, markDelivered } from './proactive-log.js';
import { decide, ProactiveSend } from './outbound-governor.js';

function baseSend(o: Partial<ProactiveSend> = {}): ProactiveSend {
  return { fromAgent: 'einstein', toGroup: 'jid:1', message: 'test',
    urgency: 0.5, correlationId: 'escalate:test:abc', ruleId: 'escalate',
    contributingEvents: [], ...o };
}

function defaultCtx(overrides = {}) {
  return {
    enabled: true, governorOn: true,
    isPaused: () => false,
    isInQuiet: () => false,
    nextQuietEnd: () => new Date('2026-04-15T12:00Z'),
    now: () => new Date('2026-04-15T14:00Z'),
    pauseFile: '/tmp/none',
    ...overrides,
  };
}

beforeEach(() => { getDb().prepare('DELETE FROM proactive_log').run(); });

describe('governor.decide', () => {
  it('kill_switch when disabled', () => {
    const r = decide(baseSend(), defaultCtx({ enabled: false }));
    expect(r).toMatchObject({ decision: 'drop', reason: 'kill_switch' });
  });
  it('paused when pause active', () => {
    const r = decide(baseSend(), defaultCtx({ isPaused: () => true }));
    expect(r).toMatchObject({ decision: 'drop', reason: 'paused' });
  });
  it('duplicate_recent when correlation delivered within window', () => {
    const id = insertLog({ timestamp: new Date(Date.now() - 3600_000).toISOString(),
      fromAgent: 'einstein', toGroup: 'jid:1', decision: 'send', reason: 'approved',
      correlationId: 'escalate:test:abc', contributingEvents: [] });
    markDispatched(id, new Date().toISOString());
    markDelivered(id, new Date().toISOString());
    const r = decide(baseSend(), defaultCtx());
    expect(r.reason).toBe('duplicate_recent');
  });
  it('agent_cooldown defers when agent sent recently', () => {
    insertLog({ timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
      fromAgent: 'einstein', toGroup: 'jid:1', decision: 'send', reason: 'approved',
      correlationId: 'escalate:other:xyz', contributingEvents: [] });
    const r = decide(baseSend(), defaultCtx({ now: () => new Date() }));
    expect(r).toMatchObject({ decision: 'defer', reason: 'agent_cooldown' });
    expect(r.deliverAt).toBeDefined();
  });
  it('quiet_hours defers when outside window and urgency low', () => {
    const r = decide(baseSend({ urgency: 0.5 }), defaultCtx({
      isInQuiet: () => true,
      nextQuietEnd: () => new Date('2026-04-15T12:00Z'),
    }));
    expect(r).toMatchObject({ decision: 'defer', reason: 'quiet_hours' });
    expect(r.deliverAt).toBe('2026-04-15T12:00:00.000Z');
  });
  it('sends when quiet but urgency ≥ threshold', () => {
    const r = decide(baseSend({ urgency: 0.9 }), defaultCtx({ isInQuiet: () => true }));
    expect(r).toMatchObject({ decision: 'send', reason: 'approved' });
  });
  it('missing correlation_id drops', () => {
    const r = decide(baseSend({ correlationId: '' }), defaultCtx());
    expect(r.reason).toBe('missing_correlation_id');
  });
  it('every decision writes proactive_log row', () => {
    decide(baseSend(), defaultCtx());
    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM proactive_log').get() as any;
    expect(rows.c).toBe(1);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/outbound-governor.ts`**:

```ts
import { AGENT_COOLDOWN_MINUTES, DEDUP_WINDOW_HOURS, QUIET_OVERRIDE_THRESHOLD } from './config.js';
import { hasDeliveredOrDispatchedRecent, getLastAgentSend, insertLog } from './proactive-log.js';

export interface ProactiveSend {
  fromAgent: string; toGroup: string; message: string;
  urgency: number; correlationId: string; ruleId?: string;
  contributingEvents: string[];
}

export interface GovernorDecision {
  decision: 'send'|'defer'|'drop'; reason: string;
  deliverAt?: string; logId: number;
}

export interface GovernorContext {
  enabled: boolean; governorOn: boolean;
  isPaused: (file: string) => boolean;
  isInQuiet: (now: Date) => boolean;
  nextQuietEnd: (now: Date) => Date;
  now: () => Date; pauseFile: string;
}

export function decide(send: ProactiveSend, ctx: GovernorContext): GovernorDecision {
  const now = ctx.now();
  const nowIso = now.toISOString();
  const write = (decision: 'send'|'defer'|'drop', reason: string, deliverAt?: string): GovernorDecision => {
    const logId = insertLog({
      timestamp: nowIso, fromAgent: send.fromAgent, toGroup: send.toGroup,
      decision, reason, urgency: send.urgency, ruleId: send.ruleId,
      correlationId: send.correlationId || '(missing)',
      messagePreview: send.message.slice(0, 200),
      contributingEvents: send.contributingEvents, deliverAt,
    });
    return { decision, reason, deliverAt, logId };
  };

  if (!send.correlationId) return write('drop', 'missing_correlation_id');
  if (!ctx.enabled) return write('drop', 'kill_switch');
  if (ctx.isPaused(ctx.pauseFile)) return write('drop', 'paused');
  if (hasDeliveredOrDispatchedRecent(send.correlationId, DEDUP_WINDOW_HOURS)) {
    return write('drop', 'duplicate_recent');
  }
  const last = getLastAgentSend(send.fromAgent);
  if (last) {
    const ageMin = (now.getTime() - new Date(last.timestamp).getTime()) / 60_000;
    if (ageMin < AGENT_COOLDOWN_MINUTES) {
      const remainMs = (AGENT_COOLDOWN_MINUTES - ageMin) * 60_000;
      return write('defer', 'agent_cooldown', new Date(now.getTime() + remainMs).toISOString());
    }
  }
  if (ctx.isInQuiet(now) && send.urgency < QUIET_OVERRIDE_THRESHOLD) {
    return write('defer', 'quiet_hours', ctx.nextQuietEnd(now).toISOString());
  }
  return write('send', 'approved');
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): governor decision logic`.

---

## Task 7: Wire governor into deliverSendMessage

**Files:** Modify `src/ipc.ts`, `src/ipc.test.ts`.

- [ ] **Step 1: Failing test** (add to `src/ipc.test.ts`):

```ts
describe('deliverSendMessage with proactive payload', () => {
  beforeEach(() => { getDb().prepare('DELETE FROM proactive_log').run(); });

  it('governor off → ignores proactive flag and sends', async () => {
    process.env.PROACTIVE_GOVERNOR = 'false';
    const sendMessage = vi.fn();
    await deliverSendMessage(
      { chatJid: 'j', text: 'hi', proactive: true, correlationId: 'c1',
        urgency: 0.5, ruleId: 'escalate', fromAgent: 'ein', contributingEvents: [] } as any,
      { sendMessage } as any, 'main');
    expect(sendMessage).toHaveBeenCalled();
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM proactive_log').get() as any).c).toBe(0);
  });

  it('governor on + kill switch → drops and logs', async () => {
    process.env.PROACTIVE_GOVERNOR = 'true';
    process.env.PROACTIVE_ENABLED = 'false';
    const sendMessage = vi.fn();
    await deliverSendMessage(
      { chatJid: 'j', text: 'hi', proactive: true, correlationId: 'c2',
        urgency: 0.5, ruleId: 'escalate', fromAgent: 'ein', contributingEvents: [] } as any,
      { sendMessage } as any, 'main');
    expect(sendMessage).not.toHaveBeenCalled();
    const rows = getDb().prepare("SELECT * FROM proactive_log WHERE correlation_id='c2'").all();
    expect(rows.length).toBe(1);
  });

  it('throws when proactive=true but correlationId missing', async () => {
    process.env.PROACTIVE_GOVERNOR = 'true';
    process.env.PROACTIVE_ENABLED = 'true';
    await expect(deliverSendMessage(
      { chatJid: 'j', text: 'hi', proactive: true } as any,
      { sendMessage: vi.fn() } as any, 'main')).rejects.toThrow(/correlationId/);
  });

  it('sets dispatched_at before send and delivered_at after', async () => {
    process.env.PROACTIVE_GOVERNOR = 'true';
    process.env.PROACTIVE_ENABLED = 'true';
    let sawDispatched = false;
    const sendMessage = vi.fn(async () => {
      const row = getDb().prepare("SELECT * FROM proactive_log WHERE correlation_id='c3'").get() as any;
      if (row?.dispatched_at) sawDispatched = true;
    });
    await deliverSendMessage(
      { chatJid: 'j', text: 'hi', proactive: true, correlationId: 'c3',
        urgency: 0.5, ruleId: 'escalate', fromAgent: 'ein', contributingEvents: [] } as any,
      { sendMessage } as any, 'main');
    expect(sawDispatched).toBe(true);
    const row = getDb().prepare("SELECT * FROM proactive_log WHERE correlation_id='c3'").get() as any;
    expect(row.delivered_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Modify `src/ipc.ts`**. Extend the send payload type to include `proactive?: boolean`, `correlationId?: string`, `urgency?: number`, `ruleId?: string`, `contributingEvents?: string[]`, `fromAgent?: string`. Modify `deliverSendMessage`:

```ts
import {
  PROACTIVE_ENABLED, PROACTIVE_GOVERNOR, PROACTIVE_PAUSE_PATH,
  QUIET_HOURS_START, QUIET_HOURS_END, QUIET_DAYS_OFF, TIMEZONE,
} from './config.js';
import { decide as governorDecide } from './outbound-governor.js';
import { markDispatched, markDelivered, clearDispatch } from './proactive-log.js';
import { isPaused } from './proactive-pause.js';
import { isInQuietHours, nextQuietEnd } from './quiet-hours.js';

export async function deliverSendMessage(
  data: {
    chatJid: string; text: string; sender?: string; webAppUrl?: string;
    proactive?: boolean; correlationId?: string; urgency?: number;
    ruleId?: string; contributingEvents?: string[]; fromAgent?: string;
  },
  deps: IpcDeps, sourceGroup: string,
): Promise<void> {
  if (data.proactive && PROACTIVE_GOVERNOR) {
    if (!data.correlationId) {
      throw new Error('proactive=true requires correlationId');
    }
    const pauseFile = process.env.PROACTIVE_PAUSE_PATH_OVERRIDE || PROACTIVE_PAUSE_PATH;
    const decision = governorDecide(
      {
        fromAgent: data.fromAgent || sourceGroup,
        toGroup: data.chatJid, message: data.text,
        urgency: data.urgency ?? 0.5,
        correlationId: data.correlationId,
        ruleId: data.ruleId,
        contributingEvents: data.contributingEvents || [],
      },
      {
        enabled: PROACTIVE_ENABLED, governorOn: true,
        isPaused,
        isInQuiet: (now) => isInQuietHours(now, {
          start: QUIET_HOURS_START, end: QUIET_HOURS_END,
          daysOff: QUIET_DAYS_OFF, timezone: TIMEZONE,
        }),
        nextQuietEnd: (now) => nextQuietEnd(now, {
          start: QUIET_HOURS_START, end: QUIET_HOURS_END,
          daysOff: QUIET_DAYS_OFF, timezone: TIMEZONE,
        }),
        now: () => new Date(), pauseFile,
      },
    );
    if (decision.decision !== 'send') return;
    markDispatched(decision.logId, new Date().toISOString());
    try {
      await deps.sendMessage(data.chatJid, data.text);
      markDelivered(decision.logId, new Date().toISOString());
    } catch (err) {
      clearDispatch(decision.logId);
      throw err;
    }
    return;
  }
  await deps.sendMessage(data.chatJid, data.text);
}
```

- [ ] **Step 4: Run** full `src/ipc.test.ts` → PASS. **Step 5: Commit** `feat(proactive): governor wired into deliverSendMessage`.

---

## Task 8: EventRouter + classification prompts

**Files:** Modify `src/event-router.ts`, `src/classification-prompts.ts`, `src/classification-prompts.test.ts`, `src/event-router.test.ts`.

- [ ] **Step 1: Failing test** — three prompt-builder tests (vault/silent/task) asserting their content, plus one EventRouter test asserting `buildPrompt` dispatches `vault_change` to the vault prompt. See the spec for full example; key assertions:

```ts
expect(getVaultChangeClassificationPrompt({...}).prompt).toContain('99-wiki/papers/foo.md');
expect(getSilentThreadPrompt({...}).prompt).toContain('pi@penn.edu');
expect(getTaskOutcomePrompt({...}).prompt).toContain('morning-brief');
// EventRouter: spy on fetch, route a vault_change event, assert body.prompt contains the path.
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Append to `src/classification-prompts.ts`**:

```ts
export interface VaultChangePayload { path: string; tag: string; author: 'user'|'agent'|'unknown'; coalescedCount?: number; }
export function getVaultChangeClassificationPrompt(p: VaultChangePayload): { system: string; prompt: string } {
  return {
    system: 'You classify vault file changes. Output JSON {importance,urgency,topic,summary,suggestedRouting,requiresClaude,confidence}. User-authored changes low-importance unless papers/grants/deadlines.',
    prompt: `vault change:\npath: ${p.path}\ntag: ${p.tag}\nauthor: ${p.author}\ncoalesced: ${p.coalescedCount ?? 1}\n\nClassify and respond with JSON only.`,
  };
}

export interface SilentThreadPayload { threadId: string; sender: string; subject: string; lastReceivedAt: string; daysSilent: number; }
export function getSilentThreadPrompt(p: SilentThreadPayload): { system: string; prompt: string } {
  return {
    system: 'You classify overdue email threads. Output same JSON shape. Urgency scales with daysSilent and sender domain importance.',
    prompt: `silent thread:\nfrom: ${p.sender}\nsubject: ${p.subject}\nlast received: ${p.lastReceivedAt}\ndays silent: ${p.daysSilent}\n\nJSON only.`,
  };
}

export interface TaskOutcomePayload { taskId: string; taskName: string; outputPreview: string; }
export function getTaskOutcomePrompt(p: TaskOutcomePayload): { system: string; prompt: string } {
  return {
    system: 'You classify scheduled-task outputs to decide if they should surface. Same JSON shape.',
    prompt: `task outcome:\ntask: ${p.taskName}\noutput preview: ${p.outputPreview.slice(0, 300)}\n\nJSON only.`,
  };
}
```

- [ ] **Step 4: Modify `src/event-router.ts`**. Widen RawEvent:

```ts
export interface RawEvent {
  type: 'email'|'calendar'|'vault_change'|'silent_thread'|'task_outcome';
  id: string; timestamp: string; payload: Record<string, unknown>;
}
```

Replace `buildPrompt`:

```ts
import {
  getEmailClassificationPrompt, getCalendarClassificationPrompt,
  getVaultChangeClassificationPrompt, getSilentThreadPrompt, getTaskOutcomePrompt,
  type EmailPayload, type CalendarPayload,
  type VaultChangePayload, type SilentThreadPayload, type TaskOutcomePayload,
} from './classification-prompts.js';

private buildPrompt(event: RawEvent): { system: string; prompt: string } {
  switch (event.type) {
    case 'email': return getEmailClassificationPrompt(event.payload as unknown as EmailPayload);
    case 'calendar': return getCalendarClassificationPrompt(event.payload as unknown as CalendarPayload);
    case 'vault_change': return getVaultChangeClassificationPrompt(event.payload as unknown as VaultChangePayload);
    case 'silent_thread': return getSilentThreadPrompt(event.payload as unknown as SilentThreadPayload);
    case 'task_outcome': return getTaskOutcomePrompt(event.payload as unknown as TaskOutcomePayload);
    default: {
      const _: never = event.type;
      throw new Error(`Unknown event type: ${_}`);
    }
  }
}
```

- [ ] **Step 5: Run** → PASS. **Step 6: Commit** `feat(proactive): EventRouter supports vault_change/silent_thread/task_outcome`.

---

## Task 9: Vault delta watcher

**Files:** Create `src/watchers/vault-delta-watcher.ts` + test.

- [ ] **Step 1: Failing test**: emits on write, coalesces rapid writes into ≤2 events.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:

```ts
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type { RawEvent } from '../event-router.js';

export interface VaultDeltaConfig {
  roots: string[];
  onEvent: (event: RawEvent) => void;
  coalesceMs?: number;
}

export class VaultDeltaWatcher {
  private cfg: VaultDeltaConfig;
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, { count: number; firstSeen: number }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: VaultDeltaConfig) { this.cfg = cfg; }

  start(): void {
    for (const root of this.cfg.roots) {
      if (!fs.existsSync(root)) {
        logger.warn({ root }, 'vault-delta-watcher: root not found');
        continue;
      }
      try {
        this.watchers.push(fs.watch(root, { recursive: true }, (_ev, filename) => {
          if (!filename) return;
          this.enqueue(path.join(root, filename.toString()));
        }));
      } catch (err) { logger.error({ root, err }, 'failed to watch'); }
    }
  }

  private enqueue(abs: string): void {
    const existing = this.pending.get(abs);
    if (existing) existing.count += 1;
    else this.pending.set(abs, { count: 1, firstSeen: Date.now() });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.cfg.coalesceMs ?? 30_000);
    }
  }

  private flush(): void {
    this.flushTimer = null;
    for (const [abs, meta] of this.pending.entries()) {
      this.cfg.onEvent({
        type: 'vault_change',
        id: `vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        payload: {
          path: abs, tag: extractTag(abs), author: inferAuthor(abs),
          coalescedCount: meta.count,
        },
      });
    }
    this.pending.clear();
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

function extractTag(abs: string): string {
  const n = abs.replace(/\\/g, '/');
  const m = n.match(/\/99-wiki\/([^/]+)\//);
  if (m) return m[1];
  const m2 = n.match(/\/(\d{2}-[^/]+)\//);
  return m2 ? m2[1] : 'other';
}

function inferAuthor(abs: string): 'user'|'agent'|'unknown' {
  return abs.includes('/agents/output/') ? 'agent' : 'user';
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): vault-delta-watcher`.

---

## Task 10: Task outcome watcher

**Files:** Create `src/watchers/task-outcome-watcher.ts` + test.

- [ ] **Step 1: Failing test**: emits only for `status='success' AND surface_outputs=1`, not for `'error'` (that's `checkAlerts`), marks `outcome_emitted=1` idempotently.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:

```ts
import { getDb } from '../db.js';
import { logger } from '../logger.js';
import type { RawEvent } from '../event-router.js';

export interface TaskOutcomeConfig { onEvent: (event: RawEvent) => void; }

export class TaskOutcomeWatcher {
  private cfg: TaskOutcomeConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(cfg: TaskOutcomeConfig) { this.cfg = cfg; }

  poll(): void {
    const db = getDb();
    const rows = db.prepare(
      `SELECT l.id AS log_id, l.task_id, l.result, l.run_at
       FROM task_run_logs l
       JOIN scheduled_tasks t ON t.id = l.task_id
       WHERE l.status = 'success'
         AND (l.outcome_emitted IS NULL OR l.outcome_emitted = 0)
         AND t.surface_outputs = 1
         AND l.result IS NOT NULL AND TRIM(l.result) <> ''
       ORDER BY l.run_at ASC LIMIT 100`,
    ).all() as { log_id: number; task_id: string; result: string; run_at: string }[];

    for (const r of rows) {
      this.cfg.onEvent({
        type: 'task_outcome', id: `task-${r.task_id}-${r.log_id}`,
        timestamp: r.run_at,
        payload: { taskId: r.task_id, taskName: r.task_id, outputPreview: r.result.slice(0, 300) },
      });
      db.prepare('UPDATE task_run_logs SET outcome_emitted = 1 WHERE id = ?').run(r.log_id);
    }
    if (rows.length > 0) logger.info({ emitted: rows.length }, 'task-outcome emitted');
  }

  start(intervalMs = 60_000): void {
    if (!this.timer) this.timer = setInterval(() => this.poll(), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): task-outcome-watcher, success-only, no overlap with checkAlerts`.

---

## Task 11: Email ingest — sent-folder with direction tag

**Files:** Modify `scripts/sync/email-ingest.py`, extend existing Python tests.

- [ ] **Step 1: Read existing `email-ingest.py`** to understand ingest shape.
- [ ] **Step 2: Failing Python test**: asserts ingested records have `direction: inbound` or `direction: outbound` in YAML frontmatter.
- [ ] **Step 3: Run pytest** → FAIL.
- [ ] **Step 4: Implement**:
  - Extend Gmail query loop to also fetch `in:sent` messages.
  - Determine direction by comparing `From` against `GMAIL_ACCOUNT` env.
  - Add `direction: inbound|outbound` to the YAML frontmatter of each written markdown file.
  - Keep `thread_id` in frontmatter as well (if not already present) — required by the QMD adapter in Task 13.
- [ ] **Step 5: Run pytest** → PASS.
- [ ] **Step 6: Commit** `feat(email-ingest): sent-folder ingestion with direction tag`.

---

## Task 12: Thread silence watcher

**Files:** Create `src/watchers/thread-silence-watcher.ts` + test.

- [ ] **Step 1: Failing test**: emits when inbound latest + >=48h; skips when outbound-after-inbound; skips when inbound <48h; skips on `hasRecentEmission=true`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:

```ts
import type { RawEvent } from '../event-router.js';

export interface ThreadMessage { direction: 'inbound'|'outbound'; from: string; subject: string; timestamp: string; }

export interface QmdEmailClient {
  queryThreads: () => Promise<{ threadId: string; messages: ThreadMessage[] }[]>;
}

export interface ThreadSilenceConfig {
  qmd: QmdEmailClient;
  onEvent: (event: RawEvent) => void;
  hasRecentEmission: (threadId: string) => boolean;
  silentThresholdHours?: number;
}

export class ThreadSilenceWatcher {
  constructor(private cfg: ThreadSilenceConfig) {}

  async poll(): Promise<void> {
    const threshold = (this.cfg.silentThresholdHours ?? 48) * 3600_000;
    const now = Date.now();
    const threads = await this.cfg.qmd.queryThreads();
    for (const t of threads) {
      if (this.cfg.hasRecentEmission(t.threadId)) continue;
      const sorted = [...t.messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const latest = sorted[sorted.length - 1];
      if (!latest || latest.direction !== 'inbound') continue;
      const age = now - Date.parse(latest.timestamp);
      if (age < threshold) continue;
      this.cfg.onEvent({
        type: 'silent_thread', id: `silent-${t.threadId}-${now}`,
        timestamp: new Date(now).toISOString(),
        payload: {
          thread_id: t.threadId, sender: latest.from, subject: latest.subject,
          lastReceivedAt: latest.timestamp,
          daysSilent: Math.floor(age / 86400_000),
        },
      });
    }
  }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): thread-silence-watcher`.

---

## Task 13: QMD email adapter

**Files:** Create `src/watchers/qmd-email-adapter.ts` + test.

- [ ] **Step 1: Failing test**: groups files by `thread_id` frontmatter, ignores files missing `thread_id` or `direction`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:

```ts
import fs from 'fs';
import path from 'path';
import type { QmdEmailClient, ThreadMessage } from './thread-silence-watcher.js';

export class QmdEmailAdapter implements QmdEmailClient {
  constructor(private dir: string) {}

  async queryThreads(): Promise<{ threadId: string; messages: ThreadMessage[] }[]> {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    const byThread = new Map<string, ThreadMessage[]>();
    for (const f of files) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(this.dir, f), 'utf-8'));
      if (!fm.thread_id || !fm.direction) continue;
      const list = byThread.get(fm.thread_id) ?? [];
      list.push({
        direction: fm.direction as 'inbound'|'outbound',
        from: fm.from || '', subject: fm.subject || '',
        timestamp: fm.timestamp || '',
      });
      byThread.set(fm.thread_id, list);
    }
    return Array.from(byThread.entries()).map(([threadId, messages]) => ({ threadId, messages }));
  }
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const ix = line.indexOf(':');
    if (ix < 0) continue;
    out[line.slice(0, ix).trim()] = line.slice(ix + 1).trim();
  }
  return out;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): QmdEmailAdapter`.

---

## Task 14: Deferred send processor

**Files:** Create `src/watchers/deferred-send-processor.ts` + test.

- [ ] **Step 1: Failing test**: re-dispatches due defers, skips future ones, marks `delivered_at` on success.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:

```ts
import { getDueDefers, markDelivered } from '../proactive-log.js';
import { logger } from '../logger.js';

export interface DeferredSendProcessorConfig {
  send: (s: {
    toGroup: string; text: string; correlationId: string; fromAgent: string;
    urgency: number; ruleId?: string; contributingEvents: string[];
  }) => Promise<void>;
  now?: () => Date;
}

export class DeferredSendProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private cfg: DeferredSendProcessorConfig) {}

  async poll(): Promise<void> {
    const now = this.cfg.now?.() ?? new Date();
    const due = getDueDefers(now.toISOString());
    for (const r of due) {
      try {
        await this.cfg.send({
          toGroup: r.to_group, text: r.message_preview ?? '',
          correlationId: r.correlation_id, fromAgent: r.from_agent,
          urgency: r.urgency ?? 0.5, ruleId: r.rule_id ?? undefined,
          contributingEvents: r.contributing_events ? JSON.parse(r.contributing_events) : [],
        });
        markDelivered(r.id, new Date().toISOString());
      } catch (err) {
        logger.warn({ err, id: r.id }, 'deferred send failed, will retry');
      }
    }
  }

  start(intervalMs = 60_000): void {
    if (!this.timer) this.timer = setInterval(() => { void this.poll(); }, intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): deferred-send-processor`.

---

## Task 15: IPC set_proactive_pause action

**Files:** Modify `src/ipc.ts`, `src/ipc.test.ts`.

- [ ] **Step 1: Failing test**: action writes pause file with given pausedUntil; null is accepted for indefinite.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Add new branch** in the IPC action dispatcher (search for `data.type === 'message'` and add a sibling):

```ts
} else if (data.type === 'set_proactive_pause') {
  if (!isMain) { logger.warn({ sourceGroup }, 'set_proactive_pause rejected: not main'); return; }
  const pauseFile = process.env.PROACTIVE_PAUSE_PATH_OVERRIDE || PROACTIVE_PAUSE_PATH;
  const pausedUntil = typeof data.pausedUntil === 'string' ? data.pausedUntil : null;
  writePause(pauseFile, pausedUntil);
  logger.info({ pausedUntil }, 'proactive pause updated');
}
```

Import `writePause` and `PROACTIVE_PAUSE_PATH` at top.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): set_proactive_pause IPC action`.

---

## Task 16: PROACTIVE_CORRELATION_ID env threading

**Files:** Modify `src/task-scheduler.ts`, `src/container-runner.ts`, tests.

- [ ] **Step 1: Failing test** in `src/task-scheduler.test.ts`: a task with `proactive=1` column causes `runContainerAgent` to be called with `env.PROACTIVE_CORRELATION_ID = "task:<task_id>:<YYYY-MM-DD>"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**:
  - In `task-scheduler.ts`, at the call site that launches the container, build `extraEnv` conditionally:

```ts
const extraEnv: Record<string, string> = {};
if ((task as any).proactive === 1) {
  const dateLocal = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
  extraEnv.PROACTIVE_CORRELATION_ID = `task:${task.id}:${dateLocal}`;
}
await runContainerAgent({ /* existing args */, env: extraEnv });
```

  - In `container-runner.ts`, accept `env` in the config and pass as `-e KEY=VALUE` args. Mirror the pattern used for `QMD_URL`, `HONCHO_URL`, etc.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): thread PROACTIVE_CORRELATION_ID into proactive tasks`.

---

## Task 17: Wire watchers at startup

**Files:** Create `src/startup/proactive-watchers.ts`, modify `src/index.ts`, tests.

- [ ] **Step 1: Extract a testable factory** `wireProactiveWatchers(deps)`:

```ts
import { VaultDeltaWatcher } from '../watchers/vault-delta-watcher.js';
import { TaskOutcomeWatcher } from '../watchers/task-outcome-watcher.js';
import { ThreadSilenceWatcher } from '../watchers/thread-silence-watcher.js';
import { QmdEmailAdapter } from '../watchers/qmd-email-adapter.js';
import { DeferredSendProcessor } from '../watchers/deferred-send-processor.js';
import type { EventRouter } from '../event-router.js';
import { PROACTIVE_WATCHERS_ENABLED } from '../config.js';
import { logger } from '../logger.js';

export interface ProactiveWiringDeps {
  eventRouter: EventRouter;
  vaultRoots: string[];
  emailExportDir: string;
  sendDeferred: (s: {
    toGroup: string; text: string; correlationId: string;
    fromAgent: string; urgency: number; ruleId?: string;
    contributingEvents: string[];
  }) => Promise<void>;
  hasRecentEmission: (threadId: string) => boolean;
}

export function wireProactiveWatchers(deps: ProactiveWiringDeps): { stop: () => void } {
  if (!PROACTIVE_WATCHERS_ENABLED) {
    logger.info('proactive watchers disabled');
    return { stop: () => {} };
  }
  const vault = new VaultDeltaWatcher({
    roots: deps.vaultRoots,
    onEvent: (e) => { void deps.eventRouter.route(e); },
  });
  const outcome = new TaskOutcomeWatcher({
    onEvent: (e) => { void deps.eventRouter.route(e); },
  });
  const silence = new ThreadSilenceWatcher({
    qmd: new QmdEmailAdapter(deps.emailExportDir),
    onEvent: (e) => { void deps.eventRouter.route(e); },
    hasRecentEmission: deps.hasRecentEmission,
  });
  const deferred = new DeferredSendProcessor({ send: deps.sendDeferred });

  vault.start(); outcome.start(); deferred.start();
  const silenceTimer = setInterval(() => { void silence.poll(); }, 4 * 3600_000);

  return {
    stop: () => {
      vault.stop(); outcome.stop(); deferred.stop();
      clearInterval(silenceTimer);
    },
  };
}
```

- [ ] **Step 2: Call from `src/index.ts`** after EventRouter and IPC deps are ready. Provide concrete wiring:

```ts
import { wireProactiveWatchers } from './startup/proactive-watchers.js';
import { getDb } from './db.js';
import os from 'os';

wireProactiveWatchers({
  eventRouter,
  vaultRoots: /* call the existing helper that returns mounted vault paths, or read from mount allowlist */,
  emailExportDir: path.join(os.homedir(), '.cache/email-ingest/exported'),
  hasRecentEmission: (threadId) => {
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    return !!getDb().prepare(
      `SELECT 1 FROM proactive_log WHERE correlation_id = ? AND timestamp >= ? LIMIT 1`,
    ).get(`silent_thread:${threadId}`, cutoff);
  },
  sendDeferred: async (s) => {
    await deliverSendMessage(
      {
        chatJid: s.toGroup, text: s.text, proactive: true,
        correlationId: s.correlationId, urgency: s.urgency, ruleId: s.ruleId,
        contributingEvents: s.contributingEvents, fromAgent: s.fromAgent,
      } as any, ipcDeps, 'main',
    );
  },
});
```

Note: use the existing mount-allowlist helper in `src/mount-security.ts` to derive vault roots. If no single helper exists, read the allowlist JSON the same way `validateAdditionalMounts` does.

- [ ] **Step 3: Test** `wireProactiveWatchers` returns a stop handle and invokes watchers' `start()`. Mock watcher classes or inject via DI (add an optional factory arg).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): wire watchers into startup`.

---

## Task 18: Daily review task seed

**Files:** Create `groups/global/state/proactive-daily-review-prompt.md`, `scripts/proactive/install-daily-review.ts`.

- [ ] **Step 1: Write prompt template** (see spec Section 8 for the expected digest format). Important: instructs the agent to send with `proactive: true` and the `correlationId` from `PROACTIVE_CORRELATION_ID` env, `urgency: 1.0`.
- [ ] **Step 2: Write installer**:

```ts
#!/usr/bin/env bun
import { getDb } from '../../src/db.js';
import fs from 'fs';
import path from 'path';

const prompt = fs.readFileSync(
  path.resolve('groups/global/state/proactive-daily-review-prompt.md'), 'utf-8');
const db = getDb();

const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get('proactive-daily-review');
if (existing) {
  db.prepare(
    `UPDATE scheduled_tasks
     SET prompt = ?, schedule_value = '30 19 * * 1-5', proactive = 1
     WHERE id = 'proactive-daily-review'`,
  ).run(prompt);
  console.log('Updated existing task');
} else {
  const mainJid = (db.prepare('SELECT jid FROM chats WHERE is_group=1 LIMIT 1').get() as any)?.jid ?? '';
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       next_run, status, created_at, proactive)
      VALUES ('proactive-daily-review', 'main', ?, ?, 'cron', '30 19 * * 1-5',
              ?, 'active', ?, 1)`,
  ).run(mainJid, prompt, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
  console.log('Installed task');
}
```

- [ ] **Step 3: Run installer** `bun run scripts/proactive/install-daily-review.ts`.
- [ ] **Step 4: Verify** via `sqlite3 store/messages.db "SELECT id, schedule_value, proactive FROM scheduled_tasks WHERE id='proactive-daily-review'"`.
- [ ] **Step 5: Commit** `feat(proactive): daily review task template + installer`.

---

## Task 19: Backfill reactions on main-group replies

**Files:** Modify `src/index.ts`, `src/index.test.ts`.

- [ ] **Step 1: Failing test**: inbound reply in main group within 1h of a `task:proactive-daily-review:*` send triggers `reaction_kind='reply'` + `reaction_value=<text>` backfill on that log row.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Modify** inbound-message handler in `src/index.ts`:

```ts
import { backfillReaction } from './proactive-log.js';

// after identifying that msg is in main group:
if (isMainGroup(msg.chatJid)) {
  backfillReaction(msg.chatJid, /^task:proactive-daily-review:/, 'reply', msg.text);
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(proactive): backfill reaction on main-group reply to daily review`.

---

## Task 20: End-to-end smoke test

**Files:** Create `src/proactive-e2e.test.ts`.

- [ ] **Step 1: Test both shadow-mode (governor on, enabled off) and live-mode (both on)** per the spec's acceptance criteria. Assertions:
  - shadow: `proactive: true` send → sendMessage NOT called, `proactive_log` row with `reason='kill_switch'`.
  - live: `proactive: true` send → sendMessage called once, `dispatched_at` and `delivered_at` both non-null.
- [ ] **Step 2: Run** → PASS (or make it pass by adjusting wiring).
- [ ] **Step 3: Commit** `test(proactive): end-to-end shadow + live mode`.

---

## Task 21: ESLint guard (optional)

**Files:** Modify existing `.eslintrc.*` or `eslint.config.*`.

- [ ] **Step 1:** If an ESLint config exists, add a `no-restricted-syntax` rule flagging direct `channel.sendMessage(...)` calls outside `src/ipc.ts` / `src/channels/` / `src/router.ts`. If no config exists, skip — Tasks 7 and 20 tests already catch regression.
- [ ] **Step 2:** Run lint, verify no false positives on current code.
- [ ] **Step 3: Commit** `chore(proactive): lint rule for direct sendMessage`.

---

## Task 22: Manual shadow-mode soak

Not automated.

- [ ] **Step 1:** Set `.env`:
```
PROACTIVE_GOVERNOR=true
PROACTIVE_ENABLED=false
PROACTIVE_WATCHERS_ENABLED=true
```
- [ ] **Step 2:** Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.
- [ ] **Step 3:** Let it run 48h. Nothing ships.
- [ ] **Step 4:** Inspect `proactive_log`:

```bash
sqlite3 store/messages.db \
  "SELECT timestamp, from_agent, to_group, reason, urgency, correlation_id, substr(message_preview,1,80) FROM proactive_log ORDER BY timestamp DESC LIMIT 50"
```

- [ ] **Step 5:** Note calibration observations in `groups/global/memory.md`.
- [ ] **Step 6:** Flip `PROACTIVE_ENABLED=true`. Restart. Live mode begins.

---

## Task 22.5: Log retention archiver

**Files:** Create `scripts/proactive/archive-old-logs.ts`, register as scheduled task.

- [ ] **Step 1: Write archiver**:

```ts
#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { getDb } from '../../src/db.js';
import { PROACTIVE_LOG_RETENTION_DAYS } from '../../src/config.js';

const cutoff = new Date(Date.now() - PROACTIVE_LOG_RETENTION_DAYS * 86400_000).toISOString();
const db = getDb();
const rows = db.prepare('SELECT * FROM proactive_log WHERE timestamp < ?').all(cutoff);

if (rows.length === 0) { console.log('nothing to archive'); process.exit(0); }

const archiveDir = path.resolve('data/proactive/archive');
fs.mkdirSync(archiveDir, { recursive: true });
const month = new Date().toISOString().slice(0, 7);
const file = path.join(archiveDir, `${month}.jsonl`);
const stream = fs.createWriteStream(file, { flags: 'a' });
for (const r of rows) stream.write(JSON.stringify(r) + '\n');
stream.end();

db.prepare('DELETE FROM proactive_log WHERE timestamp < ?').run(cutoff);
console.log(`Archived ${rows.length} rows to ${file}`);
```

- [ ] **Step 2: Register via SQL** (one-liner on host):

```bash
bun -e 'const db = require("./src/db.js").getDb(); db.prepare(`INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, proactive) VALUES (?, ?, ?, ?, "cron", "0 3 * * *", ?, "active", ?, 0)`).run("proactive-log-archiver", "main", "", "bun run scripts/proactive/archive-old-logs.ts", new Date(Date.now()+60000).toISOString(), new Date().toISOString());'
```

- [ ] **Step 3: Commit** `feat(proactive): log archiver for 90d retention`.

---

## Self-Review Summary

**Spec coverage:** every requirement in the spec maps to a task (see header table above this section in the full checklist). `proactive-log-archiver` added as Task 22.5 after initial scan found the gap.

**Placeholder scan:** directional notes exist ("mirror the pattern used for QMD_URL" in Task 16; "use existing mount-allowlist helper" in Task 17). These are acceptable references to existing code, not TBD placeholders. No "TODO" / "implement later" / "write tests for the above" text.

**Type consistency:** `ProactiveSend`, `GovernorDecision`, `InsertLog`, `ProactiveLogRow`, `QmdEmailClient`, `ThreadMessage` are defined in their owning tasks and consistently referenced elsewhere. Snake_case for SQL columns vs camelCase for TS inputs is intentional and matches existing codebase conventions.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-proactive-claire.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
