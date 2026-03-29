# NanoClaw: npm to Bun Migration

**Date:** 2026-03-28
**Scope:** Host only (container stays Node 22)
**Goals:** Startup speed, runtime performance, faster dependency management
**Approach:** Phased migration (4 phases)

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Host only | Container has different constraints (Playwright, Claude SDK, Linux VM) |
| SQLite strategy | Direct replacement (`bun:sqlite`) | No shim/abstraction — cleaner, fewer files |
| Test runner | Keep Vitest | Works under Bun, zero test file changes, mature ecosystem |
| Migration strategy | Phased | Isolate risk; each phase independently testable |

## Architecture

No architectural changes. NanoClaw remains a single process with the same module structure. The migration swaps the runtime and package manager on the host side only.

**ESM compatibility:** The project is already `"type": "module"` with `"module": "NodeNext"` / `"moduleResolution": "NodeNext"` in tsconfig. All source imports use `.js` extensions (TypeScript ESM convention). Bun resolves `import './foo.js'` to `foo.ts` when running source directly — this is a tested compatibility path. The `tsc` compiler is retained for production builds, so `dist/` output is unchanged.

```
Host (macOS)                          Container (Linux VM)
┌─────────────────────┐               ┌─────────────────────┐
│  Bun runtime        │  spawn        │  node:22-slim       │
│  bun:sqlite         │ ──────────>   │  Claude Agent SDK   │
│  bun.lock           │               │  MCP servers        │
│  Vitest (via bun)   │               │  (unchanged)        │
└─────────────────────┘               └─────────────────────┘
        │                                      │
   launchd plist                         Dockerfile
   (bun binary)                        (unchanged)
```

## Phase 1: Package Manager Swap

**Risk:** Minimal
**Can ship independently:** Yes

### Changes

1. Run `bun install` to generate `bun.lock`
2. Delete `package-lock.json`
3. Update `.husky/pre-commit`: `npm run format:fix` → `bun run format:fix`
4. Update `setup.sh` bootstrap script:
   - `check_node()` → `check_bun()` (detect `bun` binary instead of `node`)
   - `npm ci` → `bun install`
   - Remove `node -e "require('better-sqlite3')"` sanity check (replaced in Phase 3 with `bun:sqlite` check)
   - Update status output: `NODE_OK`/`NODE_PATH` → `BUN_OK`/`BUN_PATH`
5. Update `.github/workflows/ci.yml`:
   - `actions/setup-node@v4` → `oven-sh/setup-bun@v2`
   - `npm ci` → `bun install`
   - `npm run format:check` → `bun run format:check`
   - `npx tsc --noEmit` → `bun run tsc --noEmit`
   - `npx vitest run` → `bun run test`

### Note on lifecycle scripts

`bun install` auto-runs the `"prepare": "husky"` lifecycle script. Update the pre-commit hook (step 3) before or during the same commit as `bun install`, not after, to avoid the hook referencing stale `npm run` commands.

### Note on bump-version.yml

`.github/workflows/bump-version.yml` uses `npm version` and `node -p`, but only runs on `qwibitai/nanoclaw` (guarded by `if: github.repository == 'qwibitai/nanoclaw'`). Not a blocker for this fork.

### Verification

- `bun install` succeeds (including `prepare` hook)
- `bun run build` compiles TypeScript
- `bun run test` passes all 33 test files
- Pre-commit hook triggers correctly on `git commit`
- `setup.sh` runs to completion on a clean checkout

## Phase 2: Runtime Swap

**Risk:** Low-medium
**Must ship with Phase 3** (Bun runtime cannot load better-sqlite3)

### Changes

**package.json scripts:**

| Script | Before | After |
|--------|--------|-------|
| `start` | `node dist/index.js` | `bun dist/index.js` |
| `dev` | `tsx src/index.ts` | `bun src/index.ts` |
| `build` | `tsc` | `tsc` (unchanged — invoked via `bun run build`) |
| `setup` | `tsx setup/index.ts` | `bun setup/index.ts` |
| `auth` | `tsx src/whatsapp-auth.ts` | `bun src/whatsapp-auth.ts` |

**Launchd plist generation (`setup/service.ts` + `setup/platform.ts`):**

The plist is NOT a template file — it is generated inline in `setup/service.ts` `setupLaunchd()` using JS template literals with `${nodePath}`. The reference file `launchd/com.nanoclaw.plist` with `{{NODE_PATH}}` is documentation only and not used by setup code.

Changes needed:
- `setup/platform.ts`: rename `getNodePath()` → `getBunPath()`, change `command -v node` → `command -v bun`. Update or remove `getNodeVersion()` and `getNodeMajorVersion()` (currently dead code but should reflect Bun).
- `setup/service.ts`: update variable name `nodePath` → `bunPath`, call `getBunPath()`. Also change `execSync('npm run build', ...)` at line 34 → `execSync('bun run build', ...)`.
- `launchd/com.nanoclaw.plist` (reference file): update `{{NODE_PATH}}` → `{{BUN_PATH}}` for documentation consistency.

