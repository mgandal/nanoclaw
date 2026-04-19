# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| Schedule task with host `script` | ✓ | ✗ (A1) |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### Actions with trust-enforcement gates

The `checkTrust` + `pending_actions` pipeline (trust.yaml per-agent) gates
every IPC action that produces a privileged side effect for an agent
caller. Main-group callers (no agentName in the compound key) bypass the
agent trust gate.

Gated actions (C13 closed 2026-04-19):

- `send_message` (since 2026-03-21 audit; refactored to the shared
  `checkTrustAndStage` helper in C13 task 12)
- `send_slack_dm` (since multi-agent work; refactored in C13 task 13 —
  now stages draft/ask levels instead of silently blocking)
- `schedule_task`, `update_task`, `pause_task`, `resume_task`,
  `cancel_task`
- `publish_to_bus`
- `write_agent_memory`, `write_agent_state`
- `knowledge_publish`
- `deploy_mini_app`
- `kg_query`, `dashboard_query`

`save_skill` is main-only (deliberately not routed through agent trust;
any future agent path must add trust alongside A4 content validation).
`imessage_*` is main-only.

Defaults added to every agent trust.yaml in C13 task 14; operators can
override per-agent. Notable payload hardening from 2026-04-18 (Tier A)
still active:

- `schedule_task.agent_name` is regex-validated and must resolve to a
  direct child of `data/agents/` (B5).
- `publish_to_bus.summary` capped at 500 chars, `topic` at 100; the bus
  dispatcher XML-escapes and wraps every field in `<bus-message>` (B3).
- Group `skills/` syncs *after* the destination is wiped, *before*
  container skills, and rejects any skill whose frontmatter declares
  `allowed-tools: Bash` (A2).
- Inbound email body and classification snippets are wrapped in
  `<untrusted_email_body>` fences at both ingest and retrieval (A3).
- Agent `memory.md` Session Continuity and `hot.md` are wrapped in
  `<agent-memory-continuity>` / `<agent-memory-hot>` tags to prevent
  self-memory tag forgery (A5).
- Compound-key bus messages are wrapped in
  `<agent-bus-pending-content>` so a malicious bus payload can't
  forge the outer `<pending-bus-messages>` closer (BX1, 2026-04-19).
- Bus-watcher rejects bus files whose `from` is reserved (`SYSTEM`,
  `USER`, `MAIN`, `OWNER`, `ROOT`) or doesn't match the agent-name
  regex — rejected files land in `data/bus/agents/_errors/` for
  inspection (B3 iii, 2026-04-19).
- `send_file` rejects credential-named files and
  `refresh_token`/`client_secret`/private-key content from non-main
  groups. Main bypasses (operator tooling) (B2/B4, 2026-04-19).
- `/app/src` is mounted read-only so agent-written source can't
  become host code if a future entrypoint adds a build step (B7,
  2026-04-19).
- MCP bridges (QMD, Apple Notes, Todoist, Calendar, Honcho,
  Hindsight, Ollama, Slack, Mail Bridge) receive `Authorization:
  Bearer <NANOCLAW_BRIDGE_TOKEN>` on every container-initiated HTTP
  call. Each bridge proxy reads the shared token from `~/.cache/
  nanoclaw/bridge-token` (0600). **Apple Notes, Todoist, Calendar
  now run in enforce mode** — unauth'd POSTs get 401. QMD stays in
  warn mode pending investigation of one init-time GET per container
  spawn. Honcho/Hindsight/Ollama/Slack/Mail Bridge aren't yet in the
  enforcement scope. (B1 client/server, 2026-04-19.)
- `sync-all.sh` acquires a `mkdir`-based lock at
  `/var/tmp/nanoclaw-sync.lock.d` before running — concurrent
  launchd-fired runs exit silently; stale locks from dead holders
  are stolen (B9, 2026-04-19).
- Email export markdown files at `~/.cache/email-ingest/exported/`
  are written mode 0600 via `write_file_secure`. Existing files
  migrated on first load (BX2, 2026-04-19).

### 5. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### Known credential exceptions

The following credentials DO enter containers today. Each is a deliberate
trade-off, logged here so the threat model stays honest:

| Credential | Scope | Rationale |
|------------|-------|-----------|
| `~/.gmail-mcp/*` | Main: rw; non-main: ro | Gmail MCP inside container needs refresh rotation. `send_file` exfil path closed by the B2/B4 credential blocklist (2026-04-19); full host-bridge routing is future work. |
| `~/.paperclip/credentials.json` | All groups: rw | Paperclip CLI rotates `id_token` per call but `refresh_token` is long-lived. Non-main exfil path closed by the B2/B4 `send_file` credential blocklist (2026-04-19). |
| Secondary env tokens (`GITHUB_TOKEN`, `SUPADATA_API_KEY`, `READWISE_ACCESS_TOKEN`) | Main, or non-main groups listed in `containerConfig.allowedSecrets` | Opt-in per group; main group gets all. |

### Scheduled-task guard scripts (A1, 2026-04-18)

`schedule_task` accepts an optional `script` field that runs on the host as
`/bin/bash -c <script>` before spawning the agent container. As of the
2026-04-18 audit, this path is **gated to the main group only** — non-main
`schedule_task` calls with a `script` field are rejected at the IPC boundary.
Every guard-script execution emits an audit log entry (`"Guard script
executed"`) with a 500-char preview of the script content.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Store (SQLite DB) | `/workspace/project/store` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```
