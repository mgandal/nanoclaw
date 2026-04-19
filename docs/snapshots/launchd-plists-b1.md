# launchd plist snapshots — B1 enforce mode

These plists live in `~/Library/LaunchAgents/` outside the repo.
Recorded here so an operator can restore them if lost.

Post-B1-enforce (2026-04-19): three bridges run in
`NANOCLAW_BRIDGE_AUTH=enforce` mode. QMD stays in warn until the SDK
session-init GET behavior is characterized.

## Apple Notes — com.apple-notes-mcp.plist (enforce)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.apple-notes-mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/mgandal/.cache/apple-notes-mcp/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/.cache/apple-notes-mcp/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/.cache/apple-notes-mcp/launchd-stderr.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/mgandal</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NANOCLAW_BRIDGE_AUTH</key>
        <string>enforce</string>
    </dict>
</dict>
</plist>
```

## Todoist — com.todoist-mcp.plist (enforce)

Same shape as apple-notes with:
- `Label`: `com.todoist-mcp`
- script path: `/Users/mgandal/.cache/todoist-mcp/start.sh`
- log paths: `/Users/mgandal/.cache/todoist-mcp/launchd-{stdout,stderr}.log`

## Calendar — com.calendar-mcp.plist (enforce)

Same shape as apple-notes with:
- `Label`: `com.calendar-mcp`
- script path: `/Users/mgandal/.cache/calendar-mcp/start.sh`
- log paths: `/Users/mgandal/.cache/calendar-mcp/launchd-{stdout,stderr}.log`

## QMD — com.qmd-proxy.plist (warn)

**No `EnvironmentVariables` dict** — QMD stays in warn mode pending
investigation of ~2 unauth'd GETs per container spawn. All other QMD
traffic is silent, indicating the bearer IS forwarded on regular MCP
calls. Flip to enforce after tracing the init-time GETs.

## Rollback

To roll any bridge back to warn: remove the `EnvironmentVariables`
dict, then:

```bash
launchctl unload ~/Library/LaunchAgents/<label>.plist
launchctl load   ~/Library/LaunchAgents/<label>.plist
```
