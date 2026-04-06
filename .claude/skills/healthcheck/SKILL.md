---
name: healthcheck
description: Quick health check of all NanoClaw services. ONLY reports status — does NOT attempt fixes unless explicitly asked.
---

# Health Check

Check status of all services. ONLY report status, do NOT attempt fixes unless explicitly asked.

Run these in parallel:

```bash
# QMD (port 8181)
curl -s -o /dev/null -w "QMD: %{http_code} %{time_total}s" http://localhost:8181/health

# SimpleMem (Docker, port 8200)
curl -s -o /dev/null -w "SimpleMem: %{http_code} %{time_total}s" http://localhost:8200/api/health

# Hindsight (port 8889)
curl -s -o /dev/null -w "Hindsight: %{http_code} %{time_total}s" --max-time 5 http://127.0.0.1:8889/mcp/hermes/

# Apple Notes (port 8184)
curl -s -o /dev/null -w "Apple Notes: %{http_code} %{time_total}s" --max-time 5 http://localhost:8184/mcp

# Todoist (port 8186)
curl -s -o /dev/null -w "Todoist: %{http_code} %{time_total}s" --max-time 5 http://localhost:8186/mcp

# Docker containers
docker ps --format "table {{.Names}}\t{{.Status}}" 2>&1
```

Report results in a table:

```
| Service | Status | Latency |
|---|---|---|
| QMD | ... | ... |
| SimpleMem | ... | ... |
| Hindsight | ... | ... |
| Apple Notes | ... | ... |
| Todoist | ... | ... |
```

Notes:
- Apple Notes/Todoist return 405 on GET — this means UP
- For deeper diagnostics (stats, test queries, local storage), use `/memory-status`
