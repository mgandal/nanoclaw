# Phase 2: Long-Lived In-Container Agent + Idle Ticks — Architecture

**Status:** Architecture sketch, feasibility review
**Author:** Claude Sonnet 4.6
**Date:** 2026-05-19
**Prerequisite reading:** Phase 1 (`schedule_self_wakeup`), Proactive Claire design (`docs/superpowers/specs/2026-04-18-proactive-claire-design.md`)

---

## 1. Current State Forensics

### What "one-shot container per turn" actually means

The public description — "spawn fresh container per turn" — is partially wrong, and understanding the gap matters a great deal for this design.

**The real lifecycle:**

1. Host calls `runContainerAgent()` (`src/container-runner.ts:755`). It spawns `container run -i --rm --name nanoclaw-{group}-{ts} nanoclaw-agent:latest` and immediately writes the initial `ContainerInput` JSON to stdin, then closes stdin (`container.stdin.end()` at line 831).

2. Inside the container, `entrypoint.sh` reads stdin to a temp file (`/tmp/input.json`) and execs `node /app/dist/index.js`. The agent-runner `main()` (`container/agent-runner/src/index.ts:1006`) parses the JSON, then enters a `while(true)` loop (`line 1202`).

3. The loop runs a query via the Claude Agent SDK, emits results wrapped in `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` pairs, then calls `waitForIpcMessage()` which polls `/workspace/ipc/input/` every 500ms (`IPC_POLL_MS`, line 138).

4. On the host side, `GroupQueue.sendMessage()` (`src/group-queue.ts:176`) writes JSON files to `/workspace/ipc/{groupFolder}/input/` for subsequent messages. The container's poll picks these up and pipes them into the SDK's `MessageStream`.

5. The container exits when it reads a `_close` sentinel file at `/workspace/ipc/input/_close`. The host writes this via `GroupQueue.closeStdin()` (`src/group-queue.ts:210`), which is called from the `idleTimer` in `processGroupMessages` (`src/index.ts:515`) after `IDLE_TIMEOUT = 1800000ms` (30min, `src/config.ts:92`) with no new results.

6. The hard kill timer on the host is `max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)` = max(30min, 30.5min) = ~30.5min (`src/container-runner.ts:924`). The hard timeout resets on every `OUTPUT_START_MARKER` seen in stdout.

**What this means:** Containers are already long-lived multi-turn actors. A CLAIRE container processing a message will stay alive for up to 30 minutes waiting for follow-up messages before the idle timer fires `_close`. The "per-turn spawn" characterization describes the steady state for cold groups, not active ones.

**What IS recreated per turn (on cold groups):**
- The Linux VM itself (virtiofs mounts, kernel namespace)
- The Node.js process and agent-runner startup (~2-4s)
- The Honcho session initialization and context prefetch
- The MCP server connections (Streamable HTTP for QMD/Hindsight, stdio for nanoclaw/honcho/ollama)

**What IS reused within a session window:**
- The Claude Agent SDK session (`.jsonl` transcript on disk, resumed via `--resume sessionId`)
- Honcho context (prefetched per turn, but session ID is durable)
- All virtiofs-mounted state (group folder, agent memory, IPC dirs)

**Is there any existing "long-lived mode" or `AGENT_PROVIDER` path?**

No. A grep for `AGENT_PROVIDER`, `opencode`, `long-lived`, `keepAlive` finds nothing in `src/`. The memory note about "OpenCode agent provider runs agents in a long-lived poll loop inside the container" refers to the upstream OpenClaw project's architecture, not NanoClaw. NanoClaw's agent-runner already has a poll loop inside the container — it's architecturally halfway there — but the container is still spawned fresh per-session-start, not per-process.

**The meaningful gap between current state and Phase 2:**

Phase 2 would mean keeping the container alive indefinitely (or for a much longer window than 30min), and having the host push an "idle tick" message into the IPC poll even when no user message arrived. The container's `waitForIpcMessage()` loop already handles this: it would pick up a tick the same way it picks up a piped user message. The machinery exists. The question is whether keeping containers alive 24/7 is feasible.

---

## 2. Resource Budget

### What a running container costs

Apple Container uses Linux lightweight VMs (not Docker: no shared kernel, no cgroups in the Docker sense). Each `container run` creates an isolated VM. Based on the virtiofs mount pattern and Apple Container's architecture:

**Per-container steady-state costs (estimates, no `container stats` equivalent exists for Apple Container as of 2026-05):**

- VM memory overhead: ~50-80MB resident for the kernel + init, before any userspace
- Node.js agent-runner process: ~60-100MB RSS when idle in `waitForIpcMessage()`
- Claude Agent SDK in memory: SDK keeps the session transcript parsed; for an average 2-hour CLAIRE session this grows to 20-40MB of JSON
- MCP stdio subprocesses: the nanoclaw MCP server (Node.js, ~30-50MB) and ollama-mcp-stdio (~20MB) are launched per-container by the SDK
- Total per idle container: approximately **200-350MB resident**, possibly more after a busy session

**With 12 registered groups at steady state:**

- Always-on all 12: 12 × 250MB = **3 GB minimum RSS** just for idle containers, before any active work
- CPU: each idle container burns ~0.5-2% CPU for Node poll loops and filesystem watches. 12 × 1% = 12% of a core continuously
- This is on an M3 Max with shared memory. The MLX memory pressure incident (`project_mlx_memory_pressure_fix.md`) showed that 57GB IOAccelerator pressure + APFS 94% full caused Mac freezes. Adding 3GB baseline RSS from idle containers is non-trivial

**Group heat analysis:**

| Group | Activity level | Current container lifetime | Notes |
|-------|---------------|--------------------------|-------|
| CLAIRE (tg:8475020901) | Hot — daily, frequent | Often stays alive 30min between turns | Lead agent, most value from idle ticks |
| Claire DM (slack:D0AQ09RSF1B) | Warm | Spawns on message | Slack ingest pipeline drives some activity |
| LAB-claw + LAB-slack | Warm | Research queries, not continuous | Swarm uses Marvin/Warren/Vincent/FranklinClaw |
| CODE-claw, SCIENCE-claw | Occasional | Spawn on demand | Specialist contexts, Simon/Einstein/Vincent |
| HOME-claw | Rare | Spawn on demand | |
| OPS-claw | Rare but important | System alerts; must respond | |
| COACH-claw | Rare | Spawn on demand | Freud agent |
| VAULT-claw, CLINIC-claw | Very rare | Spawn on demand | Supergroups |
| emacs | Near-zero | Spawn on demand | Emacs MCP bridge |

Only CLAIRE and possibly LAB-claw have activity patterns dense enough to justify persistent containers.

**MAX_CONCURRENT_CONTAINERS = 8** (`src/config.ts:105`). With 12 groups and 8 slots, cold groups already wait for a slot. Always-on containers would immediately consume all 8 slots for the 8 most active groups and leave cold groups unable to start at all, even when a message arrives, unless the limit is raised or the concurrency model is rethought.

---

## 3. Proposed Architecture — Three Sub-Options

### Option (a): Always-on per group

One container per registered group, started at NanoClaw startup, running indefinitely. Idle ticks fire from a host-side timer for every group.

**How it would work:**
- At startup, for each registered group, spawn a container and keep the `runAgent()` promise open
- Replace `IDLE_TIMEOUT`-based `closeStdin()` with indefinite wait
- Host writes idle tick files to `/workspace/ipc/{group}/input/` on a timer (e.g., 5min)
- Container's `waitForIpcMessage()` loop consumes them identically to user messages
- Session expiry (`SESSION_IDLE_MS = 2h`) would need rethinking — idle ticks would constantly reset it, preventing session cleanup

**Problems:**
- 12 containers × ~250MB = 3GB baseline. Exceeds the 8-slot `MAX_CONCURRENT_CONTAINERS` limit immediately
- Apple Container quirks: each container is a VM. 12 VMs running 24/7 means 12 virtiofs mounts, 12 kernel instances, 12 Node processes, 12 sets of stdio MCP servers. The virtiofs `S_ISREG` quirk (`feedback_container_mount_paths.md`), stale mounts, and the EBUSY duplicate-mount guard (`src/container-runner.ts:447`) all become persistent failure modes rather than transient ones
- The session `SESSION_MAX_AGE_MS = 4h` guard (`src/index.ts:896`) would kill and respawn containers on the 4h boundary even if they're in the middle of processing an idle tick — needs careful coordination
- A crashed container for OPS-claw blocks all system alerts until the VM restarts

### Option (b): Hot pool + cold spawn