**Hardcoded `npm`/`node` references in setup code:**
- `setup/service.ts:34` — `execSync('npm run build', ...)` → `bun run build`
- `setup/groups.ts:90` — `execSync('npm run build', ...)` → `bun run build`
- `setup/groups.ts:185` — `execSync(`node ${tmpScript}`, ...)` → `bun ${tmpScript}`. Note: this code path only runs for WhatsApp group sync (currently inactive per TELEGRAM_ONLY=true), but must be fixed to avoid a latent break.

**Note on `setup/groups.ts` embedded script (line 118):**
`setup/groups.ts` contains a dynamically-generated `.mjs` script written to a temp file and executed as a child process. This embedded script has its own `import Database from 'better-sqlite3'` and `db.pragma()` call inside a string literal. These are NOT Bun code — they run under the child process runtime. If the child process invocation is changed from `node` to `bun` (line 185), then the embedded script's `better-sqlite3` import must also change to `bun:sqlite` and the `.pragma()` must change to `db.exec('PRAGMA ...')`. These are string literal edits, not import changes.

**pino-pretty transport fix (`src/logger.ts`):**
- Pino's worker-thread transport system does not work under Bun
- Replace transport config with direct stream import:

```typescript
// Before (broken under Bun):
pino({ transport: { target: 'pino-pretty', options: { colorize: true } } })

// After:
import PinoPretty from 'pino-pretty'
pino({}, PinoPretty({ colorize: true }))
```

pino-pretty is only used in `src/logger.ts` — no other files affected.

### Compatibility Audit Results

| API | Status | Notes |
|-----|--------|-------|
| `child_process.spawn` / `execFile` | Works | NanoClaw uses fds 0-2 only (safe) |
| `process.kill(-pid, 'SIGTERM')` | Works | Fixed in Bun PR #15920; verify installed version. Fallback to positive PID exists in `remote-control.ts`. |
| `process.on('SIGTERM'/'SIGINT')` | Works | Direct handlers, no third-party wrappers |
| `fs.*` / `path.*` | Works | Full compat |
| `import.meta.url` | Works | Native in Bun |
| `grammy` | Works | Pure TS, no native modules, community-tested |
| `google-auth-library` / `googleapis` | Works | Library archived upstream (unrelated to Bun) |
| `pino` | Works with fix | Transport system broken; use direct stream (see above) |
| `playwright` | N/A | Not imported in `src/`; only in container. Listed in `dependencies` — `bun install` triggers its `postinstall` (browser download), same as npm. Consider moving to `devDependencies` or removing if unused on host. |
| `bun run tsc` | Works | Invokes TypeScript compiler correctly |

### Verification

- `bun dist/index.js` starts NanoClaw successfully
- Telegram bot connects and receives messages
- Messages route to containers and responses come back
- Scheduled tasks fire on schedule
- `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` restarts with new plist
- Logs appear correctly (pino-pretty formatting works)

## Phase 3: SQLite Migration (better-sqlite3 to bun:sqlite)

**Risk:** Medium
**Must ship with Phase 2**

### API Differences (Audit)

| Pattern | better-sqlite3 | bun:sqlite | Action |
|---------|---------------|------------|--------|
| Import | `import Database from 'better-sqlite3'` | `import { Database } from 'bun:sqlite'` | Change (7 files — see note on `setup/groups.ts`) |
| Type | `Database.Database` | `Database` | Change (4 files: `db.ts`, `imessage-host.ts`, `register.test.ts`, `environment.test.ts`) |
| `db.pragma()` | Dedicated method | Not available | Use `db.exec('PRAGMA ...')` (3 sites in `src/db.ts`) |
| `.prepare().run/get/all()` | Variadic spread params | Same | No change |
| `.get()` no-match return | `undefined` | `null` | Normalize in accessor functions |
| `db.transaction()` | Returns wrapper fn | Same semantics | No change |
| `new Database(':memory:')` | Supported | Same | No change |
| `db.exec(sql)` | Multi-statement SQL | Same | No change (verified: `createSchema()` multi-statement block works) |
| `db.close()` | No args | Same | No change |
| INTEGER coercion | JS `number` | Same | No change |
| Error on duplicate ALTER | Standard Error | Same | No change (idempotent migration pattern in `addColumn()` works) |
| WAL mode | Sidecar files cleaned on close | **Persist on macOS** (Apple system SQLite) | Document only; functionally harmless |

### `.get()` null vs undefined — Breaking Change Detail

bun:sqlite `.get()` returns `null` when no row matches, not `undefined`.

**Production code in `src/db.ts` — mostly safe:**
- `getRegisteredGroup()` — `if (!row) return undefined` catches both null and undefined. Safe.
- `getRouterState()` — `row?.value` works with null (`null?.value` returns `undefined`). Safe.
- `getSession()` — same `?.` pattern. Safe.
- `getSessionTimestamps()` — same pattern. Safe.
- `getLastGroupSync()` — `row?.last_message_time || null`. Safe.
- `getLastBotMessageSeq()` — `row?.seq ?? 0`. Safe.
- `getLastSuccessTime()` — `row?.run_at ?? null`. Safe.
- **`getTaskById()`** — directly returns `.get()` result with `as` cast. **Must normalize.**

