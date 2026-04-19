# Cockpit Snapshot Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mac-side snapshot builder that reads NanoClaw state (SQLite, per-group/per-agent files, vault) and uploads a JSON snapshot plus a bundle of recently-edited vault pages to Cloudflare R2 every 30 minutes.

**Architecture:** A standalone Bun script (`scripts/cockpit/main.ts`) driven by a launchd plist. It queries `store/messages.db` directly (host-side, not through IPC), scans the vault via Bun's `fs.readdir({ recursive: true })`, derives the `Snapshot` type defined in the design spec, writes it to `/tmp/nanoclaw-snapshot.json`, and uploads to R2 via `@aws-sdk/client-s3`. Delta detection compares to `/tmp/nanoclaw-last-snapshot.json` so only changed vault pages are re-uploaded. No HTTP server, no always-on process.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `cron-parser` (already installed), `gray-matter`, `@aws-sdk/client-s3`, vitest for tests.

**Related:** Implements §1, §2, §3 (contract only), §5, §6, §7 (push mechanism only), §Security, §Error handling of `docs/superpowers/specs/2026-04-19-web-cockpit-design.md`. Excluded: Worker, Pages site, PWA (Plans B and C).

---

## File Structure

Files this plan creates or modifies. Each has one responsibility.

### New files

| Path | Responsibility |
|---|---|
| `scripts/cockpit/config.ts` | Runtime config: vault path, allowlists, R2 env vars, schema version constant. |
| `scripts/cockpit/types.ts` | `Snapshot`, `VaultNode`, `WatchlistItem` TS types mirroring the spec schema. |
| `scripts/cockpit/sql.ts` | All SQLite queries used by the builder (groups, tasks, sessions, messages aggregation). |
| `scripts/cockpit/vault-scan.ts` | Recursive vault scan respecting the allowlist; returns tree plus flat recent-edit list. |
| `scripts/cockpit/watchlist-parser.ts` | Parses `## Watchlist` section from agent memory.md files and per-group bookmarks/watchlist files. |
| `scripts/cockpit/papers-log.ts` | Reads `data/cockpit/papers-evaluated.jsonl` into `ingestion.papers`. |
| `scripts/cockpit/emails-log.ts` | Reads `scripts/sync/gmail-sync-state.json` into `ingestion.emails`. |
| `scripts/cockpit/blogs.ts` | Reads `data/cockpit/blogs.json` into `snapshot.blogs` (or null). |
| `scripts/cockpit/priorities.ts` | Parses `groups/global/state/current.md` "Top 3" section into `priorities[]`. |
| `scripts/cockpit/cron-humanize.ts` | 5-field crontab to human-readable string with fallback on parse failure. |
| `scripts/cockpit/delta.ts` | Loads previous snapshot; computes changed vault pages since last run. |
| `scripts/cockpit/r2.ts` | Upload a single object (text or bytes) to R2 via `@aws-sdk/client-s3`, with one retry on 5xx. |
| `scripts/cockpit/build-snapshot.ts` | Orchestrator function: calls every module above, returns a `Snapshot`. |
| `scripts/cockpit/main.ts` | CLI entrypoint. Loads env, opens the real DB, calls the orchestrator, uploads to R2. |
| `scripts/cockpit/*.test.ts` | Co-located vitest specs for each module. |
| `launchd/com.nanoclaw.cockpit.plist` | launchd plist, `StartInterval=1800`. |

### Modified files

| Path | Change |
|---|---|
| `package.json` | Add dependencies: `@aws-sdk/client-s3`, `gray-matter`. (`cron-parser` already present.) |
| `.env.example` | Document `COCKPIT_R2_ENDPOINT`, `COCKPIT_R2_BUCKET`, `COCKPIT_R2_TOKEN`, `COCKPIT_VAULT_PATH`. |

The builder is intentionally small modules with narrow responsibilities. No module is larger than ~150 LOC. Each is independently testable.

---

## Task 0: Prep — dependencies, directory scaffolding, env vars

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `scripts/cockpit/` (empty dir)
- Create: `data/cockpit/` (empty dir, gitignored)

- [ ] **Step 1: Add runtime dependencies**

```bash
bun add @aws-sdk/client-s3 gray-matter
```

Expected: `package.json` gains `@aws-sdk/client-s3` and `gray-matter`. `cron-parser` is already at `5.5.0` per existing dependencies.

- [ ] **Step 2: Create cockpit script directory**

```bash
mkdir -p scripts/cockpit data/cockpit
```

- [ ] **Step 3: Add .env.example entries**

Append to `.env.example`:

```
# --- Cockpit (web dashboard) ---
COCKPIT_VAULT_PATH=/Volumes/sandisk4TB/marvin-vault
COCKPIT_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
COCKPIT_R2_BUCKET=nanoclaw-cockpit
COCKPIT_R2_TOKEN=<scoped-put-only-token>
```

- [ ] **Step 4: Verify vitest discovers `scripts/cockpit/*.test.ts`**

Check `vitest.config.ts` already includes `scripts/**/*.test.ts`. Create a throwaway `scripts/cockpit/smoke.test.ts` with `it('smoke', () => expect(1).toBe(1))`, run `bun run test`, confirm it runs, then delete the file.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock .env.example
git commit -m "feat(cockpit): add deps and scaffolding for snapshot builder"
```

---

## Task 1: Types and config

**Files:**
- Create: `scripts/cockpit/types.ts`
- Create: `scripts/cockpit/config.ts`

- [ ] **Step 1: Write types.ts**

```typescript
// scripts/cockpit/types.ts
// Schema version. Bump when Snapshot shape changes in a breaking way.
export const SCHEMA_VERSION = 1;

export interface Snapshot {
  generated_at: string;
  schema_version: number;
  groups: GroupSnapshot[];
  tasks: TaskSnapshot[];
  ingestion: IngestionSnapshot;
  watchlists: WatchlistGroup[];
  blogs: BlogItem[] | null;
  priorities: string[];
  vault_tree: VaultNode;
  vault_pages_available: string[];
}

export interface GroupSnapshot {
  folder: string;
  display_name: string;
  last_active_at: string | null;
  messages_24h: number;
}

export interface TaskSnapshot {
  id: string;
  group: string;
  name: string;
  schedule_raw: string;
  schedule_human: string;
  last_run: string | null;
  last_status: 'success' | 'error' | 'skipped' | null;
  last_result_excerpt: string | null;
  next_run: string | null;
  success_7d: [number, number];
  consecutive_failures: number;
}

export interface IngestionSnapshot {
  emails: IngestionEmails;
  papers: IngestionPapers;
  vault: IngestionVault;
}

export interface IngestionEmails {
  count_24h: number;
  last_at: string | null;
  recent: Array<{ subject: string; from: string; at: string }>;
}

export interface IngestionPapers {
  count_24h: number;
  last_at: string | null;
  recent: Array<{ title: string; authors: string; at: string; verdict?: 'ADOPT' | 'STEAL' | 'SKIP'; url?: string }>;
}

export interface IngestionVault {
  count_24h: number;
  last_at: string | null;
  recent: Array<{ path: string; title: string; at: string; kind: VaultKind }>;
}

export type VaultKind = 'paper' | 'synthesis' | 'tool' | 'daily' | 'wiki' | 'inbox' | 'other';

export interface WatchlistGroup {
  scope: 'group' | 'agent';
  scope_name: string;
  items: WatchlistItem[];
}

export interface WatchlistItem {
  title: string;
  url?: string;
  note?: string;
  added_at?: string;
}

export interface BlogItem {
  source: string;
  title: string;
  url: string;
  published_at: string;
  summary?: string;
}

export interface VaultNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  children?: VaultNode[];
  edited_at?: string;
}
```

- [ ] **Step 2: Write config.ts**

```typescript
// scripts/cockpit/config.ts
import path from 'path';

export const VAULT_PATH = process.env.COCKPIT_VAULT_PATH ?? '/Volumes/sandisk4TB/marvin-vault';

export const R2_ENDPOINT = process.env.COCKPIT_R2_ENDPOINT ?? '';
export const R2_BUCKET = process.env.COCKPIT_R2_BUCKET ?? '';
export const R2_TOKEN = process.env.COCKPIT_R2_TOKEN ?? '';

// Project root detection: script lives at scripts/cockpit/<file>.ts.
// import.meta.dir is the directory of the current file under Bun.
export const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..');

export const SNAPSHOT_PATH = '/tmp/nanoclaw-snapshot.json';
export const LAST_SNAPSHOT_PATH = '/tmp/nanoclaw-last-snapshot.json';