N "hot" groups (CLAIRE, LAB-claw, maybe OPS-claw) stay alive with persistent containers and idle ticks. Cold groups (everyone else) continue status quo: spawn on demand, exit on idle.

**How it would work:**
- `RegisteredGroup.containerConfig` gets a new boolean field `persistentContainer: true`
- At startup, `persistentGroups` are spawned immediately and kept alive by a `PersistentContainerManager` that restarts them on crash
- The idle tick timer in `src/index.ts` fires only for persistent groups
- Cold groups are unchanged: spawn on message, exit after `IDLE_TIMEOUT`
- Session expiry for persistent containers: idle ticks count as activity, so `SESSION_IDLE_MS` never fires. Need a separate concept: `TICK_SESSION_MAX_AGE_MS` (e.g., 8h) to force session rotation

**Problems:**
- 3 persistent containers (CLAIRE + LAB + OPS) × 250MB = 750MB: manageable
- Still consumes 3 of 8 concurrency slots permanently. With 12 groups competing for 5 remaining slots, the effective limit for cold groups drops from 8 to 5
- The concurrent container slot model (`GroupQueue.activeCount`) needs to be separated into "persistent" and "on-demand" pools, or persistent containers bypass the limit entirely (which introduces a different kind of runaway)
- Apple Container crash recovery: if a persistent VM dies (kernel panic, EBUSY, OOM), the restart logic must distinguish "crashed" from "closed by sentinel" — currently there's no such distinction in `GroupQueue`

### Option (c): Single shared session pool — idle ticks tied to session lifetime

No permanent containers. Instead, the host fires idle ticks while a session is active (i.e., within `SESSION_IDLE_MS`). When the session expires, the idle tick stops. The container stays alive via the existing `IDLE_TIMEOUT` mechanism, extended to match `SESSION_IDLE_MS`.

**How it would work:**
- `IDLE_TIMEOUT` is raised from 30min to match or exceed `SESSION_IDLE_MS` (2h) for groups that opt in
- A new host-side timer per active session fires an idle tick file to `/workspace/ipc/{group}/input/` every N minutes
- The container's poll loop picks it up and the agent decides what to do
- When the session expires or the user sends `/new`, the idle tick timer stops and the container closes normally
- No new container lifetime management; reuses the existing idle close mechanism

**Why this is the right approach:**

This option requires the smallest surface area change. The container loop already polls for IPC messages. The host already has idle timers per group. The only new pieces are:
1. A timer that periodically writes a tick file
2. A system prompt amendment that tells the agent what an idle tick is
3. A token budget governor that limits how many ticks per day actually invoke Claude

It avoids the permanent-container problems: containers still exit cleanly, session management stays intact, the `MAX_CONCURRENT_CONTAINERS` limit is unaffected, and Apple Container quirks remain bounded to active sessions rather than 24/7 uptime.

**Recommendation: Option (c) with elements of (b) for CLAIRE only.**

The full always-on model (a) is not feasible at 12 groups on current hardware given the MLX memory pressure context and 8-slot limit. Option (b) is worth pursuing for CLAIRE alone (1 persistent container, ~250MB, 1 slot consumed). Option (c) is the right architecture for the remaining groups.

---

## 4. Idle Tick Mechanics

### Delivery mechanism

The existing IPC inbound channel (`/workspace/ipc/{group}/input/`) is the correct delivery path. The agent-runner's `waitForIpcMessage()` at `container/agent-runner/src/index.ts:631` already drains `.json` files and returns their `text` field. A tick is just another message file.

**Tick file format:**

```json
{ "type": "idle_tick", "text": "[IDLE_TICK] ts=2026-05-19T14:05:00Z interval=5min", "tick_number": 42 }
```

The `drainIpcInput()` function at `container/agent-runner/src/index.ts:579` currently only processes `data.type === 'message'` files. It must be extended to also pass through `idle_tick` type with a distinct text prefix so the agent can pattern-match it.

Alternatively, the `text` field can simply start with a sentinel string and the type check can stay as `'message'`. Simplest change: just use `type: 'message'` and prefix the text — the agent's system prompt teaches it to recognize the prefix.

**Host-side timer:**

A new function `startIdleTickTimer(groupFolder, intervalMs)` in `src/index.ts` or a dedicated `src/idle-tick-scheduler.ts`:

