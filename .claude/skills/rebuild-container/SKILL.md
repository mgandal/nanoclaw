---
name: rebuild-container
description: Rebuild the NanoClaw agent container with full cache invalidation and verification
---

Rebuild the NanoClaw agent container image. This performs a clean rebuild by invalidating both the buildkit cache and the per-group agent-runner source caches.

## Steps

### 1. Prune the buildkit cache

The builder volume retains stale COPY artifacts even with `--no-cache`. Prune it first:

```bash
container builder prune -f
```

### 2. Delete per-group agent-runner source caches

Each group caches a copy of the agent-runner source at first spawn. These must be deleted so groups pick up the new code:

```bash
rm -rf data/sessions/*/agent-runner-src/
```

### 3. Build the image

```bash
./container/build.sh 2>&1
```

If the build fails, read the error output and fix the issue before retrying. Common failures:
- Missing npm dependencies in container/agent-runner/package.json
- TypeScript compilation errors in container/agent-runner/src/

### 4. Verify the image exists

```bash
container image list | grep nanoclaw-agent
```

Confirm the image tag and timestamp look correct (should be seconds old).

### 5. Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 6. Verify startup

Wait a few seconds, then check the log for a clean startup:

```bash
tail -20 logs/nanoclaw.log
```

Look for the "NanoClaw started" log line and confirm no errors follow it.

## When to use

- After modifying any file under `container/agent-runner/`
- After modifying `container/Dockerfile` or `container/entrypoint.sh`
- After modifying container skills (`container/skills/`)
- When a group's agent is behaving strangely and you suspect stale cached code
- After upgrading dependencies used inside the container
