/**
 * INTEGRATION test for the session size-cap feature (2026-06-23 CLAIRE incident:
 * a ~19MB session jsonl → each turn auto-compacts → exceeds CONTAINER_TIMEOUT →
 * container killed before replying). Three production pieces were added:
 *   1. src/config.ts            — SESSION_MAX_SIZE_BYTES (8MB default).
 *   2. src/index-helpers.ts     — checkSessionExpiry(...sizeBytes?, maxSizeBytes?).
 *   3. src/index.ts             — sessionFileSize(groupFolder, sessionId) path resolver.
 *   4. src/task-scheduler.ts    — inline size guard for context_mode === 'group'.
 *
 * The pure checkSessionExpiry size *logic* is already unit-tested in
 * src/index.test.ts ("checkSessionExpiry: size cap"). The gap this file closes is
 * the on-disk PATH RESOLUTION in sessionFileSize — the highest-risk piece, because
 * the path must EXACTLY match where Claude Code writes session transcripts
 * (DATA_DIR/sessions/<groupFolder>/.claude/projects/-workspace-group/<id>.jsonl).
 *
 * OPTION CHOSEN: Option 1 (import the real helper).
 * Justification: index.ts is SAFE to import in tests. (a) It guards startup behind
 * `isDirectRun` (only calls main() when process.argv[1] === module URL — false under
 * vitest), and (b) src/index.test.ts ALREADY imports from './index.js'
 * (getAvailableGroups, _setRegisteredGroups) and the full suite passes. So we add a
 * minimal test-only export `_sessionFileSizeForTests` (mirroring the existing
 * `_pendingPipedAdvanceForTests` / `_h2ForTests` pattern) that wraps the unchanged
 * module-private sessionFileSize, and exercise the REAL function — no copy.
 *
 * The test exercises the REAL exported checkSessionExpiry for every expiry decision
 * (never a reimplementation) and validates the real path formula against a REAL
 * on-disk production session file (read-only stat — no real session file is ever
 * written, moved, or deleted).
 *
 * NOTE on DATA_DIR: config.ts resolves DATA_DIR from process.cwd() === repo root
 * under the test runner, so sessionFileSize composes paths under the real
 * data/sessions/. Temp fixtures therefore live under a UNIQUE throwaway group
 * folder inside data/sessions/ (created + torn down here), keeping them isolated
 * from every real group while still exercising the production path formula.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DATA_DIR, SESSION_MAX_SIZE_BYTES } from './config.js';
import { checkSessionExpiry } from './index-helpers.js';
import { _sessionFileSizeForTests as sessionFileSize } from './index.js';

// Expiry thresholds wide enough that age/idle never trips — isolates the SIZE axis.
const ONE_HOUR = 60 * 60 * 1000;
const TWO_HOURS = 2 * ONE_HOUR;
const FOUR_HOURS = 4 * ONE_HOUR;
// Use a local cap so assertions don't depend on a mutated env, but assert below
// that it equals the production default — drift in the 8MB default would surface.
const CAP = 8 * 1024 * 1024;

// A unique throwaway group folder under the REAL data/sessions/ tree, so the
// production path formula is exercised verbatim while staying isolated from every
// real group. Cleaned up in afterAll.
const TMP_GROUP = `__sizecap_it_${process.pid}_${Math.random()
  .toString(36)
  .slice(2)}`;
const TMP_SESSION_ID = '11111111-2222-3333-4444-555555555555';

/** Build the exact directory a session transcript lives in, under a given group. */
function sessionDirFor(groupFolder: string): string {
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
}

/** Write a fixture transcript of an exact byte size and return its full path. */
function writeFixture(
  groupFolder: string,
  sessionId: string,
  bytes: number,
): string {
  const dir = sessionDirFor(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61)); // 'a' * bytes
  return file;
}

// --- Real production session file, looked up read-only from store/messages.db. ---
// Verified at authoring time: telegram_ops-claw → a58f4fd8-...-c2c61261, ~1.47MB on disk.
const REAL_GROUP = 'telegram_ops-claw';
const REAL_SESSION_ID = 'a58f4fd8-7f64-4416-a180-9609f2c61261';