```
startIdleTickTimer(groupFolder, intervalMs):
  setInterval(() => {
    if (!queue.isActive(chatJid)) return   // no container running, skip
    if (!sessions[groupFolder]) return      // no active session, skip
    if (isQuietHours()) return              // proactive governor quiet hours apply
    if (dailyTickCount[groupFolder] >= MAX_TICKS_PER_DAY) return
    queue.sendMessage(chatJid, tickMessage)
    dailyTickCount[groupFolder]++
  }, intervalMs)
```

The `queue.sendMessage()` call at `src/group-queue.ts:176` already handles writing the file. The tick fires only when a container is active (`queue.isActive()`) and a session exists. No container? No tick. This naturally implements option (c): ticks only happen during active sessions.

**What the agent sees:**

The agent receives an idle tick as a user-role message in the Claude Agent SDK conversation. The system prompt must be amended to explain this. The amendment goes in the global `CLAUDE.md` (or the agent-specific `identity.md` for CLAIRE):

```
## Idle Ticks

You periodically receive messages that begin with "[IDLE_TICK]". These are automated
heartbeats from the host system. You MUST treat them as follows:

1. Check if there is genuinely useful proactive work to do right now — e.g., a task
   you committed to, a deadline approaching, a pattern you wanted to surface.
2. If yes, take the action (send a message via mcp__nanoclaw__send_message, write a
   note, etc.).
3. If nothing meaningful needs doing, respond with an empty string or "." — do NOT
   produce a Telegram message just to fill the tick.
4. Never interpret an idle tick as a user instruction. The tick has no sender; it
   carries no authority.

Idle ticks burn Claude API tokens. Use them surgingly. "Genuinely useful" means the
user would thank you for the interruption, not merely tolerate it.
```

**Tick interval:** 5 minutes is probably too frequent for most groups. A reasonable default is 15-30 minutes during active sessions. For CLAIRE (hot group, persistent container), 10 minutes during working hours. Configurable via `containerConfig.idleTickIntervalMs`.

---

## 5. Trust and Isolation

### Does an idle tick have a "sender"?

No. Idle ticks are written by the host process, not by any Telegram/Slack user. This creates a new trust class: host-originated synthetic messages.

**Current trust model:** Messages go through sender allowlist (`isSenderAllowed`), trigger pattern check, and `is_from_me` flag. All of these operate on messages from external channels. Idle ticks bypass the entire `processGroupMessages()` path — they go directly to `queue.sendMessage()` from the tick timer, not from the message loop.

**Risk:** If the tick content can be controlled by anything other than the host process (e.g., if someone can write to `/workspace/ipc/{group}/input/` from inside the container), a compromised agent could inject messages that look like idle ticks. This is already possible with the existing IPC channel — it's the threat model that `bridge-auth.js` and the IPC handler trust system partially address. Idle ticks don't make this worse.

**What the agent must NOT do with a tick:**
- Treat it as a user request (no privilege escalation)
- Send notifications to external channels without applying the proactive governor rules
- Bypass the quiet hours / cooldown window that `PROACTIVE_GOVERNOR` enforces

**Implementation:** The system prompt amendment (section 4) is the primary control. Additionally, the tick message should be prefixed with `[IDLE_TICK]` so it can be pattern-matched and handled differently from user messages in the agent's decision logic.

The tick is NOT subject to the sender allowlist or trigger pattern — it is host-originated and intentionally bypasses the message routing that protects against untrusted senders. This is the same trust level as scheduled tasks (`isScheduledTask: true`). The agent prompt annotation `[IDLE_TICK]` should be treated with the same authority as `[SCHEDULED TASK]`.

---

## 6. Cost and Throttling

### Per-tick Claude API cost

Each idle tick that results in the agent doing meaningful work burns one Claude API turn. With Sonnet 4.6:
- Input tokens: ~8-20K (system prompt + session context + tick message)
- Output tokens: ~100-500 (most ticks should result in short or empty responses)
- Cost: roughly $0.01-0.05 per active tick (Sonnet pricing: $3/MTok in, $15/MTok out)

**Worst case without throttling:**

CLAIRE at 10min ticks × 24h × 30 days = 4,320 ticks/month × $0.03 average = $130/month just from ticks. This would be unacceptable.

**Required controls:**

