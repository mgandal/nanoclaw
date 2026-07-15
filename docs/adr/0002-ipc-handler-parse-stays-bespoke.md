# Most IpcHandler `parse` bodies stay hand-written; only strict-shape handlers use shared Zod schemas

A 2026-07-15 review of all 22 `IpcHandler.parse` functions found they are not
shallow `typeof` guards: they encode per-handler leniency (dashboard/deploy
substitute `undefined`, knowledge-publish clamps confidence to [1,10] and
defaults missing fields), snake→camel wire renames (imessage `since_days`,
publish-to-bus `to_agent`), and path-traversal hardening (publish-to-bus
rejects `..`/`/` in the agent key). Only 5 (cancel/pause/resume-task, message,
send_file) are pure strict shape-checks.

We migrated those 5 to shared Zod schemas (`src/ipc/wire-schemas.ts`,
`wireParse`) with a fuzz parity test, and deliberately left the other 17 with
bespoke `parse` bodies.

## Why not convert all 22

A generic `schema.safeParse` erases the leniency and hardening, which are
load-bearing, not boilerplate — a schema stricter than its handler silently
drops valid production IPC (the pilot's own parity test caught exactly this:
`z.string().optional()` rejects `{sender: 42}` where the guard coerced it to
`undefined`; fixed with `.catch(undefined)`). Faithfully reproducing 17
handlers' quirks in Zod is a large, drop-a-payload-if-wrong task best done one
handler at a time against each one's existing tests, not as a session-tail
sweep. Revisit incrementally; do not treat the remaining bespoke parses as
tech debt to bulk-convert.