afterAll(() => {
  // Remove ONLY the throwaway group dir we created — never a real session.
  const tmpRoot = path.join(DATA_DIR, 'sessions', TMP_GROUP);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('size-cap integration: sessionFileSize path resolution (real helper)', () => {
  let underCapFile: string;
  let overCapFile: string;

  it('the production default cap is 8MB (guards SESSION_MAX_SIZE_BYTES drift)', () => {
    // The local CAP this file asserts against must match the shipped default, or
    // these tests would silently validate the wrong threshold. Env-overridable in
    // prod, but the default is the contract the 2026-06-23 fix encodes.
    expect(SESSION_MAX_SIZE_BYTES).toBe(CAP);
  });

  beforeAll(() => {
    // Two fixtures via the REAL path formula: one under the cap, one over it.
    underCapFile = writeFixture(TMP_GROUP, TMP_SESSION_ID, 1024); // 1KB
    overCapFile = writeFixture(TMP_GROUP, `${TMP_SESSION_ID}-big`, CAP + 4096); // >8MB
  });

  it('resolves to the on-disk file and returns its exact byte size', () => {
    const size = sessionFileSize(TMP_GROUP, TMP_SESSION_ID);
    expect(size).toBe(fs.statSync(underCapFile).size);
    expect(size).toBe(1024);
  });

  it('reports a size above the cap for an oversized transcript', () => {
    const size = sessionFileSize(TMP_GROUP, `${TMP_SESSION_ID}-big`);
    expect(size).toBe(fs.statSync(overCapFile).size);
    expect(size).toBeGreaterThan(CAP);
  });

  it('returns undefined for a missing transcript (ENOENT path)', () => {
    const size = sessionFileSize(TMP_GROUP, 'does-not-exist-session-id');
    expect(size).toBeUndefined();
  });

  it('returns undefined for a nonexistent group folder (fresh group)', () => {
    const size = sessionFileSize(`${TMP_GROUP}-never-created`, TMP_SESSION_ID);
    expect(size).toBeUndefined();
  });

  it('keys by the BARE group folder, not a compound agent key (telegram_x:claire → telegram_x)', () => {
    // sessionFileSize takes the bare folder. A compound key passed verbatim must
    // NOT resolve (no colon-bearing dir exists on disk — verified at authoring),
    // while the bare folder it maps to DOES resolve. This guards the contract that
    // callers must pass group.folder, never the compound `{folder}:{agent}` key.
    const compoundKey = `${TMP_GROUP}:claire`;
    expect(sessionFileSize(compoundKey, TMP_SESSION_ID)).toBeUndefined();
    expect(sessionFileSize(TMP_GROUP, TMP_SESSION_ID)).toBe(1024);
  });
});

describe('size-cap integration: composition with the real checkSessionExpiry', () => {
  // These prove sessionFileSize → checkSessionExpiry produces a `size (...)`
  // decision end-to-end, using the REAL exported checkSessionExpiry (not a copy).
  const fresh = () => new Date(Date.now() - 60 * 1000).toISOString(); // 1 min old, 1 min idle

  it('a fresh-but-oversized session expires with a "size (NMB)" reason', () => {
    const oversizedId = `${TMP_SESSION_ID}-big`;
    const sizeBytes = sessionFileSize(TMP_GROUP, oversizedId);
    expect(sizeBytes).toBeGreaterThan(CAP); // precondition from the fixture

    const reason = checkSessionExpiry(
      fresh(),
      fresh(),
      TWO_HOURS,
      FOUR_HOURS,
      sizeBytes,
      CAP,
    );
    expect(reason).toMatch(/^size \(\d+MB\)$/);
    expect(reason).not.toMatch(/idle|max age/); // size, not age/idle
  });

  it('a fresh under-cap session is NOT expired (size axis stays quiet)', () => {
    const sizeBytes = sessionFileSize(TMP_GROUP, TMP_SESSION_ID);
    expect(sizeBytes).toBeLessThan(CAP); // precondition from the fixture

    const reason = checkSessionExpiry(
      fresh(),
      fresh(),
      TWO_HOURS,
      FOUR_HOURS,
      sizeBytes,
      CAP,
    );
    expect(reason).toBeNull();
  });

  it('undefined size (missing transcript) never triggers a size expiry', () => {
    const sizeBytes = sessionFileSize(TMP_GROUP, 'no-such-session');
    expect(sizeBytes).toBeUndefined();

    const reason = checkSessionExpiry(
      fresh(),
      fresh(),
      TWO_HOURS,
      FOUR_HOURS,
      sizeBytes,
      CAP,
    );
    expect(reason).toBeNull();
  });

  it('age/idle still win over size (priority order preserved through composition)', () => {
    const oversizedId = `${TMP_SESSION_ID}-big`;
    const sizeBytes = sessionFileSize(TMP_GROUP, oversizedId);
    expect(sizeBytes).toBeGreaterThan(CAP);

    // Oversized AND over max-age → max age reported first (size never reached).
    const old = new Date(Date.now() - 5 * ONE_HOUR).toISOString();
    const reason = checkSessionExpiry(
      old,
      old,
      TWO_HOURS,
      FOUR_HOURS,
      sizeBytes,
      CAP,
    );
    expect(reason).toMatch(/max age/);
  });
});

describe('size-cap integration: real production session file (read-only)', () => {
  // Catches path-format drift against reality: if Claude Code's on-disk layout or
  // the helper's formula changed, the real session would no longer resolve.
  it('the path formula resolves a REAL on-disk production transcript (size > 0)', () => {
    const size = sessionFileSize(REAL_GROUP, REAL_SESSION_ID);
    expect(size).toBeDefined();
    expect(size!).toBeGreaterThan(0);

    // Independently confirm the helper hit the same file the formula points to.
    const expectedPath = path.join(
      sessionDirFor(REAL_GROUP),
      `${REAL_SESSION_ID}.jsonl`,
    );
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(size).toBe(fs.statSync(expectedPath).size);
  });

  it('the helper-built path lives under DATA_DIR/sessions/<group>/.claude/projects/-workspace-group/', () => {
    const expectedPath = path.join(
      sessionDirFor(REAL_GROUP),
      `${REAL_SESSION_ID}.jsonl`,
    );
    expect(expectedPath).toContain(
      path.join(
        'data',
        'sessions',
        REAL_GROUP,
        '.claude',
        'projects',
        '-workspace-group',
      ),
    );
    // It must NOT live under any tmp dir — the formula is rooted at DATA_DIR.
    expect(expectedPath.startsWith(os.tmpdir())).toBe(false);
  });
});

/*
 * SCHEDULER GUARD — verification by code-reading (src/task-scheduler.ts).
 *
 * The scheduler's inline size guard cannot be driven without a heavy task harness,
 * and it is already covered structurally by the same checkSessionExpiry/path logic
 * proven above. Confirming the guard is correctly WIRED by source inspection:
 *
 *   (a) Stats the BARE group folder path:           task-scheduler.ts:382-390
 *         path.join(DATA_DIR, 'sessions', task.group_folder, '.claude',
 *                   'projects', '-workspace-group', `${sessionId}.jsonl`)
 *       — identical formula to sessionFileSize (index.ts:186-194), keyed on the
 *         bare task.group_folder (not a compound key).
 *
 *   (b) Gated on context_mode === 'group':           task-scheduler.ts:381
 *         `if (sessionId && task.context_mode === 'group') { ... }`
 *       — and the sessionId itself is only set for group mode at line 372-373:
 *         `task.context_mode === 'group' ? sessions[task.group_folder] : undefined`.
 *
 *   (c) On oversize (sizeBytes > SESSION_MAX_SIZE_BYTES, line 397) it clears the
 *       session three ways:                           task-scheduler.ts:408-410
 *         delete sessions[task.group_folder];   // drop from the in-memory map
 *         deleteSession(task.group_folder);      // drop the DB row
 *         sessionId = undefined;                 // force a fresh session this run
 *
 *   (d) Logs the rotation:                            task-scheduler.ts:398-407
 *         logger.warn({ taskId, group, staleSessionId, sizeMB, capMB },
 *           'Oversized session in scheduled task — rotating to fresh session');
 *
 * All four conditions check out — the guard stats the correct path, fires only for
 * group-context tasks over the cap, fully clears the session, and logs the event.
 */