1. **Max ticks per day per group.** Default: `MAX_TICKS_PER_DAY = 10` for CLAIRE, 3 for other groups. Configurable via `containerConfig.maxTicksPerDay`. Reset at midnight in the configured timezone.

2. **Proactive governor integration.** The existing `PROACTIVE_GOVERNOR` and quiet hours system (`src/config.ts:261-291`) should gate tick delivery. During `QUIET_HOURS_START` to `QUIET_HOURS_END`, no ticks fire. On `QUIET_DAYS_OFF`, no ticks fire.

3. **Agent-side early exit.** The system prompt must explicitly say: "If you have nothing to do, respond with just '.' (a single period). Do not produce a substantive response." Empty or trivial responses cost almost nothing.

4. **Minimum tick interval.** Hard floor of 10 minutes regardless of config, enforced in the timer startup code.

5. **Global daily cap.** `MAX_TOTAL_TICKS_PER_DAY = 30` across all groups combined. Implemented as an atomic counter in memory on the host. Prevents runaway costs if multiple groups are active simultaneously.

6. **Idle tick cooldown after activity.** If the user sent a message in the last N minutes (`AGENT_COOLDOWN_MINUTES = 20`, already in `src/config.ts:286`), skip the tick. The agent just responded; a tick is redundant.

7. **Dedup window.** Already in config: `DEDUP_WINDOW_HOURS = 24` (`src/config.ts:288`). Ticks that would produce the same output (e.g., "deadline reminder for paper X") should be gated by the proactive log's dedup mechanism.

**Estimated cost at safe settings:**

- CLAIRE: 10 ticks/day × 30 days = 300 ticks/month × $0.03 = $9/month
- Other groups: 3 ticks/day × 11 groups × 30 days = 990 ticks/month, but most will be no-ops ($0.003/no-op) = ~$3/month
- Total: ~$12/month incremental, well within reason

---

## 7. Failure Modes

### 7.1 Runaway tick loop

**Scenario:** Agent receives idle tick, decides to send a Telegram message. The Telegram message arrives in the group, gets stored in SQLite, triggers a new message poll, which spawns a new container (or pipes to the existing one), which generates another response, which produces another message, which the agent's next tick picks up as a conversation, which...

**Mitigation:** The existing `hasRecentIpcSend()` check at `src/index.ts:548` suppresses duplicate streaming output when the agent already sent via `send_message` IPC. The idle tick timer must also check `hasRecentIpcSend(chatJid)` before firing — if the agent just proactively sent a message, don't fire a tick for at least `AGENT_COOLDOWN_MINUTES`.

The deeper protection: idle tick responses from the agent should go through the proactive governor, not bypass it. An agent that wants to "send a message" as a result of a tick must call `mcp__nanoclaw__send_message`, which routes through the IPC handler. The proactive log then records the send, and the dedup window prevents the same agent from sending on the same topic again within 24h.

### 7.2 Container crash during tick

**Scenario:** Container is in the middle of processing an idle tick when the VM crashes (kernel panic, OOM kill). The tick file is deleted when consumed by `drainIpcInput()` (line 598 — unlinked after parsing), so it won't be replayed.

**Mitigation:** Loss of a tick is acceptable — unlike user messages, ticks are not important enough to guarantee delivery. The next tick will fire in N minutes anyway. The container crash recovery path is the same as today: `GroupQueue.drainGroup()` clears `state.active` on exit, and the next user message (or scheduled task) spawns a fresh container.

**Apple Container-specific concern:** Apple Container VMs can exit with exit code 137 (OOM) or die from virtiofs EBUSY. The hard timeout path at `src/container-runner.ts:926` handles this. For persistent containers (option b/CLAIRE), a restart watcher in `PersistentContainerManager` would need to distinguish "clean exit after _close" from "crash" to know whether to restart.

### 7.3 State drift between long-lived sessions and SQLite

**Scenario:** Container stays alive for 8 hours. During that time, `src/index.ts` updates `registeredGroups`, `sessions`, or task state in SQLite. The container has stale in-memory copies (e.g., `current_tasks.json` was written at spawn time, 8 hours ago).

**Mitigation (existing):** `writeTasksSnapshot()` is called by `runAgent()` on each invocation (`src/index.ts:675`). For user-message turns this is fine. For idle tick turns: since the tick is injected via `queue.sendMessage()` bypassing `runAgent()`, the tasks snapshot is NOT refreshed. The container will see stale task data when processing the tick.