// Allowlist for the vault scanner. Dirs not in this list are invisible to the builder.
// 'ALWAYS' = bundle every file regardless of mtime.
// 'RECENT' = bundle only files with mtime in the last 7 days.
export interface AllowlistEntry { root: string; mode: 'ALWAYS' | 'RECENT' }

export const VAULT_ALLOWLIST: AllowlistEntry[] = [
  { root: '99-wiki',     mode: 'ALWAYS' },
  { root: '80-resources', mode: 'ALWAYS' },
  { root: '00-inbox',    mode: 'RECENT' },
  { root: '70-areas',    mode: 'RECENT' },
  { root: '10-daily',    mode: 'RECENT' },  // vault-scan excludes 10-daily/meetings/
];

// Paths relative to VAULT_PATH that are ALWAYS excluded regardless of allowlist.
export const VAULT_HARD_EXCLUDES: string[] = [
  '10-daily/meetings',
];

export const RECENT_WINDOW_DAYS = 7;

// Cap all recent[] arrays to prevent unbounded snapshot size.
export const RECENT_ARRAY_CAP = 20;
```

- [ ] **Step 3: Commit**

```bash
git add scripts/cockpit/types.ts scripts/cockpit/config.ts
git commit -m "feat(cockpit): types and runtime config"
```

---

## Task 2: Cron humanizer with graceful fallback

**Files:**
- Create: `scripts/cockpit/cron-humanize.ts`
- Create: `scripts/cockpit/cron-humanize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/cron-humanize.test.ts
import { describe, it, expect } from 'vitest';
import { humanizeCron } from './cron-humanize.js';

describe('humanizeCron', () => {
  it('produces a readable string for a standard 5-field cron', () => {
    const result = humanizeCron('0 9 * * 1-5');
    expect(result).toMatch(/9/);
    expect(result).not.toBe('0 9 * * 1-5');
  });

  it('falls back to the raw string for malformed 7-token input', () => {
    const malformed = '0 0 8,11,14,17,20 * * 1-5';
    expect(humanizeCron(malformed)).toBe(malformed);
  });

  it('falls back to the raw string for unparseable garbage', () => {
    expect(humanizeCron('not a cron')).toBe('not a cron');
  });

  it('handles multi-hour step crons', () => {
    const result = humanizeCron('0 */2 * * *');
    expect(result).not.toBe('0 */2 * * *');
  });
});
```

- [ ] **Step 2: Run the test; confirm it fails**

```bash
bun --bun vitest run scripts/cockpit/cron-humanize.test.ts
```

Expected: fails with "Cannot find module './cron-humanize.js'" or similar.

- [ ] **Step 3: Implement `cron-humanize.ts`**

```typescript
// scripts/cockpit/cron-humanize.ts
import { CronExpressionParser } from 'cron-parser';

/**
 * Convert a 5-field POSIX cron string to a human-readable description.
 * Returns the raw string unchanged if parsing fails (one known row in
 * scheduled_tasks has a malformed 7-token value).
 */
export function humanizeCron(raw: string): string {
  try {
    const parts = raw.trim().split(/\s+/);
    if (parts.length !== 5) return raw;

    const [minute, hour, dom, month, dow] = parts;
    CronExpressionParser.parse(raw);

    const dowDesc = describeDow(dow);
    const hourDesc = describeTime(hour, minute);
    const domDesc = dom === '*' ? '' : ` on day ${dom}`;
    const monthDesc = month === '*' ? '' : ` in month ${month}`;

    return [hourDesc, dowDesc, domDesc, monthDesc].filter(Boolean).join(' ');
  } catch {
    return raw;
  }
}

function describeDow(dow: string): string {
  if (dow === '*') return 'every day';
  if (dow === '1-5') return 'weekdays';
  if (dow === '0,6' || dow === '6,0') return 'weekends';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const singleNum = /^\d$/.test(dow);
  if (singleNum) return `on ${names[parseInt(dow, 10)] ?? dow}`;
  return `on days ${dow}`;
}

function describeTime(hour: string, minute: string): string {
  if (hour === '*' && minute === '*') return 'every minute';
  if (hour === '*') return `at :${minute.padStart(2, '0')} past every hour`;
  if (hour.startsWith('*/')) return `every ${hour.slice(2)}h`;
  if (hour.includes(',')) return `at hours ${hour}`;
  const hh = hour.padStart(2, '0');
  const mm = (minute === '*' ? '00' : minute).padStart(2, '0');
  return `at ${hh}:${mm}`;
}
```

- [ ] **Step 4: Run the test; confirm it passes**

```bash
bun --bun vitest run scripts/cockpit/cron-humanize.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/cron-humanize.ts scripts/cockpit/cron-humanize.test.ts
git commit -m "feat(cockpit): cron humanizer with graceful fallback"
```

---

## Task 3: Watchlist parser

**Files:**
- Create: `scripts/cockpit/watchlist-parser.ts`
- Create: `scripts/cockpit/watchlist-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/watchlist-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseWatchlistBullets, extractSection } from './watchlist-parser.js';

describe('parseWatchlistBullets', () => {
  it('parses title + url + note', () => {
    const input = '- [Paper: Smith et al 2026](https://arxiv.org/abs/1234) — added 2026-04-18';
    const [item] = parseWatchlistBullets(input);
    expect(item.title).toBe('Paper: Smith et al 2026');
    expect(item.url).toBe('https://arxiv.org/abs/1234');
    expect(item.note).toBe('added 2026-04-18');
  });

  it('parses title + url only (no note)', () => {
    const input = '- [Tool: polars-bio](https://github.com/x/polars-bio)';
    const [item] = parseWatchlistBullets(input);
    expect(item.title).toBe('Tool: polars-bio');
    expect(item.url).toBe('https://github.com/x/polars-bio');
    expect(item.note).toBeUndefined();
  });

  it('parses plain text bullet (no url)', () => {
    const input = '- A note without a link';
    const [item] = parseWatchlistBullets(input);
    expect(item.title).toBe('A note without a link');
    expect(item.url).toBeUndefined();
    expect(item.note).toBeUndefined();
  });

  it('ignores nested bullets and non-bullet lines', () => {
    const input = [
      '- Top level',
      '  - Nested should be ignored',
      'Non-bullet line',
      '- Second top-level',
    ].join('\n');
    const items = parseWatchlistBullets(input);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Top level');
    expect(items[1].title).toBe('Second top-level');
  });

  it('returns empty array for empty input', () => {
    expect(parseWatchlistBullets('')).toEqual([]);
  });
});

describe('extractSection', () => {
  it('extracts only the named section body', () => {
    const md = [
      '# Memory',
      '## Standing Instructions',
      '- Be concise',
      '',
      '## Watchlist',
      '- [Item A](http://a)',
      '- [Item B](http://b)',
      '',
      '## Session Continuity',
      '- something else',
    ].join('\n');
    const body = extractSection(md, 'Watchlist');
    expect(body).toContain('[Item A](http://a)');
    expect(body).toContain('[Item B](http://b)');
    expect(body).not.toContain('Be concise');
    expect(body).not.toContain('something else');
  });

  it('returns null for missing section', () => {
    const md = '## Standing Instructions\n- Be concise';
    expect(extractSection(md, 'Watchlist')).toBeNull();
  });

  it('returns empty string for section with no body', () => {
    const md = '## Watchlist\n\n## Next Section\n- x';
    expect(extractSection(md, 'Watchlist')).toBe('');
  });
});
```

- [ ] **Step 2: Run; confirm fail**

```bash
bun --bun vitest run scripts/cockpit/watchlist-parser.test.ts
```

- [ ] **Step 3: Implement `watchlist-parser.ts`**

```typescript
// scripts/cockpit/watchlist-parser.ts
import type { WatchlistItem } from './types.js';

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const EMDASH_SEP = ' — ';  // em-dash with spaces on both sides

/**
 * Extract the body (lines following a heading) of a specific section from markdown.
 * Section is matched case-insensitively on the heading name (## HeadingName).
 * Returns null if section not found. Returns empty string if section exists but is empty.
 */
