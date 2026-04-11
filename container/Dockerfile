# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

# Build blogwatcher from source for native architecture (ARM64 on Apple Silicon)
FROM golang:1.24-bookworm AS blogwatcher-build
RUN git clone --depth 1 --branch v0.0.2 https://github.com/Hyaxia/blogwatcher.git /src
WORKDIR /src
RUN CGO_ENABLED=1 go build -o /blogwatcher ./cmd/blogwatcher

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @readwise/cli

# Install blogwatcher CLI for RSS feed monitoring (built from source in stage above)
COPY --from=blogwatcher-build /blogwatcher /usr/local/bin/blogwatcher

# Install agent-reach: gives agents read/search access to 15+ platforms
# (Twitter/X, YouTube, Reddit, GitHub, RSS, web, Bilibili, Weibo, Douyin, etc.)
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Install gh CLI (GitHub)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install agent-reach (from GitHub — not on PyPI) + yt-dlp + mcporter + bird
# --break-system-packages is safe in containers (no venv needed)
# agent-reach pinned: v1.4.0, 2026-03-28, commit e178470
RUN pip3 install \
    'git+https://github.com/Panniantong/Agent-Reach.git@e178470320a4c61017c961902a84d83441f6acb0' \
    'yt-dlp==2025.12.8' \
    --break-system-packages && \
    npm install -g mcporter@0.8.1 @steipete/bird@0.8.0

# Pre-configure agent-reach as the node user (so config lands in /home/node/)
RUN su node -c "HOME=/home/node agent-reach install --env=auto"

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies (--legacy-peer-deps for zod 3/4 conflict between agent-sdk and mcp-sdk)
RUN npm install --legacy-peer-deps

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Apple Container only supports directory mounts (VirtioFS), so .env cannot be
# shadowed with a host-side /dev/null file mount. Instead the entrypoint starts
# as root, uses mount --bind to shadow .env, then drops to the host user via setpriv.
RUN printf '#!/bin/bash\nset -e\n\n# Shadow .env so the agent cannot read host secrets\n# Try mount --bind first (Docker), fall back to truncation (Apple Container)\nif [ -f /workspace/project/.env ]; then\n  if [ "$(id -u)" = "0" ]; then\n    mount --bind /dev/null /workspace/project/.env 2>/dev/null || : > /workspace/project/.env\n  else\n    : > /workspace/project/.env 2>/dev/null || true\n  fi\nfi\n\n# Capture stdin (secrets JSON) to temp file\ncat > /tmp/input.json\n\n# Drop privileges if running as root (main-group containers)\nif [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then\n  chown "$RUN_UID:$RUN_GID" /tmp/input.json\n  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /app/dist/index.js < /tmp/input.json\nfi\n\nexec node /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
