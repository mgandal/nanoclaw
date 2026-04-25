# Security Audit Fixes Implementation Plan

> **Status: SHIPPED 2026-03-21 → 2026-04-04.** All 11 actionable tasks landed with verified live artifacts. T1 proxy auth: `src/credential-proxy.ts:21 proxyToken = randomUUID()`, commit `02ca81e4` (also covers T6 redaction + T9). T2 shutdown drain + T3 seq cursor ORDER BY: commit `cfde348c` (verified at `src/db.ts:522,526,534,543,545`). T5 path-traversal validation: `src/pageindex-ipc.ts:32` regex `/^[A-Za-z0-9_-]{1,64}$/` + 3 sites in `src/ipc.ts`. T6 `redactContainerArgs()`: `src/container-runner.ts:62,1061`. SimpleMem token leak: `2e65f254`. Three critical trust-boundary gaps: `564c76ef`. Successor security work tracked under hardening Tier A/B and the C-class audit (commit range `9f633629..350019a8`); this plan is the predecessor, not subsumed. Open `- [ ]` checkboxes left as-is — banner is the source of truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all findings from the oracle's deep audit of the NanoClaw codebase, covering security, reliability, data integrity, and code quality issues.

**Architecture:** Incremental fixes to existing files. No new services or major refactors. Each task is independently testable.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, pino logger

---

### Task 1: Credential Proxy Authentication Token

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Generate random proxy token at startup and require it on every request**

In `credential-proxy.ts`, generate a `crypto.randomUUID()` token at startup. Reject requests missing `x-proxy-token` header. In `container-runner.ts`, pass the token as env var `CREDENTIAL_PROXY_TOKEN` to containers.

- [ ] **Step 2: Add request body size limit and timeout**

In `credential-proxy.ts`, reject requests with body > 10MB. Add a 120s timeout on the upstream request.

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`

---

### Task 2: Graceful Shutdown (Drain Active Work)

**Files:**
- Modify: `src/index.ts` (shutdown handler)
- Modify: `src/group-queue.ts` (shutdown method)

- [ ] **Step 1: Reorder shutdown to drain containers before closing proxy/channels**

In `src/index.ts` shutdown handler: first stop accepting new work (`queue.shutdown()`), then wait for active containers to finish (with grace timeout), then close proxy and channels. In `group-queue.ts`, make `shutdown()` close stdin on all active containers and wait for them to finish.

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

---

### Task 3: Monotonic Message Sequence Cursor

**Files:**
- Modify: `src/db.ts` (add seq column, update queries)
- Modify: `src/index.ts` (use seq-based cursors)

- [ ] **Step 1: Add `seq` autoincrement column to messages table**

Add migration in `createSchema()`: `ALTER TABLE messages ADD COLUMN seq INTEGER`. Create index on seq. Backfill existing rows with `UPDATE messages SET seq = rowid WHERE seq IS NULL`.

- [ ] **Step 2: Update `getNewMessages()` and `getMessagesSince()` to use seq cursor**

Change from `timestamp > ?` to `seq > ?`. Return `newSeq` instead of `newTimestamp`. Update `storeMessage()` to let SQLite assign seq via autoincrement trigger.

- [ ] **Step 3: Update `src/index.ts` to use seq-based cursors**

Replace `lastTimestamp` with `lastSeq` (number). Replace `lastAgentTimestamp` with `lastAgentSeq` (Record<string, number>). Update router state keys.

- [ ] **Step 4: Verify build compiles**

Run: `npm run build`

---

### Task 4: Fix outputChain Unhandled Rejection

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Add `.catch()` to `outputChain` in streaming parse**

Change `outputChain = outputChain.then(() => onOutput(parsed))` to `outputChain = outputChain.then(() => onOutput(parsed)).catch(err => logger.error({ err, group: group.name }, 'onOutput callback failed'))`.

- [ ] **Step 2: Add `.catch()` to `outputChain.then()` in close handler**

Ensure `outputChain.then(() => resolve(...))` also has `.catch()` fallback.

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`

---

### Task 5: Validate requestId to Prevent Path Traversal

**Files:**
- Modify: `src/pageindex-ipc.ts`
- Modify: `src/ipc.ts` (iMessage handler)

- [ ] **Step 1: Add `isValidRequestId()` helper and validate in both handlers**

Regex: `/^[A-Za-z0-9_-]{1,64}$/`. Reject invalid requestIds before they become filenames.

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

---

### Task 6: Redact Secrets from Logs

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Redact env args when logging container args**

Create a `redactContainerArgs()` function that replaces values of `-e KEY=VALUE` args where KEY matches sensitive patterns (TOKEN, SECRET, KEY, PASSWORD, OAUTH) with `***`. Use this in the debug log and in error log files.

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

---

### Task 7: Centralize Task Schedule Validation for update_task

**Files:**
- Modify: `src/ipc.ts` (update_task handler)
- Modify: `src/db.ts` (export validateSchedule helper)

- [ ] **Step 1: Extract schedule validation into shared helper**

Move the 30-min minimum check from `createTask()` into a reusable `validateTaskSchedule(type, value)` function exported from `db.ts`.

- [ ] **Step 2: Call validation in update_task IPC handler**

In `src/ipc.ts` `update_task` case, validate schedule before applying. Also handle `resume_task` to recompute `next_run` when resuming.

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`

---

### Task 8: Fix bus_publish IPC (Write to Tasks Dir)

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Change `bus_publish` tool to write IPC task file instead of local bus-queue.json**

Write to `TASKS_DIR` with `type: 'bus_publish'` so the host IPC watcher picks it up. Remove `appendBusQueueMessage()` function if now unused.

- [ ] **Step 2: Verify build compiles**

Run: `cd container/agent-runner && npm run build`

---

### Task 9: Re-validate Mounts in pageindex IPC Handler

**Files:**
- Modify: `src/ipc.ts` (pageindex mount building)

- [ ] **Step 1: Use `validateAdditionalMounts()` when building mount mappings for pageindex**

Replace raw mount building with validated mounts from `mount-security.ts`.

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

---

### Task 10: Use Shared Logger in mount-security.ts

**Files:**
- Modify: `src/mount-security.ts`

- [ ] **Step 1: Replace local pino instance with shared logger**

Import `{ logger }` from `./logger.js` instead of creating a new `pino()` instance.

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

---

### Task 11: Fix require() in db.ts

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Replace `require('cron-parser')` with ESM import**

Change `const { CronExpressionParser } = require('cron-parser')` to use the top-level import already present.

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

---

### Task 12: Final Verification

- [ ] **Step 1: Full build**

Run: `npm run build`

- [ ] **Step 2: Run tests**

Run: `npm test` (if tests exist)