export function extractSection(md: string, sectionName: string): string | null {
  const lines = md.split('\n');
  const headingRe = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const nextHeadingRe = /^##\s+/;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return null;

  const body: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/**
 * Parse top-level markdown bullets into WatchlistItems.
 * Rules (from spec §6):
 *   - One item per top-level bullet (`- ` at column 0)
 *   - First [text](url) match on line → title + url
 *   - If no [text](url) → remainder of line becomes title, no url
 *   - Everything after first " — " → note
 *   - Nested bullets, YAML frontmatter, non-bullet lines: ignored
 */
export function parseWatchlistBullets(body: string): WatchlistItem[] {
  const items: WatchlistItem[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const content = line.slice(2);
    items.push(parseOne(content));
  }
  return items;
}

function parseOne(content: string): WatchlistItem {
  const sepIdx = content.indexOf(EMDASH_SEP);
  const head = sepIdx === -1 ? content : content.slice(0, sepIdx);
  const note = sepIdx === -1 ? undefined : content.slice(sepIdx + EMDASH_SEP.length).trim();

  const linkMatch = head.match(LINK_RE);
  if (linkMatch) {
    return {
      title: linkMatch[1].trim(),
      url: linkMatch[2].trim(),
      ...(note ? { note } : {}),
    };
  }
  return {
    title: head.trim(),
    ...(note ? { note } : {}),
  };
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/watchlist-parser.test.ts
```

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/watchlist-parser.ts scripts/cockpit/watchlist-parser.test.ts
git commit -m "feat(cockpit): watchlist + section extractor"
```

---

## Task 4: Papers log reader

**Files:**
- Create: `scripts/cockpit/papers-log.ts`
- Create: `scripts/cockpit/papers-log.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/papers-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readPapersLog } from './papers-log.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `papers-${Date.now()}.jsonl`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('readPapersLog', () => {
  it('returns empty structure when file is absent', () => {
    const result = readPapersLog('/nonexistent/path.jsonl', new Date('2026-04-19T12:00:00Z'));
    expect(result.count_24h).toBe(0);
    expect(result.last_at).toBeNull();
    expect(result.recent).toEqual([]);
  });

  it('reads lines in chronological order and returns recent-first', () => {
    fs.writeFileSync(tmpFile, [
      '{"evaluated_at":"2026-04-18T10:00:00Z","title":"Paper A","authors":"A et al","verdict":"ADOPT"}',
      '{"evaluated_at":"2026-04-19T08:00:00Z","title":"Paper B","authors":"B et al","verdict":"STEAL"}',
      '',
      '{"evaluated_at":"2026-04-19T11:00:00Z","title":"Paper C","authors":"C et al","verdict":"SKIP","url":"http://c"}',
    ].join('\n'));
    const now = new Date('2026-04-19T12:00:00Z');
    const result = readPapersLog(tmpFile, now);
    expect(result.recent).toHaveLength(3);
    expect(result.recent[0].title).toBe('Paper C');
    expect(result.recent[2].title).toBe('Paper A');
    expect(result.count_24h).toBe(2);
    expect(result.last_at).toBe('2026-04-19T11:00:00Z');
  });

  it('caps recent[] at 20 items', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({ evaluated_at: `2026-04-${String(19 - (i % 10)).padStart(2, '0')}T10:00:00Z`, title: `Paper ${i}`, authors: 'x', verdict: 'SKIP' }));
    }
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = readPapersLog(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(result.recent).toHaveLength(20);
  });

  it('skips lines that fail to parse', () => {
    fs.writeFileSync(tmpFile, [
      '{"evaluated_at":"2026-04-19T11:00:00Z","title":"Good","authors":"x","verdict":"ADOPT"}',
      'not json at all',
      '{"no_date":true}',
    ].join('\n'));
    const result = readPapersLog(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0].title).toBe('Good');
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/papers-log.test.ts
```

- [ ] **Step 3: Implement `papers-log.ts`**

```typescript
// scripts/cockpit/papers-log.ts
import fs from 'fs';
import type { IngestionPapers } from './types.js';
import { RECENT_ARRAY_CAP } from './config.js';

interface RawEntry {
  evaluated_at: string;
  title: string;
  authors: string;
  verdict?: 'ADOPT' | 'STEAL' | 'SKIP';
  url?: string;
}

export function readPapersLog(jsonlPath: string, now: Date): IngestionPapers {
  if (!fs.existsSync(jsonlPath)) {
    return { count_24h: 0, last_at: null, recent: [] };
  }
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const entries: RawEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<RawEntry>;
      if (typeof obj.evaluated_at !== 'string' || typeof obj.title !== 'string' || typeof obj.authors !== 'string') continue;
      entries.push(obj as RawEntry);
    } catch {
      // malformed line — skip
    }
  }
  entries.sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at));
  const recent = entries.slice(0, RECENT_ARRAY_CAP).map(e => ({
    title: e.title,
    authors: e.authors,
    at: e.evaluated_at,
    ...(e.verdict ? { verdict: e.verdict } : {}),
    ...(e.url ? { url: e.url } : {}),
  }));
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
  const count_24h = entries.filter(e => new Date(e.evaluated_at) > cutoff).length;
  const last_at = entries[0]?.evaluated_at ?? null;
  return { count_24h, last_at, recent };
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/papers-log.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/papers-log.ts scripts/cockpit/papers-log.test.ts
git commit -m "feat(cockpit): papers-evaluated.jsonl reader"
```

---

## Task 5: Emails state reader (best-effort)

**Files:**
- Create: `scripts/cockpit/emails-log.ts`
- Create: `scripts/cockpit/emails-log.test.ts`

The `scripts/sync/gmail-sync-state.json` format is authoritative; implementation is best-effort and may evolve as that file gains fields.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/emails-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readEmailsState } from './emails-log.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `emails-${Date.now()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('readEmailsState', () => {
  it('returns zeros when file is missing', () => {
    const r = readEmailsState('/nonexistent.json', new Date('2026-04-19T12:00:00Z'));
    expect(r.count_24h).toBe(0);
    expect(r.last_at).toBeNull();
    expect(r.recent).toEqual([]);
  });

  it('derives last_at from last_epoch when present', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      last_epoch: Math.floor(new Date('2026-04-19T11:00:00Z').getTime() / 1000),
      synced_ids: ['id1', 'id2', 'id3'],
    }));
    const r = readEmailsState(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(r.last_at).toBe('2026-04-19T11:00:00.000Z');
    expect(r.count_24h).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(r.recent)).toBe(true);
  });

  it('handles malformed JSON gracefully', () => {
    fs.writeFileSync(tmpFile, 'not json');
    const r = readEmailsState(tmpFile, new Date('2026-04-19T12:00:00Z'));
    expect(r.count_24h).toBe(0);
    expect(r.last_at).toBeNull();
    expect(r.recent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/emails-log.test.ts
```

- [ ] **Step 3: Implement `emails-log.ts`**

```typescript
// scripts/cockpit/emails-log.ts
import fs from 'fs';
import type { IngestionEmails } from './types.js';

interface State {
  last_epoch?: number;
  synced_ids?: string[];
}

export function readEmailsState(jsonPath: string, _now: Date): IngestionEmails {
  if (!fs.existsSync(jsonPath)) {
    return { count_24h: 0, last_at: null, recent: [] };
  }
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const state = JSON.parse(raw) as State;
    const last_at = state.last_epoch ? new Date(state.last_epoch * 1000).toISOString() : null;
    const count_24h = state.synced_ids?.length ?? 0;
    // Per-email subject/from data is not currently stored in state; future improvement.
    return { count_24h, last_at, recent: [] };
  } catch {
    return { count_24h: 0, last_at: null, recent: [] };
  }
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/emails-log.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/emails-log.ts scripts/cockpit/emails-log.test.ts
git commit -m "feat(cockpit): emails state reader (best-effort)"
```

---

## Task 6: Blogs reader

**Files:**
- Create: `scripts/cockpit/blogs.ts`
- Create: `scripts/cockpit/blogs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/blogs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readBlogs } from './blogs.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `blogs-${Date.now()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('readBlogs', () => {
  it('returns null when file is missing (surface hidden)', () => {
    expect(readBlogs('/nonexistent.json')).toBeNull();
  });

  it('returns [] when file exists but is empty array (configured, no items)', () => {
    fs.writeFileSync(tmpFile, '[]');
    expect(readBlogs(tmpFile)).toEqual([]);
  });

  it('returns parsed items for well-formed input', () => {
    const items = [
      { source: 'Anthropic', title: 'Release', url: 'https://x', published_at: '2026-04-18T00:00:00Z' },
    ];
    fs.writeFileSync(tmpFile, JSON.stringify(items));
    expect(readBlogs(tmpFile)).toEqual(items);
  });

  it('returns null for malformed JSON', () => {
    fs.writeFileSync(tmpFile, 'not json');
    expect(readBlogs(tmpFile)).toBeNull();
  });

  it('returns null if file contains non-array JSON', () => {
    fs.writeFileSync(tmpFile, '{"oops": "object not array"}');
    expect(readBlogs(tmpFile)).toBeNull();
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/blogs.test.ts
```

- [ ] **Step 3: Implement `blogs.ts`**

```typescript
// scripts/cockpit/blogs.ts
import fs from 'fs';
import type { BlogItem } from './types.js';

export function readBlogs(jsonPath: string): BlogItem[] | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as BlogItem[];
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/blogs.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/blogs.ts scripts/cockpit/blogs.test.ts
git commit -m "feat(cockpit): blogs.json reader"
```

---

## Task 7: Priorities parser

**Files:**
- Create: `scripts/cockpit/priorities.ts`
- Create: `scripts/cockpit/priorities.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/priorities.test.ts
import { describe, it, expect } from 'vitest';
import { parsePriorities } from './priorities.js';

describe('parsePriorities', () => {
  it('extracts numbered items from a Top 3 section', () => {
    const md = [
      '# Current',
      '## Top 3',
      '1. Miao Tang hire',
      '2. Nature Genetics review',
      '3. Emma ABCD manuscript',
      '',
      '## Other',
      'Not in priorities',
    ].join('\n');
    expect(parsePriorities(md)).toEqual([
      'Miao Tang hire',
      'Nature Genetics review',
      'Emma ABCD manuscript',
    ]);
  });

  it('handles Top 5 or Top N by matching heading with digit', () => {
    const md = '## Top 5\n1. A\n2. B\n3. C\n4. D\n5. E';
    expect(parsePriorities(md)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('returns empty array if no Top N section found', () => {
    expect(parsePriorities('# Current\nNothing here')).toEqual([]);
  });

  it('stops at next heading', () => {
    const md = '## Top 3\n1. A\n2. B\n## Next\n1. Ignored';
    expect(parsePriorities(md)).toEqual(['A', 'B']);
  });

  it('ignores non-numbered lines inside the section', () => {
    const md = '## Top 3\n1. First\nnote in between\n2. Second';
    expect(parsePriorities(md)).toEqual(['First', 'Second']);
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/priorities.test.ts
```

- [ ] **Step 3: Implement `priorities.ts`**

```typescript
// scripts/cockpit/priorities.ts
const TOP_HEADING_RE = /^##\s+Top\s+\d+\s*$/i;
const NEXT_HEADING_RE = /^##\s+/;
const NUMBERED_ITEM_RE = /^\d+\.\s+(.+)$/;

export function parsePriorities(md: string): string[] {
  const lines = md.split('\n');
  let inSection = false;
  const items: string[] = [];
  for (const line of lines) {
    if (inSection && NEXT_HEADING_RE.test(line)) break;
    if (TOP_HEADING_RE.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    const m = line.match(NUMBERED_ITEM_RE);
    if (m) items.push(m[1].trim());
  }
  return items;
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/priorities.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/priorities.ts scripts/cockpit/priorities.test.ts
git commit -m "feat(cockpit): current.md Top-N parser"
```

---

## Task 8: SQL queries

**Files:**
- Create: `scripts/cockpit/sql.ts`
- Create: `scripts/cockpit/sql.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/sql.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { getGroupsWithActivity, getTasksWithStatus } from './sql.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
      container_config TEXT, requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0,
      permitted_senders TEXT
    );
    CREATE TABLE sessions (
      group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      last_used TEXT, created_at TEXT
    );
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT,
      channel TEXT, is_group INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT,
      timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
      reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated',
      script TEXT, agent_name TEXT, surface_outputs INTEGER DEFAULT 0, proactive INTEGER DEFAULT 0
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
      result TEXT, error TEXT, outcome_emitted INTEGER DEFAULT 0
    );
  `);
});

afterEach(() => { db.close(); });

describe('getGroupsWithActivity', () => {
  it('aggregates per-group last_active from compound session keys', () => {
    db.run("INSERT INTO registered_groups VALUES ('c1@g','CLAIRE','telegram_claire','','2026-01-01',NULL,0,1,NULL)");
    db.run("INSERT INTO sessions VALUES ('telegram_claire','sess1','2026-04-18T10:00:00Z','2026-04-01')");
    db.run("INSERT INTO sessions VALUES ('telegram_claire:jennifer','sess2','2026-04-19T11:00:00Z','2026-04-15')");
    db.run("INSERT INTO sessions VALUES ('telegram_claire:claire','sess3','2026-04-19T09:00:00Z','2026-04-10')");
    db.run("INSERT INTO chats VALUES ('c1@g','CLAIRE',NULL,'telegram',1)");
    db.run("INSERT INTO messages VALUES ('m1','c1@g','u','U','hi','2026-04-19T11:30:00Z',1,0,NULL,NULL,NULL)");

    const now = new Date('2026-04-19T12:00:00Z');
    const rows = getGroupsWithActivity(db, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].folder).toBe('telegram_claire');
    expect(rows[0].display_name).toBe('CLAIRE');
    expect(rows[0].last_active_at).toBe('2026-04-19T11:00:00Z');
    expect(rows[0].messages_24h).toBe(1);
  });

  it('returns null last_active when no sessions match', () => {
    db.run("INSERT INTO registered_groups VALUES ('c1@g','G','telegram_science-claw','','2026-01-01',NULL,0,0,NULL)");
    db.run("INSERT INTO chats VALUES ('c1@g','G',NULL,'telegram',1)");
    const now = new Date('2026-04-19T12:00:00Z');
    const [row] = getGroupsWithActivity(db, now);
    expect(row.last_active_at).toBeNull();
    expect(row.messages_24h).toBe(0);
  });
});

describe('getTasksWithStatus', () => {
  it('returns tasks with status from latest task_run_logs row', () => {
    db.run("INSERT INTO scheduled_tasks (id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,last_run,last_result,status,created_at,context_mode,agent_name) VALUES ('t1','telegram_claire','c1@g','Do a thing','cron','0 9 * * 1-5','2026-04-20T09:00:00Z','2026-04-19T09:00:00Z','All good','active','2026-04-01','group','claire')");
    db.run("INSERT INTO task_run_logs (task_id,run_at,duration_ms,status,result) VALUES ('t1','2026-04-17T09:00:00Z',1000,'error',NULL)");
    db.run("INSERT INTO task_run_logs (task_id,run_at,duration_ms,status,result) VALUES ('t1','2026-04-18T09:00:00Z',1000,'success',NULL)");
    db.run("INSERT INTO task_run_logs (task_id,run_at,duration_ms,status,result) VALUES ('t1','2026-04-19T09:00:00Z',1000,'success','All good')");

    const rows = getTasksWithStatus(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t1');
    expect(rows[0].last_status).toBe('success');
    expect(rows[0].success_7d).toEqual([2, 3]);
  });

  it('handles task with no run logs', () => {
    db.run("INSERT INTO scheduled_tasks (id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,last_run,last_result,status,created_at,context_mode) VALUES ('t2','g','c@g','p','cron','0 * * * *',NULL,NULL,NULL,'active','2026-04-01','group')");
    const [row] = getTasksWithStatus(db);
    expect(row.last_status).toBeNull();
    expect(row.success_7d).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/sql.test.ts
```

- [ ] **Step 3: Implement `sql.ts`**

```typescript
// scripts/cockpit/sql.ts
import type { Database } from 'bun:sqlite';

export interface GroupRow {
  folder: string;
  display_name: string;
  last_active_at: string | null;
  messages_24h: number;
}

export interface TaskRow {
  id: string;
  group: string;
  prompt: string;
  agent_name: string | null;
  schedule_value: string;
  last_run: string | null;
  last_result: string | null;
  next_run: string | null;
  last_status: 'success' | 'error' | 'skipped' | null;
  success_7d: [number, number];
}

const MS_PER_DAY = 24 * 3600 * 1000;

export function getGroupsWithActivity(db: Database, now: Date): GroupRow[] {
  const cutoff24h = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const groups = db
    .prepare('SELECT folder, name, jid FROM registered_groups')
    .all() as Array<{ folder: string; name: string; jid: string }>;

  const result: GroupRow[] = [];
  for (const g of groups) {
    const sessionRow = db
      .prepare(
        `SELECT MAX(last_used) AS last_active FROM sessions WHERE group_folder = ? OR group_folder LIKE ?`,
      )
      .get(g.folder, `${g.folder}:%`) as { last_active: string | null };

    const msgRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE chat_jid = ? AND timestamp > ?`,
      )
      .get(g.jid, cutoff24h) as { c: number };

    result.push({
      folder: g.folder,
      display_name: g.name ?? prettify(g.folder),
      last_active_at: sessionRow.last_active ?? null,
      messages_24h: msgRow.c,
    });
  }
  return result;
}

export function getTasksWithStatus(db: Database): TaskRow[] {
  const tasks = db
    .prepare(
      `SELECT id, group_folder, prompt, agent_name, schedule_value, last_run, last_result, next_run
       FROM scheduled_tasks
       WHERE status = 'active'`,
    )
    .all() as Array<{
      id: string; group_folder: string; prompt: string; agent_name: string | null;
      schedule_value: string; last_run: string | null; last_result: string | null;
      next_run: string | null;
    }>;

  const rows: TaskRow[] = [];
  const cutoff7d = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();

  for (const t of tasks) {
    const latest = db
      .prepare(
        `SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 1`,
      )
      .get(t.id) as { status: 'success' | 'error' | 'skipped' } | undefined;

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok
         FROM task_run_logs WHERE task_id = ? AND run_at > ?`,
      )
      .get(t.id, cutoff7d) as { total: number; ok: number };

    rows.push({
      id: t.id,
      group: t.group_folder,
      prompt: t.prompt,
      agent_name: t.agent_name,
      schedule_value: t.schedule_value,
      last_run: t.last_run,
      last_result: t.last_result,
      next_run: t.next_run,
      last_status: latest?.status ?? null,
      success_7d: [totals.ok ?? 0, totals.total ?? 0],
    });
  }
  return rows;
}

function prettify(folder: string): string {
  return folder
    .replace(/^telegram_/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/sql.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/sql.ts scripts/cockpit/sql.test.ts
git commit -m "feat(cockpit): SQL queries for groups + tasks"
```

---

## Task 9: Vault scanner

**Files:**
- Create: `scripts/cockpit/vault-scan.ts`
- Create: `scripts/cockpit/vault-scan.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/vault-scan.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanVault } from './vault-scan.js';

let tmpVault: string;

function writeFile(rel: string, body: string, mtime?: Date) {
  const abs = path.join(tmpVault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  if (mtime) fs.utimesSync(abs, mtime, mtime);
}

beforeEach(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
});

afterEach(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

describe('scanVault', () => {
  it('includes only allowlisted roots', () => {
    writeFile('99-wiki/tools/polars-bio.md', '# polars-bio');
    writeFile('30-lab/secret.md', '# secret');
    writeFile('_media/image.png', 'bytes');

    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);

    const names = result.tree.children?.map(c => c.name) ?? [];
    expect(names).toContain('99-wiki');
    expect(names).not.toContain('30-lab');
    expect(names).not.toContain('_media');
  });

  it('includes all 99-wiki files regardless of mtime (ALWAYS mode)', () => {
    const oldMtime = new Date('2024-01-01T00:00:00Z');
    writeFile('99-wiki/tools/old.md', '# old', oldMtime);
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);

    expect(result.bundle.map(b => b.slug)).toContain('99-wiki%2Ftools%2Fold');
  });

  it('filters RECENT-mode folders by mtime', () => {
    const oldMtime = new Date('2026-04-10T00:00:00Z');
    const freshMtime = new Date('2026-04-18T00:00:00Z');
    writeFile('10-daily/journal.md', 'body', oldMtime);
    writeFile('10-daily/fresh.md', 'body', freshMtime);
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);

    const slugs = result.bundle.map(b => b.slug);
    expect(slugs).toContain('10-daily%2Ffresh');
    expect(slugs).not.toContain('10-daily%2Fjournal');
  });

  it('excludes 10-daily/meetings per HARD_EXCLUDES', () => {
    writeFile('10-daily/meetings/sync.md', '# meeting notes');
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);
    expect(result.bundle.every(b => !b.slug.includes('meetings'))).toBe(true);
  });

  it('returns recent[] sorted by edited_at descending, capped at 20', () => {
    for (let i = 0; i < 25; i++) {
      const d = new Date(`2026-04-${String(19 - i).padStart(2, '0')}T12:00:00Z`);
      writeFile(`99-wiki/tools/tool-${i}.md`, `# tool ${i}`, d);
    }
    const now = new Date('2026-04-19T13:00:00Z');
    const result = scanVault(tmpVault, now);
    expect(result.recent).toHaveLength(20);
    expect(result.recent[0].title).toBe('tool 0');
  });

  it('parses frontmatter title if present', () => {
    writeFile('99-wiki/papers/smith.md', '---\ntitle: Custom Title\n---\n# Heading');
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);
    const smith = result.recent.find(r => r.path.includes('smith'));
    expect(smith?.title).toBe('Custom Title');
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/vault-scan.test.ts
```

- [ ] **Step 3: Implement `vault-scan.ts`**

```typescript
// scripts/cockpit/vault-scan.ts
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import type { VaultNode, VaultKind } from './types.js';
import {
  VAULT_ALLOWLIST,
  VAULT_HARD_EXCLUDES,
  RECENT_WINDOW_DAYS,
  RECENT_ARRAY_CAP,
} from './config.js';

const MS_PER_DAY = 24 * 3600 * 1000;

export interface VaultBundleEntry {
  slug: string;
  absPath: string;
  relPath: string;
}

export interface VaultScanResult {
  tree: VaultNode;
  recent: Array<{ path: string; title: string; at: string; kind: VaultKind }>;
  bundle: VaultBundleEntry[];
  count_24h: number;
  last_at: string | null;
}

interface FileEntry { rel: string; abs: string; mtime: Date }

export function scanVault(vaultRoot: string, now: Date): VaultScanResult {
  if (!fs.existsSync(vaultRoot)) {
    return { tree: { name: 'vault', path: '', kind: 'dir', children: [] }, recent: [], bundle: [], count_24h: 0, last_at: null };
  }

  const allEntries: FileEntry[] = [];
  for (const entry of VAULT_ALLOWLIST) {
    const rootAbs = path.join(vaultRoot, entry.root);
    if (!fs.existsSync(rootAbs)) continue;
    const files = collectFiles(rootAbs, vaultRoot);
    for (const f of files) {
      if (isHardExcluded(f.rel)) continue;
      allEntries.push(f);
    }
  }

  const bundle: VaultBundleEntry[] = [];
  const recentCutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * MS_PER_DAY);
  for (const f of allEntries) {
    const mode = getAllowlistMode(f.rel);
    if (mode === 'ALWAYS' || f.mtime > recentCutoff) {
      bundle.push({ slug: pathToSlug(f.rel), absPath: f.abs, relPath: f.rel });
    }
  }

  const sorted = [...allEntries].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const recent = sorted.slice(0, RECENT_ARRAY_CAP).map(f => ({
    path: f.rel,
    title: extractTitle(f.abs, f.rel),
    at: f.mtime.toISOString(),
    kind: inferKind(f.rel),
  }));

  const cutoff24h = new Date(now.getTime() - MS_PER_DAY);
  const count_24h = allEntries.filter(f => f.mtime > cutoff24h).length;
  const last_at = sorted[0]?.mtime.toISOString() ?? null;

  return { tree: buildTree(vaultRoot, allEntries), recent, bundle, count_24h, last_at };
}

function collectFiles(rootAbs: string, vaultRoot: string): FileEntry[] {
  const result: FileEntry[] = [];
  const entries = fs.readdirSync(rootAbs, { withFileTypes: true, recursive: true }) as unknown as Array<fs.Dirent & { parentPath?: string; path?: string }>;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const dir = (e.parentPath ?? e.path ?? rootAbs) as string;
    const abs = path.join(dir, e.name);
    const rel = path.relative(vaultRoot, abs);
    const stat = fs.statSync(abs);
    result.push({ rel, abs, mtime: stat.mtime });
  }
  return result;
}

function isHardExcluded(rel: string): boolean {
  return VAULT_HARD_EXCLUDES.some(excl => rel === excl || rel.startsWith(excl + path.sep));
}

function getAllowlistMode(rel: string): 'ALWAYS' | 'RECENT' {
  for (const entry of VAULT_ALLOWLIST) {
    if (rel === entry.root || rel.startsWith(entry.root + path.sep)) return entry.mode;
  }
  return 'RECENT';
}

function pathToSlug(rel: string): string {
  const noExt = rel.replace(/\.md$/, '');
  return encodeURIComponent(noExt);
}

function extractTitle(abs: string, rel: string): string {
  try {
    const raw = fs.readFileSync(abs, 'utf-8');
    const parsed = matter(raw);
    if (typeof parsed.data.title === 'string' && parsed.data.title.trim()) {
      return parsed.data.title.trim();
    }
    const h1Match = parsed.content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();
  } catch {
    // ignore
  }
  return path.basename(rel, '.md').replace(/-/g, ' ');
}

function inferKind(rel: string): VaultKind {
  if (rel.includes('99-wiki/papers')) return 'paper';
  if (rel.includes('99-wiki/syntheses')) return 'synthesis';
  if (rel.includes('99-wiki/tools')) return 'tool';
  if (rel.startsWith('99-wiki')) return 'wiki';
  if (rel.startsWith('00-inbox')) return 'inbox';
  if (rel.startsWith('10-daily')) return 'daily';
  return 'other';
}

function buildTree(vaultRoot: string, entries: FileEntry[]): VaultNode {
  const root: VaultNode = { name: path.basename(vaultRoot), path: '', kind: 'dir', children: [] };
  for (const e of entries) {
    insertPath(root, e.rel.split(path.sep), e.mtime.toISOString());
  }
  return root;
}

function insertPath(node: VaultNode, parts: string[], mtime: string): void {
  if (parts.length === 0) return;
  const [head, ...rest] = parts;
  node.children ??= [];
  let child = node.children.find(c => c.name === head);
  if (!child) {
    const isFile = rest.length === 0;
    child = isFile
      ? { name: head, path: joinPath(node.path, head), kind: 'file', edited_at: mtime }
      : { name: head, path: joinPath(node.path, head), kind: 'dir', children: [] };
    node.children.push(child);
  }
  if (rest.length > 0) insertPath(child, rest, mtime);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/vault-scan.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/vault-scan.ts scripts/cockpit/vault-scan.test.ts
git commit -m "feat(cockpit): vault scanner with allowlist + mtime filtering"
```

---

## Task 10: Delta tracker

**Files:**
- Create: `scripts/cockpit/delta.ts`
- Create: `scripts/cockpit/delta.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/delta.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadPreviousSnapshot, computeChangedBundle } from './delta.js';
import type { Snapshot } from './types.js';
import type { VaultBundleEntry } from './vault-scan.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `last-${Date.now()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('loadPreviousSnapshot', () => {
  it('returns null when file missing', () => {
    expect(loadPreviousSnapshot('/nope.json')).toBeNull();
  });

  it('returns parsed snapshot when valid', () => {
    const snap = { generated_at: '2026-04-19T10:00:00Z', schema_version: 1 } as Snapshot;
    fs.writeFileSync(tmpFile, JSON.stringify(snap));
    expect(loadPreviousSnapshot(tmpFile)?.generated_at).toBe('2026-04-19T10:00:00Z');
  });

  it('returns null for malformed JSON', () => {
    fs.writeFileSync(tmpFile, 'garbage');
    expect(loadPreviousSnapshot(tmpFile)).toBeNull();
  });
});

describe('computeChangedBundle', () => {
  const bundleEntry = (slug: string, absPath: string, relPath: string): VaultBundleEntry => ({ slug, absPath, relPath });

  it('returns all entries when no previous snapshot', () => {
    const full = [bundleEntry('a', '/x/a.md', 'a.md'), bundleEntry('b', '/x/b.md', 'b.md')];
    expect(computeChangedBundle(full, null, new Date())).toEqual(full);
  });

  it('returns only entries with mtime newer than last generated_at', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
    const oldFile = path.join(tmpDir, 'old.md');
    const newFile = path.join(tmpDir, 'new.md');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');
    fs.utimesSync(oldFile, new Date('2026-04-18T10:00:00Z'), new Date('2026-04-18T10:00:00Z'));
    fs.utimesSync(newFile, new Date('2026-04-19T12:00:00Z'), new Date('2026-04-19T12:00:00Z'));

    const full = [
      bundleEntry('old', oldFile, 'old.md'),
      bundleEntry('new', newFile, 'new.md'),
    ];
    const prev = { generated_at: '2026-04-19T00:00:00Z', schema_version: 1 } as Snapshot;
    const changed = computeChangedBundle(full, prev, new Date());
    expect(changed.map(e => e.slug)).toEqual(['new']);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/delta.test.ts
```

- [ ] **Step 3: Implement `delta.ts`**

```typescript
// scripts/cockpit/delta.ts
import fs from 'fs';
import type { Snapshot } from './types.js';
import type { VaultBundleEntry } from './vault-scan.js';

export function loadPreviousSnapshot(jsonPath: string): Snapshot | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

export function computeChangedBundle(
  fullBundle: VaultBundleEntry[],
  previous: Snapshot | null,
  _now: Date,
): VaultBundleEntry[] {
  if (!previous) return fullBundle;
  const prevMs = new Date(previous.generated_at).getTime();
  return fullBundle.filter(e => {
    try {
      return fs.statSync(e.absPath).mtime.getTime() > prevMs;
    } catch {
      return true;
    }
  });
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/delta.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/delta.ts scripts/cockpit/delta.test.ts
git commit -m "feat(cockpit): snapshot delta detection"
```

---

## Task 11: R2 uploader

**Files:**
- Create: `scripts/cockpit/r2.ts`
- Create: `scripts/cockpit/r2.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/cockpit/r2.test.ts
import { describe, it, expect, vi } from 'vitest';
import { uploadObject } from './r2.js';

describe('uploadObject', () => {
  it('calls client.send once on success', async () => {
    const send = vi.fn().mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const client = { send } as any;
    await uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx error', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('500'), { $metadata: { httpStatusCode: 500 } }))
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    const client = { send } as any;
    await uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx', async () => {
    const err = Object.assign(new Error('403'), { $metadata: { httpStatusCode: 403 } });
    const send = vi.fn().mockRejectedValue(err);
    const client = { send } as any;
    await expect(uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails after retrying once on persistent 5xx', async () => {
    const err = Object.assign(new Error('503'), { $metadata: { httpStatusCode: 503 } });
    const send = vi.fn().mockRejectedValue(err);
    const client = { send } as any;
    await expect(uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/r2.test.ts
```

- [ ] **Step 3: Implement `r2.ts`**

```typescript
// scripts/cockpit/r2.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export function makeR2Client(endpoint: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });
}

/**
 * Upload one object. Retries once on 5xx (or no status); fails fast on 4xx.
 * Body may be a string or Uint8Array.
 */
export async function uploadObject(
  client: { send: (cmd: PutObjectCommand) => Promise<unknown> },
  bucket: string,
  key: string,
  body: string | Uint8Array,
  contentType: string,
  retryDelayMs = 30_000,
): Promise<void> {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
  try {
    await client.send(cmd);
  } catch (err) {
    const code = extractStatus(err);
    if (code !== null && code >= 400 && code < 500) throw err;
    await sleep(retryDelayMs);
    await client.send(cmd);
  }
}

function extractStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && '$metadata' in err) {
    const m = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return typeof m?.httpStatusCode === 'number' ? m.httpStatusCode : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/r2.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/r2.ts scripts/cockpit/r2.test.ts
git commit -m "feat(cockpit): R2 upload wrapper with 5xx-retry"
```

---

## Task 12: Orchestrator (`build-snapshot.ts`)

**Files:**
- Create: `scripts/cockpit/build-snapshot.ts`
- Create: `scripts/cockpit/build-snapshot.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// scripts/cockpit/build-snapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildSnapshot } from './build-snapshot.js';
import type { Snapshot } from './types.js';

describe('buildSnapshot (integration)', () => {
  let tmpVault: string;
  let tmpAgents: string;
  let tmpGroups: string;
  let tmpGlobal: string;
  let tmpCockpit: string;
  let db: Database;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    tmpAgents = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    tmpGroups = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'));
    tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'global-'));
    tmpCockpit = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-'));

    fs.mkdirSync(path.join(tmpVault, '99-wiki'), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, '99-wiki', 'test.md'), '# test\nbody');

    fs.mkdirSync(path.join(tmpAgents, 'einstein'), { recursive: true });
    fs.writeFileSync(path.join(tmpAgents, 'einstein', 'memory.md'),
      '# Einstein\n## Standing Instructions\n- be concise\n## Watchlist\n- [Paper X](http://x) — note\n');

    fs.writeFileSync(path.join(tmpGlobal, 'current.md'),
      '# Current\n## Top 3\n1. First priority\n2. Second priority\n3. Third priority\n');

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL, container_config TEXT, requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0, permitted_senders TEXT);
      CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL, last_used TEXT, created_at TEXT);
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT, channel TEXT, is_group INTEGER DEFAULT 0);
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, reply_to_message_id TEXT, reply_to_message_content TEXT, reply_to_sender_name TEXT, PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid));
      CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL, next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated', script TEXT, agent_name TEXT, surface_outputs INTEGER DEFAULT 0, proactive INTEGER DEFAULT 0);
      CREATE TABLE task_run_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, outcome_emitted INTEGER DEFAULT 0);
    `);
    db.run("INSERT INTO registered_groups VALUES ('c1@g','CLAIRE','telegram_claire','','2026-01-01',NULL,0,1,NULL)");
    db.run("INSERT INTO chats VALUES ('c1@g','CLAIRE',NULL,'telegram',1)");
    db.run("INSERT INTO scheduled_tasks (id,group_folder,chat_jid,prompt,schedule_type,schedule_value,next_run,last_run,last_result,status,created_at,context_mode,agent_name) VALUES ('t1','telegram_claire','c1@g','Do a thing','cron','0 9 * * 1-5',NULL,NULL,NULL,'active','2026-04-01','group','claire')");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.rmSync(tmpAgents, { recursive: true, force: true });
    fs.rmSync(tmpGroups, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
    fs.rmSync(tmpCockpit, { recursive: true, force: true });
  });

  it('produces a valid Snapshot object matching the schema', () => {
    const now = new Date('2026-04-19T12:00:00Z');
    const snap: Snapshot = buildSnapshot({
      db,
      vaultPath: tmpVault,
      agentsDir: tmpAgents,
      groupsDir: tmpGroups,
      currentMdPath: path.join(tmpGlobal, 'current.md'),
      papersLogPath: path.join(tmpCockpit, 'papers-evaluated.jsonl'),
      emailsStatePath: path.join(tmpCockpit, 'gmail-sync-state.json'),
      blogsPath: path.join(tmpCockpit, 'blogs.json'),
      previousSnapshot: null,
      now,
    });

    expect(snap.schema_version).toBe(1);
    expect(snap.generated_at).toBe('2026-04-19T12:00:00.000Z');
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0].folder).toBe('telegram_claire');
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0].schedule_human).toContain('9');
    expect(snap.priorities).toEqual(['First priority', 'Second priority', 'Third priority']);
    expect(snap.blogs).toBeNull();
    expect(snap.watchlists.some(w => w.scope === 'agent' && w.scope_name === 'einstein' && w.items.length === 1)).toBe(true);
    expect(snap.vault_pages_available.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run; fail**

```bash
bun --bun vitest run scripts/cockpit/build-snapshot.test.ts
```

- [ ] **Step 3: Implement `build-snapshot.ts`**

```typescript
// scripts/cockpit/build-snapshot.ts
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';

import { SCHEMA_VERSION } from './types.js';
import type { Snapshot, TaskSnapshot, WatchlistGroup } from './types.js';
import { getGroupsWithActivity, getTasksWithStatus } from './sql.js';
import { scanVault } from './vault-scan.js';
import { humanizeCron } from './cron-humanize.js';
import { readPapersLog } from './papers-log.js';
import { readEmailsState } from './emails-log.js';
import { readBlogs } from './blogs.js';
import { parsePriorities } from './priorities.js';
import { extractSection, parseWatchlistBullets } from './watchlist-parser.js';

export interface BuildArgs {
  db: Database;
  vaultPath: string;
  agentsDir: string;
  groupsDir: string;
  currentMdPath: string;
  papersLogPath: string;
  emailsStatePath: string;
  blogsPath: string;
  previousSnapshot: Snapshot | null;
  now: Date;
}

export function buildSnapshot(args: BuildArgs): Snapshot {
  const { db, vaultPath, agentsDir, groupsDir, currentMdPath, papersLogPath, emailsStatePath, blogsPath, now } = args;

  const vault = scanVault(vaultPath, now);
  const groupRows = getGroupsWithActivity(db, now);
  const taskRows = getTasksWithStatus(db);
  const tasks: TaskSnapshot[] = taskRows.map(t => ({
    id: t.id,
    group: t.group,
    name: deriveName(t.prompt, t.agent_name),
    schedule_raw: t.schedule_value,
    schedule_human: humanizeCron(t.schedule_value),
    last_run: t.last_run,
    last_status: t.last_status,
    last_result_excerpt: t.last_result ? t.last_result.slice(0, 200) : null,
    next_run: t.next_run,
    success_7d: t.success_7d,
    consecutive_failures: countConsecutiveFailures(db, t.id),
  }));

  const papers = readPapersLog(papersLogPath, now);
  const emails = readEmailsState(emailsStatePath, now);
  const blogs = readBlogs(blogsPath);
  const priorities = fs.existsSync(currentMdPath) ? parsePriorities(fs.readFileSync(currentMdPath, 'utf-8')) : [];

  const watchlists: WatchlistGroup[] = [
    ...collectGroupWatchlists(groupsDir),
    ...collectAgentWatchlists(agentsDir),
  ];

  return {
    generated_at: now.toISOString(),
    schema_version: SCHEMA_VERSION,
    groups: groupRows,
    tasks,
    ingestion: {
      emails,
      papers,
      vault: {
        count_24h: vault.count_24h,
        last_at: vault.last_at,
        recent: vault.recent,
      },
    },
    watchlists,
    blogs,
    priorities,
    vault_tree: vault.tree,
    vault_pages_available: vault.bundle.map(b => b.slug),
  };
}

function deriveName(prompt: string, agentName: string | null): string {
  const firstLine = prompt.split('\n').map(s => s.trim()).find(s => s.length > 0);
  if (firstLine && firstLine.length <= 80) return firstLine;
  if (agentName) return agentName;
  return firstLine ? firstLine.slice(0, 80) + '…' : '(unnamed)';
}

function countConsecutiveFailures(db: Database, taskId: string): number {
  const rows = db
    .prepare('SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 20')
    .all(taskId) as Array<{ status: string }>;
  let count = 0;
  for (const row of rows) {
    if (row.status !== 'error') break;
    count++;
  }
  return count;
}

function collectGroupWatchlists(groupsDir: string): WatchlistGroup[] {
  if (!fs.existsSync(groupsDir)) return [];
  const result: WatchlistGroup[] = [];
  for (const name of fs.readdirSync(groupsDir)) {
    if (name.endsWith('.archived')) continue;
    const groupPath = path.join(groupsDir, name);
    try {
      if (fs.lstatSync(groupPath).isSymbolicLink()) continue;
      if (!fs.statSync(groupPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const items = [
      ...readBulletFile(path.join(groupPath, 'bookmarks.md')),
      ...readBulletFile(path.join(groupPath, 'watchlist.md')),
    ];
    if (items.length > 0) result.push({ scope: 'group', scope_name: name, items });
  }
  return result;
}

function collectAgentWatchlists(agentsDir: string): WatchlistGroup[] {
  if (!fs.existsSync(agentsDir)) return [];
  const result: WatchlistGroup[] = [];
  for (const name of fs.readdirSync(agentsDir)) {
    const memPath = path.join(agentsDir, name, 'memory.md');
    if (!fs.existsSync(memPath)) continue;
    const md = fs.readFileSync(memPath, 'utf-8');
    const section = extractSection(md, 'Watchlist');
    if (section === null) continue;
    const items = parseWatchlistBullets(section);
    if (items.length > 0) result.push({ scope: 'agent', scope_name: name, items });
  }
  return result;
}

function readBulletFile(filePath: string): ReturnType<typeof parseWatchlistBullets> {
  if (!fs.existsSync(filePath)) return [];
  return parseWatchlistBullets(fs.readFileSync(filePath, 'utf-8'));
}
```

- [ ] **Step 4: Run; pass**

```bash
bun --bun vitest run scripts/cockpit/build-snapshot.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cockpit/build-snapshot.ts scripts/cockpit/build-snapshot.test.ts
git commit -m "feat(cockpit): snapshot orchestrator with integration test"
```

---

## Task 13: CLI entrypoint with preconditions + R2 upload

**Files:**
- Create: `scripts/cockpit/main.ts`

Not unit-tested — integration behavior is covered by Task 12; this entrypoint is thin glue.

- [ ] **Step 1: Implement `main.ts`**

```typescript
// scripts/cockpit/main.ts
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';

import { buildSnapshot } from './build-snapshot.js';
import { loadPreviousSnapshot, computeChangedBundle } from './delta.js';
import { scanVault } from './vault-scan.js';
import { makeR2Client, uploadObject } from './r2.js';
import {
  VAULT_PATH, R2_ENDPOINT, R2_BUCKET, R2_TOKEN,
  SNAPSHOT_PATH, LAST_SNAPSHOT_PATH, PROJECT_ROOT,
} from './config.js';

interface SplitToken { accessKeyId: string; secretAccessKey: string }

function parseR2Token(token: string): SplitToken {
  const parts = token.split(':');
  if (parts.length !== 2) {
    throw new Error('COCKPIT_R2_TOKEN must be formatted as "accessKeyId:secretAccessKey"');
  }
  return { accessKeyId: parts[0], secretAccessKey: parts[1] };
}

function checkPreconditions(): void {
  if (!fs.existsSync(VAULT_PATH)) {
    throw new Error(`Vault path not found at ${VAULT_PATH}; set COCKPIT_VAULT_PATH or attach drive`);
  }
  const wikiProbe = path.join(VAULT_PATH, '99-wiki');
  if (fs.existsSync(wikiProbe)) {
    try {
      fs.readdirSync(wikiProbe);
    } catch (err) {
      throw new Error(`Cannot read ${wikiProbe} (likely FDA issue). Grant Full Disk Access to /opt/homebrew/bin/bun. Underlying error: ${String(err)}`);
    }
  }
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_TOKEN) {
    throw new Error('Missing R2 config: set COCKPIT_R2_ENDPOINT, COCKPIT_R2_BUCKET, COCKPIT_R2_TOKEN');
  }
  const cockpitDir = path.join(PROJECT_ROOT, 'data', 'cockpit');
  fs.mkdirSync(cockpitDir, { recursive: true });
}

async function run(): Promise<void> {
  checkPreconditions();

  const now = new Date();
  const dbPath = path.join(PROJECT_ROOT, 'store', 'messages.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const previous = loadPreviousSnapshot(LAST_SNAPSHOT_PATH);
    const snapshot = buildSnapshot({
      db,
      vaultPath: VAULT_PATH,
      agentsDir: path.join(PROJECT_ROOT, 'data', 'agents'),
      groupsDir: path.join(PROJECT_ROOT, 'groups'),
      currentMdPath: path.join(PROJECT_ROOT, 'groups', 'global', 'state', 'current.md'),
      papersLogPath: path.join(PROJECT_ROOT, 'data', 'cockpit', 'papers-evaluated.jsonl'),
      emailsStatePath: path.join(PROJECT_ROOT, 'scripts', 'sync', 'gmail-sync-state.json'),
      blogsPath: path.join(PROJECT_ROOT, 'data', 'cockpit', 'blogs.json'),
      previousSnapshot: previous,
      now,
    });

    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));

    const { accessKeyId, secretAccessKey } = parseR2Token(R2_TOKEN);
    const client = makeR2Client(R2_ENDPOINT, accessKeyId, secretAccessKey);

    await uploadObject(client, R2_BUCKET, 'snapshot.json', JSON.stringify(snapshot), 'application/json');

    const histKey = `snapshot-${histStamp(now)}.json`;
    await uploadObject(client, R2_BUCKET, histKey, JSON.stringify(snapshot), 'application/json');

    await uploadObject(client, R2_BUCKET, 'heartbeat.txt', now.toISOString(), 'text/plain');

    const vault = scanVault(VAULT_PATH, now);
    const changed = computeChangedBundle(vault.bundle, previous, now);
    for (const entry of changed) {
      const body = fs.readFileSync(entry.absPath);
      await uploadObject(client, R2_BUCKET, `pages/${entry.slug}.md`, body, 'text/markdown');
    }

    fs.copyFileSync(SNAPSHOT_PATH, LAST_SNAPSHOT_PATH);

    console.log(`cockpit: ok, ${changed.length} pages uploaded, heartbeat ${now.toISOString()}`);
  } finally {
    db.close();
  }
}

function histStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

run().catch(err => {
  console.error('cockpit: FAILED', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/cockpit/main.ts
git commit -m "feat(cockpit): CLI entrypoint with preconditions + R2 upload"
```

- [ ] **Step 3: Smoke test against fake R2 (must fail at upload; everything before should succeed)**

```bash
COCKPIT_R2_ENDPOINT=http://example.invalid COCKPIT_R2_BUCKET=test COCKPIT_R2_TOKEN=a:b bun scripts/cockpit/main.ts
```

Expected: builds snapshot successfully and writes `/tmp/nanoclaw-snapshot.json`, then fails at R2 upload with network error. Confirms builder logic works against real host data.

- [ ] **Step 4: Inspect the generated snapshot**

```bash
jq '.groups | length, (.tasks | length), (.vault_pages_available | length), .priorities' /tmp/nanoclaw-snapshot.json
```

Expected: group count matches `registered_groups` row count; task count matches active scheduled_tasks; `vault_pages_available` has >100 entries; `priorities` shows current top 3.

- [ ] **Step 5: Clean up smoke-test artifact**

```bash
rm /tmp/nanoclaw-snapshot.json
```

---

## Task 14: launchd plist

**Files:**
- Create: `launchd/com.nanoclaw.cockpit.plist`

- [ ] **Step 1: Write the plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.cockpit</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>/Users/mgandal/Agents/nanoclaw/scripts/cockpit/main.ts</string>
    </array>
    <key>StartInterval</key>
    <integer>1800</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/Agents/nanoclaw/logs/cockpit.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/Agents/nanoclaw/logs/cockpit.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/mgandal</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/Users/mgandal/Agents/nanoclaw</string>
</dict>
</plist>
```

- [ ] **Step 2: Commit**

```bash
git add launchd/com.nanoclaw.cockpit.plist
git commit -m "feat(cockpit): launchd plist, StartInterval=1800"
```

- [ ] **Step 3: Installation note (for the user; not auto-executed)**

Manual steps after Plan B produces R2 credentials:

1. Grant FDA to `/opt/homebrew/bin/bun` via System Settings → Privacy & Security → Full Disk Access.
2. Fill `.env` with real R2 credentials from Plan B.
3. Copy plist to LaunchAgents and load:
   ```bash
   cp launchd/com.nanoclaw.cockpit.plist ~/Library/LaunchAgents/com.nanoclaw.cockpit.plist
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.cockpit.plist
   launchctl list | grep cockpit
   ```
4. Verify first run in `logs/cockpit.log`.

---

## Task 15: Self-review + type check + final verify

- [ ] **Step 1: Run all cockpit tests**

```bash
bun --bun vitest run scripts/cockpit/
```

Expected: all tests pass.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no new errors from `scripts/cockpit/`.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Fix any lint errors in the cockpit modules.

- [ ] **Step 4: Commit any lint/format fixes**

```bash
git add -u scripts/cockpit/
git commit -m "chore(cockpit): lint + format cleanup"
```

- [ ] **Step 5: Verify deliverable**

Engineer confirms:

- `scripts/cockpit/` contains `types.ts`, `config.ts`, `cron-humanize.ts`, `watchlist-parser.ts`, `papers-log.ts`, `emails-log.ts`, `blogs.ts`, `priorities.ts`, `sql.ts`, `vault-scan.ts`, `delta.ts`, `r2.ts`, `build-snapshot.ts`, `main.ts` — 14 modules total — plus 11 `*.test.ts` files (one per module except `types.ts`, `config.ts`, and `main.ts`).
- `launchd/com.nanoclaw.cockpit.plist` exists.
- `package.json` has `@aws-sdk/client-s3` and `gray-matter`.
- `.env.example` documents 4 cockpit env vars.
- Unit + integration tests pass.
- Smoke test from Task 13 Step 3 produced a real `/tmp/nanoclaw-snapshot.json`.

Plan A complete. Plans B (Worker + Pages + Access) and C (PWA) can proceed independently.

---

## Spec coverage checklist

| Spec section | Implemented by |
|---|---|
| §Preconditions (FDA, env vars) | Task 13 `checkPreconditions()` |
| §1 (snapshot builder reads) | Tasks 2–12 |
| §1 Scanner rules (archived, symlinks) | Task 12 `collectGroupWatchlists()` |
| §2 (snapshot schema) | Task 1 `types.ts` |
| §3 (blogs null vs empty) | Task 6 |
| §5 (allowlist, delta, URL-encoded slug) | Tasks 9, 10 |
| §6 (Watchlist section) | Tasks 3, 12 |
| §7 (R2 push, history, heartbeat, plist) | Tasks 11, 13, 14 |
| §Error handling (precondition, 4xx vs 5xx) | Tasks 11, 13 |
| §Testing (unit, integration) | Tasks 2–12 |

## Out of scope (covered by Plans B and C)

- Cloudflare Worker with Access JWT validation
- Cloudflare Pages site / PWA UI
- R2 lifecycle rule creation (manual Cloudflare dashboard step)
- Agent-side CLAUDE.md edits encouraging `## Watchlist` upserts
- Blog ingester implementation
- Data cleanup for the malformed `schedule_value` row