**Setup code with unguarded `.get()`:**
- `setup/verify.ts:147` — `.get() as { count: number }` then accesses `row.count`. If no row, `null.count` throws TypeError. **Must add null guard.**
- `setup/environment.ts:58` — same pattern. **Must add null guard.**

**Fix for `getTaskById()` in `src/db.ts`:**
```typescript
export function getTaskById(id: string): ScheduledTask | undefined {
  return (db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) ?? undefined) as ScheduledTask | undefined;
}
```

**Test assertions affected (3 sites) — pass after `getTaskById()` fix above:**
- `db.test.ts:385`
- `ipc-auth.test.ts:281`
- `ipc-auth.test.ts:304`

### Files Changed

| File | Changes |
|------|---------|
| `src/db.ts` | Import (named), type (`Database`), 3x `.pragma()` → `db.exec('PRAGMA ...')`, `getTaskById()` null normalization |
| `src/imessage-host.ts` | Import (named), type (`Database`) |
| `src/db-migration.test.ts` | Import (named) |
| `setup/groups.ts` | Import (named). Also update embedded `.mjs` string literal: `better-sqlite3` → `bun:sqlite`, `.pragma()` → `db.exec('PRAGMA ...')` (if Phase 2 changed the child invocation from `node` to `bun`) |
| `setup/environment.ts` | Import (named), add null guard on `.get()` result |
| `setup/verify.ts` | Import (named), add null guard on `.get()` result |
| `setup/register.test.ts` | Import (named), type (`Database`) |
| `setup/environment.test.ts` | Import (named), type (`Database`) |

### Verification

- All 33 existing tests pass under `bun run test`
- Manual smoke test: send Telegram message, verify stored in DB
- Verify scheduled tasks fire and log to `task_run_logs`
- Verify session create/touch/expire/delete lifecycle
- Verify existing `store/messages.db` loads correctly (binary-compatible SQLite)
- Run `setup/verify.ts` against a real DB to confirm null guards work

## Phase 4: Cleanup

**Risk:** None
**Ships after Phases 1-3 verified in production**

### Changes

**Remove from `package.json`:**
- `better-sqlite3` (dependency)
- `@types/better-sqlite3` (devDependency)
- `tsx` (devDependency)
- `dotenv-cli` (dependency — unused; NanoClaw reads `.env` via `src/env.ts` with `fs.readFileSync`, and Bun natively loads `.env`)

**Update `package.json`:**
- `"engines"` field — document Bun version requirement

**Consider moving `playwright` from `dependencies` to `devDependencies`:**
- Not imported anywhere in `src/`. Only used inside container skills.
- Keeping it in `dependencies` causes `bun install` to trigger playwright's `postinstall` (browser binary download), which is unnecessary on the host.

**Delete:**
- `package-lock.json` (if not already removed in Phase 1)

**Update documentation:**
- `CLAUDE.md` — dev commands, prerequisites
- `README.md` — prerequisites (Bun instead of Node for host)

## Rollback Strategy

- **Phase 1** can be reverted independently (restore `package-lock.json`, revert pre-commit hook, revert `setup.sh` and `ci.yml`)
- **Phases 2+3** must be reverted together — once Bun is the runtime, better-sqlite3 segfaults, so reverting to Node requires also reverting to better-sqlite3
- **Phase 4** is cleanup only, safe to revert

All phases are on a single feature branch. Worst case: `git revert` the merge commit to restore full Node.js operation.

## Branch Strategy

```
main ─────────────────────────────────────────
  \                                          /
   bun-migration ──[P1]──[P2+P3]──[P4]────
```

- Phase 1: independent commit
- Phases 2+3: single commit (or two commits, but tested and shipped together)
- Phase 4: independent commit after production verification

## Risk Summary

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `bun:sqlite` subtle query difference | Low | High | Full test suite + manual smoke tests |
| `.get()` null vs undefined in setup code | Medium | Medium | Add null guards in `verify.ts` and `environment.ts` |
| pino-pretty transport | Known | Medium | Direct stream import (verified fix) |
| `process.kill(-pid)` regression | Low | Medium | NanoClaw has fallback to positive PID |
| Launchd plist path wrong | Low | High | Test restart before committing; fix is in `service.ts` code generation, not template |
| WAL sidecar persistence | Certain | None | Cosmetic; document only |
| Bun version incompatibility | Low | High | Pin minimum Bun version in engines |
| `setup.sh` / CI not updated | Medium | High | Explicitly included in Phase 1 |
| Hardcoded `npm run build` in setup code | Medium | Medium | Updated in Phase 2 (`service.ts`, `groups.ts`) |
