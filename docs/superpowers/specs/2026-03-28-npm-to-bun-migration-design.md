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

### Verification

- `bun install` succeeds
- `bun run build` compiles TypeScript
- `bun run test` passes all 33 test files
- Pre-commit hook triggers correctly on `git commit`

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

**Launchd plist (`launchd/com.nanoclaw.plist`):**
- Template variable: `{{NODE_PATH}}` → `{{BUN_PATH}}`
- ProgramArguments: `[<bun binary path>, <project>/dist/index.js]`

**Setup script (`setup/service.ts`):**
- Detect `bun` binary path instead of `node`
- Embed into plist template

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

### Compatibility Audit Results

| API | Status | Notes |
|-----|--------|-------|
| `child_process.spawn` / `execFile` | Works | NanoClaw uses fds 0-2 only (safe) |
| `process.kill(-pid, 'SIGTERM')` | Works | Fixed in Bun PR #15920; verify installed version |
| `process.on('SIGTERM'/'SIGINT')` | Works | Direct handlers, no third-party wrappers |
| `fs.*` / `path.*` | Works | Full compat |
| `import.meta.url` | Works | Native in Bun |
| `grammy` | Works | Community-tested |
| `google-auth-library` / `googleapis` | Works | Library archived upstream (unrelated to Bun) |
| `pino` | Works with fix | Transport system broken; use direct stream (see above) |
| `playwright` | N/A | Not imported in `src/`; only in container skills |
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
| Import | `import Database from 'better-sqlite3'` | `import { Database } from 'bun:sqlite'` | Change (7 files) |
| Type | `Database.Database` | `Database` | Change (2 files) |
| `db.pragma()` | Dedicated method | Not available | Use `db.exec('PRAGMA ...')` (4 sites) |
| `.prepare().run/get/all()` | Variadic spread params | Same | No change |
| `.get()` no-match return | `undefined` | `null` | Normalize in accessor functions |
| `db.transaction()` | Returns wrapper fn | Same semantics | No change |
| `new Database(':memory:')` | Supported | Same | No change |
| `db.exec(sql)` | Multi-statement SQL | Same | No change |
| `db.close()` | No args | Same | No change |
| INTEGER coercion | JS `number` | Same | No change |
| Error on duplicate ALTER | Standard Error | Same | No change |
| WAL mode | Sidecar files cleaned on close | **Persist on macOS** (Apple system SQLite) | Document only |

### `.get()` null vs undefined — Breaking Change Detail

bun:sqlite `.get()` returns `null` when no row matches, not `undefined`.

**Production code — mostly safe:**
- `getRegisteredGroup()` — `if (!row) return undefined` catches both null and undefined
- `getRouterState()` — `row?.value` works with null (`null?.value` returns `undefined`)
- `getSession()` — same `?.` pattern, safe
- `getSessionTimestamps()` — same pattern, safe
- `getLastGroupSync()` — `row?.last_message_time || null`, safe
- `getLastBotMessageSeq()` — `row?.seq ?? 0`, safe
- `getLastSuccessTime()` — `row?.run_at ?? null`, safe
- **`getTaskById()`** — directly returns `.get()` result, **must normalize**

**Fix for `getTaskById()`:**
```typescript
export function getTaskById(id: string): ScheduledTask | undefined {
  return (db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) ?? undefined) as ScheduledTask | undefined;
}
```

**Test assertions affected (3 sites) — pass after fix above:**
- `db.test.ts:385`
- `ipc-auth.test.ts:281`
- `ipc-auth.test.ts:304`

### Files Changed (8 total)

| File | Changes |
|------|---------|
| `src/db.ts` | Import, type, 3x pragma, `getTaskById` null normalization |
| `src/imessage-host.ts` | Import, type |
| `src/db-migration.test.ts` | Import |
| `setup/groups.ts` | 2x import, 1x pragma |
| `setup/environment.ts` | Import |
| `setup/verify.ts` | Import |
| `setup/register.test.ts` | Import |
| `setup/environment.test.ts` | Import |

### Verification

- All 33 existing tests pass under `bun run test`
- Manual smoke test: send Telegram message, verify stored in DB
- Verify scheduled tasks fire and log to `task_run_logs`
- Verify session create/touch/expire/delete lifecycle
- Verify existing `store/messages.db` loads correctly (binary-compatible SQLite)

## Phase 4: Cleanup

**Risk:** None
**Ships after Phases 1-3 verified in production**

### Changes

**Remove from `package.json`:**
- `better-sqlite3` (dependency)
- `@types/better-sqlite3` (devDependency)
- `tsx` (devDependency)

**Update `package.json`:**
- `"engines"` field — document Bun version requirement

**Delete:**
- `package-lock.json` (if not already removed in Phase 1)

**Update documentation:**
- `CLAUDE.md` — dev commands, prerequisites
- `README.md` — prerequisites (Bun instead of Node for host)

## Rollback Strategy

- **Phase 1** can be reverted independently (restore `package-lock.json`, revert pre-commit hook)
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
| pino-pretty transport | Known | Medium | Direct stream import (verified fix) |
| `process.kill(-pid)` regression | Low | Medium | NanoClaw has fallback to positive PID |
| Launchd plist path wrong | Low | High | Test restart before committing |
| WAL sidecar persistence | Certain | None | Cosmetic; document only |
| Bun version incompatibility | Low | High | Pin minimum Bun version in engines |