**Required fix:** Before writing a tick file, the host should refresh the tasks/groups snapshots for that group, same as `runAgent()` does.

### 7.4 SESSION_MAX_AGE_MS collision with persistent container

**Scenario:** `SESSION_MAX_AGE_MS = 4h` triggers. Host kills the active container (`queue.closeStdin()` at `src/index.ts:907`) in the middle of the container's `waitForIpcMessage()` poll. The next user message spawns a fresh container with a new session.

**For idle ticks:** The kill-on-max-age logic fires at the message loop level (`src/index.ts:894`), only when `queue.isActive(chatJid)`. The tick timer must also check session age and stop firing ticks when `SESSION_MAX_AGE_MS` is approaching (within 30min), to avoid delivering a tick that the container won't be alive to process.

### 7.5 Apple Container virtiofs EBUSY

As noted in `CLAUDE.md`: "Apple Container's virtiofs rejects duplicate mount targets with errno 16 (EBUSY), which silently kills ALL container spawns until the service is restarted." This is a latent risk today but becomes acute if containers crash-and-restart frequently (as they would under option a/b with persistent containers). The duplicate mount guard at `src/container-runner.ts:447` catches this at arg-build time, but a sequence of rapid restart loops could still trigger it if `--rm` hasn't fully cleaned up before the next spawn.

**Mitigation for option b (persistent CLAIRE container):** Add a 10-second minimum restart delay in `PersistentContainerManager` after any unexpected container exit. Do not restart more than 3 times in 5 minutes before alerting OPS-claw.

---

## 8. Migration Plan

### Phase 2.0 — Plumbing only (CLAIRE opt-in)

**Scope:** Implement idle tick delivery without persistent containers. CLAIRE only. Manual test.

1. Add `containerConfig.idleTickIntervalMs` field to `RegisteredGroup` type and DB schema
2. Add `containerConfig.maxTicksPerDay` field
3. Implement `startIdleTickTimer(chatJid, group)` in `src/index.ts` that writes tick files when container is active, respects quiet hours and daily cap
4. Extend `drainIpcInput()` to pass through `idle_tick` type (or just use `type: 'message'` with prefix — simpler)
5. Amend CLAIRE's `groups/telegram_claire/CLAUDE.md` with the idle tick system prompt section
6. Set `idleTickIntervalMs = 1800000` (30min) and `maxTicksPerDay = 5` for CLAIRE
7. Monitor: log every tick fire and every non-empty tick response. Add `tick_fired` and `tick_acted` counts to the proactive log

Run for 1 week. Measure: how many ticks fire, how many produce meaningful agent output, what the token cost is.

### Phase 2.1 — Tune and expand

If Phase 2.0 produces useful proactive output at < $15/month and < 10% CPU overhead:

1. Enable ticks for LAB-claw and OPS-claw (with lower `maxTicksPerDay = 3`)
2. Tune tick intervals based on observed patterns
3. Add global daily cap enforcement
4. Add integration with proactive governor dedup log

### Phase 2.2 — Persistent container for CLAIRE (option b hybrid)

Only if Phase 2.1 is stable and the use case demonstrates clear value from having CLAIRE available with zero cold-start latency:

1. Implement `PersistentContainerManager` for CLAIRE
2. Raise `IDLE_TIMEOUT` to `SESSION_IDLE_MS` (2h) for CLAIRE specifically
3. Add crash recovery with restart delay
4. Move the `CLAIRE` entry to `persistentContainer: true` in the group config
5. Adjust `MAX_CONCURRENT_CONTAINERS` to exclude persistent containers from the limit

---

## 9. Decision Matrix

| Criterion | (a) Always-on all groups | (b) Hot pool (CLAIRE + 2) | (c) Session-scoped ticks |
|---|---|---|---|
| Implementation effort | High — PersistentContainerManager, concurrency rework, session management overhaul | Medium — PersistentContainerManager for N groups, rest unchanged | Low — timer + tick file write, system prompt amendment |
| Resource cost (steady state) | 3GB+ RAM, 12 VMs, high | ~750MB, 3 VMs | Near-zero when idle, spike on active sessions |
| Proactivity gain | Maximum — ticks even when user hasn't interacted in days | High for hot groups, zero for cold | Moderate — only proactive during active session window |
| Apple Container blast radius | Critical — 12 VMs crash-looping if virtiofs has a bad day | Moderate — 3 VMs | Low — same as today |
| Session management complexity | Breaks current 2h/4h model | Needs new session rotation concept | Unchanged |
| Token cost risk | High — all 12 groups burn tokens continuously | Moderate — 3 groups, gated by quiet hours | Low — only during active sessions, easy to cap |
| Recovery path if buggy | Must kill 12 VMs, restart service | Kill 3 persistent VMs | `PROACTIVE_ENABLED=false` kills ticks instantly |
| Rollback | Requires config change + restart | Per-group flag | Single env var |

