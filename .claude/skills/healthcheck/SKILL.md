---
name: healthcheck
description: Quick health check of all NanoClaw services. ONLY reports status — does NOT attempt fixes unless explicitly asked.
---

# Health Check

Check status of all services. ONLY report status, do NOT attempt fixes unless explicitly asked.

Run these in parallel. For bridge services (Apple Notes / Todoist / Calendar) the public port is a *proxy* in front of a *supergateway* upstream — probe **both**, because a dead upstream still gets a 401 from the proxy.

```bash
# QMD (port 8181)
curl -s -o /dev/null -w "QMD: %{http_code} %{time_total}s\n" --max-time 5 http://localhost:8181/health

# SimpleMem (port 8200) — expected DOWN, replaced by Honcho 2026-04-06
curl -s -o /dev/null -w "SimpleMem: %{http_code} %{time_total}s\n" --max-time 2 http://localhost:8200/api/health

# Honcho (Docker, port 8010). /openapi.json is reliable; /health doesn't exist.
curl -s -o /dev/null -w "Honcho: %{http_code} %{time_total}s\n" --max-time 5 http://localhost:8010/openapi.json

# Hindsight proxy (8889) → worker (8888). 200 on the proxy alone does not prove the worker is alive.
curl -s -o /dev/null -w "Hindsight proxy: %{http_code} %{time_total}s\n" --max-time 5 http://127.0.0.1:8889/mcp/hermes/
lsof -ti -sTCP:LISTEN -i :8888 >/dev/null && echo "Hindsight worker 8888: UP" || echo "Hindsight worker 8888: DEAD"

# Apple Notes — proxy 8184, supergateway upstream 8183
curl -s -o /dev/null -w "Apple Notes proxy: %{http_code} %{time_total}s\n" --max-time 5 http://localhost:8184/mcp
lsof -ti -sTCP:LISTEN -i :8183 >/dev/null && echo "Apple Notes upstream 8183: UP" || echo "Apple Notes upstream 8183: DEAD"

# Todoist — proxy 8186, supergateway upstream 8185
curl -s -o /dev/null -w "Todoist proxy: %{http_code} %{time_total}s\n" --max-time 5 http://localhost:8186/mcp
lsof -ti -sTCP:LISTEN -i :8185 >/dev/null && echo "Todoist upstream 8185: UP" || echo "Todoist upstream 8185: DEAD"

# Calendar — proxy 8188, supergateway upstream 8187
curl -s -o /dev/null -w "Calendar proxy: %{http_code} %{time_total}s\n" --max-time 5 http://localhost:8188/mcp
lsof -ti -sTCP:LISTEN -i :8187 >/dev/null && echo "Calendar upstream 8187: UP" || echo "Calendar upstream 8187: DEAD"

# Docker containers
docker ps --format "table {{.Names}}\t{{.Status}}" 2>&1
```

Report results in a table:

```
| Service | Status | Latency | Notes |
|---|---|---|---|
| QMD | ... | ... | |
| SimpleMem | DOWN | — | expected — replaced by Honcho |
| Honcho | ... | ... | |
| Hindsight | ... | ... | proxy + worker both must be UP |
| Apple Notes | ... | ... | proxy 401 only healthy if upstream 8183 UP |
| Todoist | ... | ... | proxy 401 only healthy if upstream 8185 UP |
| Calendar | ... | ... | proxy 401 only healthy if upstream 8187 UP |
```

Notes:
- Apple Notes / Todoist / Calendar return **401** on bare GET — this is healthy (B1 bridge enforcement) **only if** the corresponding supergateway upstream port is also listening
- A bridge proxy 401 with a DEAD upstream is the silent-failure signature: containers will get ECONNREFUSED on any `tools/call`. Fix: `launchctl kickstart -k gui/$(id -u)/com.<service>-mcp`
- For deeper diagnostics (stats, test queries, local storage), use `/memory-status`
