# MCP Bridge Supervisors

Each external MCP service (Apple Notes, Todoist, Calendar) is reached
by containers via a two-tier topology:

```
Apple Container VM ──▶  proxy (0.0.0.0:81X4/X6/X8)
                         └─▶ supergateway (127.0.0.1:81X3/X5/X7)
                              └─▶ stdio MCP server (apple-notes-mcp / todoist-ai / calendar-mcp)
```

Both the proxy and the supergateway run under one bash supervisor per
bridge, launched by macOS launchd. The supervisor scripts live here
and are deployed to each bridge's cache directory by the installers.

## Files

| File | Purpose |
|------|---------|
| `start-apple-notes.sh` | Apple Notes supervisor → `~/.cache/apple-notes-mcp/start.sh` |
| `start-todoist.sh` | Todoist supervisor → `~/.cache/todoist-mcp/start.sh` |
| `start-calendar.sh` | Calendar supervisor → `~/.cache/calendar-mcp/start.sh` |
| `install-start-updates.sh` | Idempotent installer for the three start.sh files |
| `proxy-template.mjs` | Bearer-auth-checking HTTP proxy, shared by all three bridges |
| `shared-auth.mjs` | Bearer token validation helpers used by `proxy-template.mjs` |
| `qmd-proxy.mjs` | QMD bearer-auth proxy (separate topology, single tier) |
| `install-proxy-updates.sh` | Idempotent installer for proxy.mjs (B1 server enforcement) |

## Why the watchdog loop

The original cache `start.sh` ended with a bare `wait` syscall:

```bash
trap "kill $SG_PID $PROXY_PID 2>/dev/null; wait" TERM INT
wait   # <-- the bug
```

If one child (e.g. supergateway) dies but the other (proxy) survives,
`wait` blocks indefinitely on the survivor. The bash parent stays
alive. launchd's `KeepAlive=true` is fooled — `launchctl print` reports
state=running and last exit code "(never exited)" — but the bridge no
longer serves traffic on the dead child's port. This silent failure
was caught on 2026-05-10 when the Calendar supergateway died and the
bridge stayed broken for 14+ hours.

The patched scripts replace the bare `wait` with a `kill -0` watchdog:

```bash
while kill -0 "$SG_PID" 2>/dev/null && kill -0 "$PROXY_PID" 2>/dev/null; do
  sleep 5
done
exit 1   # any child death → bash exits non-zero → KeepAlive respawns
```

`exit 1` propagates the failure to launchd, which respawns the bash
root, which re-spawns both supergateway and proxy fresh. Recovery time:
~5–10 seconds.

## Diagnostic

If a bridge still appears healthy in `launchctl print` but a port is
dead, count the master's children:

```bash
pgrep -P "$(launchctl print "gui/$(id -u)/com.<service>-mcp" | awk '/^\s+pid /{print $3}')"
```

Two children (supergateway + proxy) plus an occasional transient
`sleep 5` from the watchdog loop is healthy. One child means the
bridge is in the silent-failure state — kickstart with
`launchctl kickstart -k gui/$(id -u)/com.<service>-mcp`.

## Installing

```bash
bash scripts/bridges/install-start-updates.sh           # install + kickstart all 3
bash scripts/bridges/install-start-updates.sh --dry-run # show what would change
bash scripts/bridges/install-start-updates.sh --no-restart  # install but defer the restart
```

The installer is idempotent — re-running with no changes is a no-op.
First-run on a previously-bare-wait cache file makes a one-time
backup at `start.sh.pre-watchdog`.
