# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

Primary languages: TypeScript (main), Python (Cognee/ML), Shell (ops). Key infrastructure: NanoClaw (Bun/Node agent framework), Cognee (memory/KG), Todoist API, Slack/Telegram bots, Docker services, Ollama for local LLMs.

## Response Length

Keep responses to the user very concise — they overtake the user's window size otherwise. No tables, headers, or insight blocks unless explicitly requested. Short sentences, direct answers, skip the recap.

## Testing Policy

ALWAYS run tests and verify fixes before declaring them done. Run the relevant test suite (`bun test` or targeted `bun --bun vitest run src/foo.test.ts`) or manually verify the fix works before committing or moving on. Never ship code without confirming it works. Use test-first (TDD) methodology when fixing bugs.

## Security

CRITICAL: Never uncomment, expose, or use ANTHROPIC_API_KEY or other sensitive API keys without explicit user permission. All secrets should remain in secure files, never hardcoded.

## Scope Discipline

Do NOT make changes beyond what was requested. When asked for status checks, only report status. When fixing one issue, don't refactor adjacent code. Avoid excessive changes.

## Wiki Knowledge Base

Path: `/Volumes/sandisk4TB/marvin-vault/98-nanoKB`

Persistent, cross-referenced wiki (~398 pages) covering Gandal Lab science, AI tooling, papers, tools, concepts, and syntheses. Feeds NanoClaw agents as the canonical reference when their local memory isn't enough.

When you need context not already in this project's files/conversation:
1. Read `wiki/hot.md` first (~500 words of recent context)
2. If not enough, read `wiki/overview.md` (executive summary, folder shape)
3. If you need a domain drill-down, read `wiki/<folder>/_index.md` for concepts/papers/tools/syntheses/methods/datasets
4. Only then read individual pages under `wiki/<folder>/`

Do NOT read the wiki for:
- General TypeScript/Node/Bun questions, language syntax, or framework docs
- Anything already in nanoclaw/ files or the current conversation
- Tasks unrelated to Gandal Lab science or the user's broader AI-tooling context

Never modify `wiki/log.md` past entries or anything under `98-nanoKB/sources/`.

## Quick Context

Single Node.js process with skill-based channel system. Currently Telegram-only (WhatsApp is a separate fork). Messages route to Claude Agent SDK running in Apple Container (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals, session timeouts |
| `src/container-runner.ts` | Spawns agent containers with mounts and MCP env vars |
| `src/container-runtime.ts` | Apple Container abstraction (runtime, gateway, orphan cleanup) |
| `src/mount-security.ts` | Validates additional mounts against external allowlist |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations and schema migrations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/agent-runner/src/index.ts` | Agent runner inside container (MCP servers, SDK query loop) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | All `nanoclaw.*` MCP tools exposed to in-container agents. Before editing a tool description, read `docs/context-engineering/tool-design.md` for the four-question rubric (what / when / inputs / returns). |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |
| `docs/context-engineering/` | Vendored design-rubric docs (memory systems, multi-agent patterns, tool design, filesystem context). Consult before architecture work; refresh every 3-6 months per that folder's README. |
| `scripts/sync/sync-all.sh` | Email + calendar sync (every 8h via launchd) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
bun run dev          # Run with hot reload
bun run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `bun scripts/apply-skill.ts .claude/skills/add-whatsapp && bun run build`) to install it. Existing auth credentials and groups are preserved.

## Infrastructure / Services

- Before attempting to fix or restart a service, first confirm its actual status. Do not assume a service is broken — check if it's already running (e.g., in Docker) before creating local configs or starting duplicate instances
- Honcho runs in Docker (shared with Hermes) on port 8010 — workspace "nanoclaw"
- QMD must bind to IPv4 (0.0.0.0), not just IPv6
- Todoist uses REST API v1 (not v2)
- When checking service status, report what you find — do NOT attempt to fix services that are already running correctly

## Debugging Rules

- When debugging, identify the actual root cause before implementing fixes. Do not cycle through multiple approaches without diagnosis
- Check for orphaned/stale processes FIRST when hitting database locks or port conflicts
- Check for stale processes, orphaned locks (especially SQLite), and port conflicts before trying other hypotheses
- When a user provides a new API token, trust it — don't claim it's identical to the old one
- When hitting auth errors, verify you're using the correct API version before cycling through other hypotheses

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
