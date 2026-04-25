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