---

## 10. Recommendation: Is This Worth Doing?

**Honest assessment:** Phase 1 (`schedule_self_wakeup`) already captures the majority of the proactivity value at essentially zero cost:

- Agents can schedule their own follow-up work at arbitrary future times
- Scheduled tasks already run in full container contexts with all tools available
- The scheduler loop fires every minute (`SCHEDULER_POLL_INTERVAL = 60000`, `src/config.ts:34`)
- A task scheduled for "5 minutes from now" is functionally identical to an idle tick from the agent's perspective

What idle ticks add that `schedule_self_wakeup` does NOT:

1. **Ambient awareness without explicit scheduling.** The agent doesn't have to predict when it will want to check something — the tick arrives and the agent can inspect current context (calendar, tasks, recent messages) and decide on the spot.

2. **Continuous session persistence.** An idle tick during an active session lets the agent respond within the same conversation thread, maintaining full conversation history. A scheduled task spawns a fresh session (or a group-context session that may be stale).

3. **Opportunistic reflection.** After a complex interaction, the agent can use a tick to consolidate understanding, update memory, or queue follow-up tasks — things that are hard to pre-schedule.

These benefits are real but incremental. The honest risk is that idle ticks without careful guardrails produce a stream of low-value messages from the agent ("Just checking in! Here's a reminder about...") that train the user to ignore proactive messages rather than value them. The Proactive Claire design (`docs/superpowers/specs/2026-04-18-proactive-claire-design.md`) made the same observation: "Measure before you build the smart part."

**Verdict:**

Phase 2 is worth doing, but only as Option (c) implemented as Phase 2.0 described above — session-scoped ticks, CLAIRE only, 30min interval, 5 ticks/day cap, measuring for 1 week before expanding. The persistent container architecture (Option a/b) is not ready for 12 groups and should be deferred until Phase 2.0 demonstrates sufficient value to justify the operational complexity.

The right question is not "is this worth the complexity of always-on containers?" but "is session-scoped idle tick delivery worth 150 lines of TypeScript and a system prompt amendment?" For that formulation, the answer is clearly yes.

**Do NOT implement Option (a) at this time.** The resource math does not work: 12 VMs × ~250MB + Apple Container's quirks + the MLX memory pressure context = a bad idea on current hardware.

**Do implement Option (c), Phase 2.0.** It reuses existing IPC infrastructure, is trivially reversible, and will generate the data needed to decide whether the more complex architecture is justified.

---

## Key File References

- Container lifecycle: `src/container-runner.ts:818-831` (spawn + stdin close), `src/config.ts:92` (`IDLE_TIMEOUT`)
- Container exit: `src/index.ts:510-521` (idle timer → `closeStdin`), `src/group-queue.ts:210` (`closeStdin` → writes `_close`)
- Agent poll loop: `container/agent-runner/src/index.ts:1199-1324` (`while(true)` query loop), line 1316 (`waitForIpcMessage`)
- IPC drain: `container/agent-runner/src/index.ts:579-625` (`drainIpcInput`)
- Message piping: `src/group-queue.ts:176` (`sendMessage` → writes JSON file)
- Concurrency limit: `src/config.ts:105` (`MAX_CONCURRENT_CONTAINERS = 8`)
- Session expiry: `src/config.ts:97-104` (`SESSION_IDLE_MS = 2h`, `SESSION_MAX_AGE_MS = 4h`)
- Proactive governor: `src/config.ts:261-291` (quiet hours, cooldown, dedup window)
- Hard timeout: `src/container-runner.ts:921-924` (`max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)`)
- Tick delivery target: write to `data/ipc/{groupFolder}/input/{timestamp}.json` (same path as `src/group-queue.ts:182`)
