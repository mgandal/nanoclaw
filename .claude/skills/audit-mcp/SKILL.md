---
name: audit-mcp
description: >
  Audit every MCP server wired into NanoClaw — trust level, transport, last-update,
  and risk flags. Adapted from Terp's hermes-optimization-guide. Triggers: "/audit-mcp",
  "audit MCP servers", "mcp security check", "which MCPs are stale".
allowed-tools: Read Bash Glob Grep
---

# audit-mcp — MCP Server Security Audit

Walk every MCP server NanoClaw configures and produce a structured report with risk
flags. Runs entirely locally. Never auto-applies fixes.

## What counts as an "MCP server" in NanoClaw

Three surfaces:

1. **Container-side MCPs** wired into `container/agent-runner/src/index.ts` (nanoclaw,
   gmail, obsidian, qmd, honcho, hindsight, ollama, apple_notes, todoist, calendar).
2. **Host-side supergateway TCP proxies** that bridge stdio MCPs to the container
   (apple-notes 8184, todoist 8186, calendar 8188) and their `~/Library/LaunchAgents/`
   plists.
3. **External services** the agent reaches without a formal MCP wrapper (honcho Docker
   stack on 8010, QMD on 8181, Ollama on 11434).

## Procedure

1. **List container-side MCP declarations.** Grep `container/agent-runner/src/index.ts`
   for `name:` entries inside `mcpServers`. Note which are conditional (wrapped in
   `if (process.env.XXX_URL)`) vs unconditional.

2. **List host-side launchd plists** in `~/Library/LaunchAgents/` matching
   `com.*-mcp.plist` or `com.qmd*`, `com.apple-notes*`, `com.todoist*`, `com.calendar*`.
   For each: `launchctl list | grep com.<name>` to confirm it's loaded, and grab the
   RunAtLoad / KeepAlive flags from the plist.

3. **For each MCP, collect:**
   - Name + transport (`stdio` / `http` / `http-via-supergateway`)
   - Port (if TCP) and whether it binds to `0.0.0.0` (container-reachable) or `localhost`
   - Conditional env var gating its inclusion in the container
   - Last-updated timestamp of the source:
     - npm: `npm view <pkg> time.modified`
     - git: `git -C <path> log -1 --format=%cI`
     - Docker: `docker inspect <container> --format '{{.Created}}'`
   - Credentials path (e.g. `~/.gmail-mcp/credentials.json`, `TODOIST_API_TOKEN` in `.env`)

4. **Risk-flag each server:**
   - **🔴 HIGH** — reads untrusted content AND exposes write tools. Gmail (read + draft),
     Apple Notes (read + write), Todoist (read + create). Flag if no allowlist applied.
   - **🔴 HIGH** — TCP-bound to `0.0.0.0` without a firewall in front (supergateway
     proxies do this by design to be container-reachable — fine, but state it).
   - **🟡 MEDIUM** — last updated > 90 days ago.
   - **🟡 MEDIUM** — credentials in plain-file (not OneCLI vault). Check whether the
     MCP consumes keys via OneCLI gateway or directly from `.env`.
   - **🟡 MEDIUM** — conditional env var is set but the downstream service isn't running
     (e.g. `QMD_URL=http://...` but `curl $QMD_URL/health` fails).
   - **🟢 LOW** — unconditional MCPs with no allowlist that expose many tools.

5. **Render a table.** Columns: name, transport, port, trust, last-update age, creds
   path, flags.

6. **Recommend next steps**, grouped by flag color. Never auto-apply. Example output:

   ```markdown
   ## MCP Security Audit — YYYY-MM-DD

   ### 🔴 HIGH (1)
   - **gmail** — read + draft + send tools, credentials in `~/.gmail-mcp/credentials.json`
     (not OneCLI-gated). Suggest: move OAuth token to OneCLI, restrict to read-only unless
     the agent is in a group that actually sends mail.

   ### 🟡 MEDIUM (2)
   - **apple-notes** — @sweetrb/apple-notes-mcp last npm publish 143 days ago.
     Check for updates; review release notes before bumping.
   - **hindsight** — `HINDSIGHT_URL` is set in container env but `curl $HINDSIGHT_URL/health`
     fails. Either remove the env var or start the service.

   ### 🟢 LOW (0)

   ### Recommendations
   1. Run `launchctl list | grep com.` to sanity-check all launchd MCPs are loaded.
   2. For any MCP with write tools, review `tools_allowlist` in the container runner.
   3. Rotate credentials older than 6 months (Gmail OAuth token age is visible from
      `gcloud` or in the token file's `created_at` field).
   ```

## Notes

- **No data leaves the host.** Every command above is local.
- Pair with a weekly cron: add to `scripts/sync/sync-all.sh` as step N+1, or wire a
  launchd plist that runs `/audit-mcp` via the claw CLI.
- The output is designed to paste into Telegram as-is — keep it under ~50 lines by
  default, with detailed per-MCP breakdown available on request.
- If no MCPs flag, still render the table so the user can see the baseline.

## Sources

Adapted from `skills/security/audit-mcp/SKILL.md` in
[OnlyTerp/hermes-optimization-guide](https://github.com/OnlyTerp/hermes-optimization-guide).
Hermes-specific bits (config.yaml path, `allow_sampling` flag) replaced with NanoClaw's
container-runner + launchd surface.
