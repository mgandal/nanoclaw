/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENTS_DIR,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  OLLAMA_ADMIN_TOOLS,
  OLLAMA_DEFAULT_MODEL,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { writeContextPacket } from './context-assembler.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode, proxyToken } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { OneCLI } from '@onecli-sh/sdk';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Cached QMD reachability flag — updated by the health monitor loop
 * in index.ts every HEALTH_MONITOR_INTERVAL (60s). Avoids blocking
 * container spawn with a synchronous HTTP call.
 */
let qmdReachable = false;
export function setQmdReachable(reachable: boolean): void {
  qmdReachable = reachable;
}
function isQmdReachable(): boolean {
  return qmdReachable;
}

function redactContainerArgs(args: string[]): string[] {
  const sensitiveKeys =
    /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|CREDENTIAL_PROXY_TOKEN|GITHUB_TOKEN|SUPADATA_API_KEY)=/i;
  return args.map((arg, i) => {
    if (i > 0 && args[i - 1] === '-e' && sensitiveKeys.test(arg)) {
      const eqIdx = arg.indexOf('=');
      return arg.slice(0, eqIdx + 1) + '***';
    }
    return arg;
  });
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  images?: Array<{ base64: string; mediaType: string }>;
  agentName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  agentName?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // .env shadowing is handled inside the container entrypoint via mount --bind
    // (Apple Container only supports directory mounts, not file mounts like /dev/null)

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Global memory directory — writable for main group (updates shared state),
  // read-only for all others
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: !group.isMain,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sync group-level skills (from groups/{folder}/skills/) into the session dir.
  // Runs AFTER container skills so group-specific skills override global ones.
  const groupSkillsSrc = path.join(groupDir, 'skills');
  if (fs.existsSync(groupSkillsSrc)) {
    for (const skillDir of fs.readdirSync(groupSkillsSrc)) {
      const srcDir = path.join(groupSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail credentials directory (for Gmail MCP inside the container)
  // Only main group gets read-write (needs to refresh OAuth tokens);
  // non-main groups get read-only to prevent credential exfiltration.
  const homeDir = os.homedir();
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: !isMain,
    });
  }

  // Paperclip-gxl credentials (for biomedical papers MCP/CLI inside container).
  // Mounted read-write for all groups because the CLI refreshes id_tokens on each call
  // (refresh_token itself does not rotate). Security trade-off vs. Gmail: the refresh_token
  // is readable by any agent with this mount — acceptable because paperclip is an external
  // low-privilege service, and read-only would prevent non-main agents (e.g. Simon in
  // code-claw/science-claw) from using it at all.
  const paperclipDir = path.join(homeDir, '.paperclip');
  if (fs.existsSync(path.join(paperclipDir, 'credentials.json'))) {
    mounts.push({
      hostPath: paperclipDir,
      containerPath: '/home/node/.paperclip',
      readonly: false,
    });
  }

  // Blogwatcher persistent state directory (for RSS read/unread tracking)
  // Only mounted for groups that use blogwatcher (VAULT-claw)
  if (group.folder === 'telegram_vault-claw') {
    const blogwatcherDir = path.join(DATA_DIR, 'blogwatcher', group.folder);
    fs.mkdirSync(blogwatcherDir, { recursive: true });
    mounts.push({
      hostPath: blogwatcherDir,
      containerPath: '/home/node/.blogwatcher',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Agent identity mount (read-only) for compound group containers
  if (agentName) {
    const agentDir = path.join(AGENTS_DIR, agentName);
    if (fs.existsSync(agentDir)) {
      mounts.push({
        hostPath: agentDir,
        containerPath: '/workspace/agent',
        readonly: true,
      });
    }
  }

  // Guardrail: detect duplicate container paths before they reach the runtime.
  // Apple Container's virtiofs rejects duplicate mount targets with errno 16 (EBUSY),
  // which silently kills ALL container spawns until the service is restarted.
  const seen = new Map<string, string>();
  for (const m of mounts) {
    const prev = seen.get(m.containerPath);
    if (prev) {
      throw new Error(
        `Duplicate container mount path '${m.containerPath}': ` +
          `'${prev}' and '${m.hostPath}' both target the same path. ` +
          `This would cause virtiofs errno 16 (EBUSY) at runtime.`,
      );
    }
    seen.set(m.containerPath, m.hostPath);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Forward Ollama admin tools flag if enabled
  if (OLLAMA_ADMIN_TOOLS) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }
  if (OLLAMA_DEFAULT_MODEL) {
    args.push('-e', `OLLAMA_DEFAULT_MODEL=${OLLAMA_DEFAULT_MODEL}`);
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/${proxyToken}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'ANTHROPIC_AUTH_TOKEN=placeholder');
  }

  // Pass QMD search endpoint URL only if daemon is reachable
  if (isQmdReachable()) {
    const qmdUrl = `http://${CONTAINER_HOST_GATEWAY}:8181/mcp`;
    args.push('-e', `QMD_URL=${qmdUrl}`);
  }

  // Pass Apple Notes MCP endpoint URL (only if configured in .env)
  const appleNotesEnv = readEnvFile(['APPLE_NOTES_URL']);
  const appleNotesUrl =
    process.env.APPLE_NOTES_URL || appleNotesEnv.APPLE_NOTES_URL;
  if (appleNotesUrl) {
    try {
      const parsed = new URL(appleNotesUrl);
      const hostname =
        parsed.hostname === 'localhost'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `APPLE_NOTES_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn(
        { appleNotesUrl },
        'Invalid APPLE_NOTES_URL, skipping Apple Notes',
      );
    }
  }

  // Pass Todoist MCP endpoint URL (only if configured in .env)
  const todoistEnv = readEnvFile(['TODOIST_URL']);
  const todoistUrl = process.env.TODOIST_URL || todoistEnv.TODOIST_URL;
  if (todoistUrl) {
    try {
      const parsed = new URL(todoistUrl);
      const hostname =
        parsed.hostname === 'localhost'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `TODOIST_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn({ todoistUrl }, 'Invalid TODOIST_URL, skipping Todoist');
    }
  }

  // Pass Hindsight memory MCP endpoint URL (bank-specific, e.g. /mcp/hermes/)
  const hindsightEnv = readEnvFile(['HINDSIGHT_URL']);
  const hindsightUrl = process.env.HINDSIGHT_URL || hindsightEnv.HINDSIGHT_URL;
  if (hindsightUrl) {
    try {
      const parsed = new URL(hindsightUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `HINDSIGHT_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn(
        { hindsightUrl },
        'Invalid HINDSIGHT_URL, skipping Hindsight',
      );
    }
  }

  // Pass Calendar MCP endpoint URL (only if configured in .env)
  const calendarEnv = readEnvFile(['CALENDAR_URL']);
  const calendarUrl = process.env.CALENDAR_URL || calendarEnv.CALENDAR_URL;
  if (calendarUrl) {
    try {
      const parsed = new URL(calendarUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `CALENDAR_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn({ calendarUrl }, 'Invalid CALENDAR_URL, skipping Calendar');
    }
  }

  // Pass Slack MCP endpoint URL (only if configured in .env)
  const slackMcpEnv = readEnvFile(['SLACK_MCP_URL']);
  const slackMcpUrl = process.env.SLACK_MCP_URL || slackMcpEnv.SLACK_MCP_URL;
  if (slackMcpUrl) {
    try {
      const parsed = new URL(slackMcpUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `SLACK_MCP_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn({ slackMcpUrl }, 'Invalid SLACK_MCP_URL, skipping Slack MCP');
    }
  }

  // Pass Exchange Mail Bridge HTTP API URL (macOS host bridge for AppleScript mail access)
  const mailBridgeEnv = readEnvFile(['MAIL_BRIDGE_URL']);
  const mailBridgeUrl =
    process.env.MAIL_BRIDGE_URL || mailBridgeEnv.MAIL_BRIDGE_URL;
  if (mailBridgeUrl) {
    try {
      const parsed = new URL(mailBridgeUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `MAIL_BRIDGE_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn(
        { mailBridgeUrl },
        'Invalid MAIL_BRIDGE_URL, skipping Mail Bridge',
      );
    }
  }

  // Pass Honcho user-modeling API URL
  const honchoEnv = readEnvFile(['HONCHO_URL']);
  const honchoUrl = process.env.HONCHO_URL || honchoEnv.HONCHO_URL;
  if (honchoUrl) {
    try {
      const parsed = new URL(honchoUrl);
      const hostname =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
          ? CONTAINER_HOST_GATEWAY
          : parsed.hostname;
      args.push(
        '-e',
        `HONCHO_URL=${parsed.protocol}//${hostname}:${parsed.port}${parsed.pathname}`,
      );
    } catch {
      logger.warn({ honchoUrl }, 'Invalid HONCHO_URL, skipping Honcho');
    }
  }

  // Pass Readwise access token (for readwise CLI in container)
  const readwiseEnv = readEnvFile(['READWISE_ACCESS_TOKEN']);
  const readwiseToken =
    process.env.READWISE_ACCESS_TOKEN || readwiseEnv.READWISE_ACCESS_TOKEN;
  if (readwiseToken) {
    args.push('-e', `READWISE_ACCESS_TOKEN=${readwiseToken}`);
  }

  // Pass GitHub credentials (for gh CLI in container)
  const githubEnv = readEnvFile(['GITHUB_TOKEN', 'GH_REPO']);
  const githubToken = process.env.GITHUB_TOKEN || githubEnv.GITHUB_TOKEN;
  if (githubToken) {
    args.push('-e', `GITHUB_TOKEN=${githubToken}`);
  }
  const ghRepo = process.env.GH_REPO || githubEnv.GH_REPO;
  if (ghRepo) {
    args.push('-e', `GH_REPO=${ghRepo}`);
  }

  // Pass Supadata API key (for follow-builders podcast transcripts)
  const supadataEnv = readEnvFile(['SUPADATA_API_KEY']);
  const supadataKey =
    process.env.SUPADATA_API_KEY || supadataEnv.SUPADATA_API_KEY;
  if (supadataKey) {
    args.push('-e', `SUPADATA_API_KEY=${supadataKey}`);
  }

  // Pass Ollama host URL for container access
  args.push('-e', `OLLAMA_HOST=http://${CONTAINER_HOST_GATEWAY}:11434`);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    if (isMain) {
      // Main containers start as root so the entrypoint can mount --bind
      // to shadow .env. Privileges are dropped via setpriv in entrypoint.sh.
      args.push('-e', `RUN_UID=${hostUid}`);
      args.push('-e', `RUN_GID=${hostGid}`);
    } else {
      args.push('--user', `${hostUid}:${hostGid}`);
    }
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain, input.agentName);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, input.isMain);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: redactContainerArgs(containerArgs).join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Pre-assemble context packet for the agent
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  await writeContextPacket(
    group.folder,
    input.isMain,
    groupIpcDir,
    input.agentName,
  );

  // Clear stale Session Continuity on fresh session (no existing sessionId)
  if (!input.sessionId && input.agentName) {
    const agentMemoryPath = path.join(AGENTS_DIR, input.agentName, 'memory.md');
    clearStaleSessionContinuity(agentMemoryPath);
  }

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { err, group: group.name },
                  'onOutput callback failed',
                );
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
                exitCode: code ?? undefined,
                timedOut: true,
              });
            })
            .catch((err) => {
              logger.error(
                { err, group: group.name },
                'Output chain failed during close',
              );
              resolve({
                status: 'error',
                result: null,
                error: `Output chain error: ${err instanceof Error ? err.message : String(err)}`,
                exitCode: code ?? undefined,
                timedOut: true,
              });
            });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
          exitCode: code ?? undefined,
          timedOut: true,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          redactContainerArgs(containerArgs).join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          exitCode: code ?? undefined,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain
          .then(async () => {
            // Collect tool calls and insert into action_log
            const toolCalls = collectToolCalls(
              path.join(groupIpcDir, 'output'),
            );
            if (toolCalls.length > 0) {
              try {
                const { insertActionLogEntries } = await import('./db.js');
                insertActionLogEntries(group.folder, toolCalls);
              } catch (err) {
                logger.warn(
                  { err, groupFolder: group.folder },
                  'Failed to collect tool calls into action_log',
                );
              }
            }
            logger.info(
              { group: group.name, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
              exitCode: code ?? undefined,
            });
          })
          .catch((err) => {
            logger.error(
              { err, group: group.name },
              'Output chain failed during close',
            );
            resolve({
              status: 'error',
              result: null,
              error: `Output chain error: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const endIdx = stdout.lastIndexOf(OUTPUT_END_MARKER);
        const startIdx = stdout.lastIndexOf(OUTPUT_START_MARKER, endIdx);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        // Collect tool calls and insert into action_log
        const toolCalls = collectToolCalls(path.join(groupIpcDir, 'output'));
        if (toolCalls.length > 0) {
          void (async () => {
            try {
              const { insertActionLogEntries } = await import('./db.js');
              insertActionLogEntries(group.folder, toolCalls);
            } catch (err) {
              logger.warn(
                { err, groupFolder: group.folder },
                'Failed to collect tool calls into action_log',
              );
            }
          })();
        }

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Remove the ## Session Continuity section from an agent's memory.md.
 * Called on fresh session start to prevent stale continuity from prior sessions.
 */
export function clearStaleSessionContinuity(memoryPath: string): void {
  if (!fs.existsSync(memoryPath)) return;
  const content = fs.readFileSync(memoryPath, 'utf-8');
  if (!content.includes('## Session Continuity')) return;
  const cleaned = content.replace(
    /\n*## Session Continuity\n[\s\S]*?(?=\n## |$)/,
    '',
  );
  const tmpPath = `${memoryPath}.tmp`;
  fs.writeFileSync(tmpPath, cleaned);
  fs.renameSync(tmpPath, memoryPath);
}

export interface ToolCallRecord {
  tool: string;
  paramsHash: string;
  timestamp: string;
}

/**
 * Read tool-call summary from container IPC output.
 * Cleans up the file after reading.
 */
export function collectToolCalls(ipcOutputDir: string): ToolCallRecord[] {
  const filePath = path.join(ipcOutputDir, 'tool-calls.json');
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const records = JSON.parse(raw) as ToolCallRecord[];
    fs.unlinkSync(filePath);
    return records;
  } catch {
    return [];
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  const tmpTasksFile = `${tasksFile}.tmp`;
  fs.writeFileSync(tmpTasksFile, JSON.stringify(filteredTasks, null, 2));
  fs.renameSync(tmpTasksFile, tasksFile);
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  const tmpGroupsFile = `${groupsFile}.tmp`;
  fs.writeFileSync(
    tmpGroupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpGroupsFile, groupsFile);
}
