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
# @llamaindex/liteparse: local PDF parser with spatial extraction + Tesseract.js OCR
# (exposed to agents via container/skills/liteparse/ — `lit` CLI)
RUN npm install -g agent-browser @anthropic-ai/claude-code @readwise/cli @llamaindex/liteparse

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
# + markitdown for Office/PDF/HTML → Markdown extraction (used by pptx skill)
# --break-system-packages is safe in containers (no venv needed)
# agent-reach pinned: v1.4.0, 2026-03-28, commit e178470
RUN pip3 install \
    'git+https://github.com/Panniantong/Agent-Reach.git@e178470320a4c61017c961902a84d83441f6acb0' \
    'yt-dlp==2025.12.8' \
    'markitdown[pptx,docx,xlsx,pdf]==0.0.1a3' \
    --break-system-packages && \
    npm install -g mcporter@0.8.1 @steipete/bird@0.8.0

# Pre-configure agent-reach as the node user (so config lands in /home/node/)
RUN su node -c "HOME=/home/node agent-reach install --env=auto"

# Install paperclip-gxl CLI (GXL-ai biomedical papers, paperclip.gxl.ai).
# Provides `paperclip mcp` stdio bridge registered in agent-runner when
# ~/.paperclip/credentials.json is mounted from host. Auth is per-user; CLI
# refreshes its own id_token using the mounted refresh_token.
# Pinned to PyPI 0.1.4; host installer may ship a slightly newer build.
RUN pip3 install 'gxl-paperclip==0.1.4' --break-system-packages && \
    paperclip --version

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

# Install entrypoint script.
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Apple Container only supports directory mounts (VirtioFS), so .env cannot be
# shadowed with a host-side /dev/null file mount. Instead the entrypoint starts
# as root, uses mount --bind to shadow .env, then drops to the host user via setpriv.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
