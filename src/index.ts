import fs from 'fs';
import { createServer } from 'http';
import path from 'path';

import {
  AGENTS_DIR,
  ASSISTANT_NAME,
  CALENDAR_LOOKAHEAD_DAYS,
  CALENDAR_NAMES,
  CALENDAR_POLL_INTERVAL,
  CALENDAR_WATCHER_ENABLED,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  EVENT_ROUTER_ENABLED,
  getTriggerPattern,
  GMAIL_ACCOUNT,
  GMAIL_CREDENTIALS_PATH,
  GMAIL_POLL_INTERVAL,
  GROUPS_DIR,
  HEALTH_MONITOR_INTERVAL,
  IDLE_TIMEOUT,
  MAX_CONTAINER_SPAWNS_PER_HOUR,
  MAX_ERRORS_PER_HOUR,
  MAX_MESSAGES_PER_PROMPT,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  POLL_INTERVAL,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
  TRUST_MATRIX_PATH,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  setQmdReachable,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  getAgentRegistry,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageSeq,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  getSessionTimestamps,
  setSession,
  touchSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { initBotPool } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { HealthMonitor, createDefaultFixActions } from './health-monitor.js';
import { MessageBus } from './message-bus.js';
import { EventRouter, TrustConfig } from './event-router.js';
import { GmailWatcher } from './watchers/gmail-watcher.js';
import { CalendarWatcher } from './watchers/calendar-watcher.js';
import { checkMcpEndpoint } from './health-check.js';
import { appendAlert } from './system-alerts.js';
import { readEnvFile } from './env.js';
import YAML from 'yaml';
import {
  checkSessionExpiry,
  isStaleSessionError,
  parseLastAgentSeq,
} from './index-helpers.js';
import {
  scanAgents,
  getAgentsForGroup,
  type AgentIdentity,
  type AgentRegistryRow,
} from './agent-registry.js';
import { compoundKey, parseCompoundKey } from './compound-key.js';
import { BusWatcher } from './bus-watcher.js';

let lastSeq = 0;
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentSeq: Record<string, number> = {};
let messageLoopRunning = false;
let healthMonitor: HealthMonitor;
let loadedAgents: AgentIdentity[] = [];
let agentRegistry: AgentRegistryRow[] = [];
let busWatcher: BusWatcher | null = null;

const channels: Channel[] = [];
const queue = new GroupQueue();

// In-memory cache for image attachments (keyed by chat_jid:message_id).
// Images are too large for SQLite. Populated on message arrival, consumed
// when processGroupMessages builds the prompt, then cleared.
const pendingImages = new Map<
  string,
  Array<{ base64: string; mediaType: string }>
>();

function loadState(): void {
  lastSeq = parseInt(getRouterState('last_seq') || '0', 10);
  const agentSeqStr = getRouterState('last_agent_seq');
  lastAgentSeq = parseLastAgentSeq(agentSeqStr);
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_seq', String(lastSeq));
  setRouterState('last_agent_seq', JSON.stringify(lastAgentSeq));
}

/**
 * Get the message cursor for a chat, recovering from DB if missing.
 * Prevents sending the entire message history when the cursor is lost
 * (new group, corrupted state, or startup recovery).
 */
function getOrRecoverSeq(chatJid: string): number {
  const cached = lastAgentSeq[chatJid];
  if (cached && cached > 0) return cached;

  const recovered = getLastBotMessageSeq(chatJid);
  if (recovered > 0) {
    lastAgentSeq[chatJid] = recovered;
    saveState();
    logger.info(
      { chatJid, recovered },
      'Recovered message cursor from last bot reply',
    );
  }
  return recovered;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceSeq = getOrRecoverSeq(chatJid);
  const missedMessages = getMessagesSince(
    chatJid,
    sinceSeq,
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- /new command: reset session (host-side, no agent involved) ---
  const groupTriggerPattern = getTriggerPattern(group.trigger);
  const newCmdMsg = missedMessages.find((m) => {
    const text = m.content.trim().replace(groupTriggerPattern, '').trim();
    return text === '/new';
  });
  if (newCmdMsg) {
    const isAllowed = isMainGroup || newCmdMsg.is_from_me === true;
    if (isAllowed) {
      delete sessions[group.folder];
      deleteSession(group.folder);
      lastAgentSeq[chatJid] = missedMessages[missedMessages.length - 1].seq;
      saveState();
      await channel.sendMessage(chatJid, 'Session cleared. Starting fresh.');
      logger.info({ group: group.name }, 'Session reset via /new');
      return true;
    }
    // Unauthorized /new — don't return true, let remaining messages be processed
  }

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, undefined, undefined, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (seq) => {
        lastAgentSeq[chatJid] = seq;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = groupTriggerPattern.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  // Agent detection: check for @AgentName mentions in available agents
  const availableAgents = getAgentsForGroup(
    group.folder,
    loadedAgents,
    agentRegistry,
  );
  let targetAgent: string | undefined;

  if (availableAgents.length > 0) {
    const combinedText = missedMessages.map((m) => m.content).join(' ');
    for (const agent of availableAgents) {
      if (new RegExp(`@${agent.name}\\b`, 'i').test(combinedText)) {
        targetAgent = agent.dirName;
        break;
      }
    }
    // Fall back to Claire if registered and no explicit mention
    if (!targetAgent) {
      const claire = availableAgents.find((a) => a.dirName === 'claire');
      if (claire) targetAgent = claire.dirName;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Collect images from in-memory cache (populated by onMessage handler)
  const images: Array<{ base64: string; mediaType: string }> = [];
  for (const m of missedMessages) {
    const key = `${chatJid}:${m.id}`;
    const cached = pendingImages.get(key);
    if (cached) {
      images.push(...cached);
      pendingImages.delete(key);
    }
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = getOrRecoverSeq(chatJid);
  lastAgentSeq[chatJid] = missedMessages[missedMessages.length - 1].seq;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length, targetAgent },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    images.length > 0 ? images : undefined,
    targetAgent,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentSeq[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  images?: Array<{ base64: string; mediaType: string }>,
  agentName?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;

  // When an agent is targeted, use compound key for session isolation
  const effectiveGroupFolder = agentName
    ? compoundKey(group.folder, agentName)
    : group.folder;

  // Check if group is paused by health monitor
  if (healthMonitor?.isGroupPaused(group.folder)) {
    logger.warn(
      { group: group.name },
      'Skipping agent — group paused by health monitor',
    );
    return 'error';
  }

  // Expire sessions to prevent unbounded context growth.
  // Two thresholds:
  //   IDLE: no activity for 2 hours → expire (prevents stale sessions)
  //   MAX_AGE: session older than 4 hours total → expire (prevents active sessions from growing forever)
  // Session thresholds imported from config.ts
  let sessionId: string | undefined = sessions[effectiveGroupFolder];
  if (sessionId) {
    const { lastUsed, createdAt } = getSessionTimestamps(effectiveGroupFolder);
    const expireReason = checkSessionExpiry(
      createdAt,
      lastUsed,
      SESSION_IDLE_MS,
      SESSION_MAX_AGE_MS,
    );
    if (expireReason) {
      const idleAge = lastUsed
        ? Date.now() - new Date(lastUsed).getTime()
        : Infinity;
      const totalAge = createdAt
        ? Date.now() - new Date(createdAt).getTime()
        : Infinity;
      logger.info(
        {
          group: group.name,
          agentName,
          reason: expireReason,
          idleMinutes: lastUsed ? Math.round(idleAge / 60000) : 'unknown',
          totalMinutes: createdAt ? Math.round(totalAge / 60000) : 'unknown',
        },
        'Session expired, starting fresh',
      );
      delete sessions[effectiveGroupFolder];
      deleteSession(effectiveGroupFolder);
      sessionId = undefined;
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[effectiveGroupFolder] = output.newSessionId;
          setSession(effectiveGroupFolder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        images,
        agentName,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    healthMonitor?.recordSpawn(group.folder);

    if (output.newSessionId) {
      sessions[effectiveGroupFolder] = output.newSessionId;
      setSession(effectiveGroupFolder, output.newSessionId);
    } else if (sessions[effectiveGroupFolder]) {
      // Session resumed without new ID — still update last_used
      touchSession(effectiveGroupFolder);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession = sessionId && isStaleSessionError(output.error);

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[effectiveGroupFolder];
        deleteSession(effectiveGroupFolder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      healthMonitor?.recordError(
        group.folder,
        output.error || 'container error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    healthMonitor?.recordError(group.folder, String(err));
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newSeq } = getNewMessages(
        jids,
        lastSeq,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastSeq = newSeq;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<
          string,
          (NewMessage & { seq: number })[]
        >();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const groupLoopTrigger = getTriggerPattern(group.trigger);
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, groupLoopTrigger) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentSeq so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverSeq(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Before piping to an active container, check if the session
          // has exceeded max age. If so, kill the container so the message
          // goes through runAgent() which spawns a fresh session.
          if (queue.isActive(chatJid) && group) {
            const { createdAt } = getSessionTimestamps(group.folder);
            const totalAge = createdAt
              ? Date.now() - new Date(createdAt).getTime()
              : Infinity;
            if (totalAge > SESSION_MAX_AGE_MS) {
              logger.info(
                {
                  group: group.name,
                  totalMinutes: Math.round(totalAge / 60000),
                },
                'Active session exceeded max age, killing container for fresh start',
              );
              queue.closeStdin(chatJid);
              // Don't pipe — enqueue so processGroupMessages handles it with a fresh session
              queue.enqueueMessageCheck(chatJid);
              continue;
            }
          }

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentSeq[chatJid] =
              messagesToSend[messagesToSend.length - 1].seq;
            saveState();
            // Update session last_used so expiry timer resets on active use
            const grp = registeredGroups[chatJid];
            if (grp && sessions[grp.folder]) {
              touchSession(grp.folder);
            }
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastSeq and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceSeq = getOrRecoverSeq(chatJid);
    const pending = getMessagesSince(
      chatJid,
      sinceSeq,
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/** Send an alert to specified groups + persist for digests. */
async function sendSystemAlert(
  service: string,
  message: string,
  targetFolders: string[],
  fixInstructions?: string,
): Promise<void> {
  appendAlert({
    timestamp: new Date().toISOString(),
    service,
    message,
    fixInstructions,
  });

  for (const folder of targetFolders) {
    const jid = Object.keys(registeredGroups).find(
      (j) => registeredGroups[j]?.folder === folder,
    );
    if (!jid) continue;
    const channel = findChannel(channels, jid);
    if (!channel) continue;
    const text = fixInstructions
      ? `⚠️ *${service}*: ${message}\n\n_Fix:_ ${fixInstructions}`
      : `⚠️ *${service}*: ${message}`;
    await channel.sendMessage(jid, text).catch(() => {});
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Load agent identities from data/agents/
  loadedAgents = scanAgents(AGENTS_DIR);
  if (loadedAgents.length > 0) {
    logger.info(
      { agents: loadedAgents.map((a) => a.name) },
      'Loaded agent identities',
    );
  }

  // Load agent registry from DB
  agentRegistry = getAgentRegistry();

  // Health monitor — tracks spawn/error rates, alerts on anomalies
  healthMonitor = new HealthMonitor({
    maxSpawnsPerHour: MAX_CONTAINER_SPAWNS_PER_HOUR,
    maxErrorsPerHour: MAX_ERRORS_PER_HOUR,
    onAlert: (alert) => {
      logger.error({ tag: 'SYSTEM_ALERT', alert }, 'Health monitor alert');
      // Send to main group (existing behavior)
      const mainJid = Object.keys(registeredGroups).find(
        (jid) => registeredGroups[jid]?.isMain,
      );
      if (mainJid) {
        const channel = findChannel(channels, mainJid);
        channel
          ?.sendMessage(mainJid, `System alert: ${alert.detail}`)
          .catch(() => {});
      }
      // Also send infra alerts to CODE-claw
      if (alert.type === 'infra_error') {
        void sendSystemAlert(alert.group, alert.detail, ['telegram_code-claw']);
      }
    },
  });

  // Wire watchdog fix handlers
  const fixScriptsDir = path.join(process.cwd(), 'scripts', 'fixes');

  healthMonitor.addFixHandler({
    id: 'mcp-qmd',
    service: 'mcp:QMD',
    fixScript: path.join(fixScriptsDir, 'restart-qmd.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8181/health',
      expectStatus: 200,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'mcp-apple-notes',
    service: 'mcp:Apple Notes',
    fixScript: path.join(fixScriptsDir, 'restart-apple-notes.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8184/mcp',
      expectStatus: 405,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'mcp-todoist',
    service: 'mcp:Todoist',
    fixScript: path.join(fixScriptsDir, 'restart-todoist.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8186/mcp',
      expectStatus: 405,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'container-runtime',
    service: 'container-runtime',
    fixScript: path.join(fixScriptsDir, 'restart-container-runtime.sh'),
    verify: {
      type: 'command',
      cmd: '/usr/local/bin/container',
      args: ['system', 'status'],
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  healthMonitor.addFixHandler({
    id: 'sqlite-lock',
    service: 'sqlite-lock',
    fixScript: path.join(fixScriptsDir, 'kill-sqlite-orphans.sh'),
    verify: {
      type: 'command',
      cmd: '/bin/sh',
      args: ['-c', 'echo "SELECT 1" | sqlite3 store/messages.db'],
    },
    cooldownMs: 60_000,
    maxAttempts: 2,
  });

  healthMonitor.setFixActions(createDefaultFixActions());

  // Bootstrap Honcho workspace (create if not exists)
  const honchoBootstrapEnv = readEnvFile(['HONCHO_URL']);
  const honchoBootstrapUrl =
    process.env.HONCHO_URL || honchoBootstrapEnv.HONCHO_URL;
  if (honchoBootstrapUrl) {
    try {
      const res = await fetch(`${honchoBootstrapUrl}/v3/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'nanoclaw' }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        logger.info('Honcho workspace "nanoclaw" created');
      } else if (res.status === 409) {
        logger.debug('Honcho workspace "nanoclaw" already exists');
      } else {
        logger.warn(
          { status: res.status },
          'Honcho workspace bootstrap unexpected status',
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        'Honcho workspace bootstrap failed (Honcho may be down)',
      );
    }
  }

  // Periodically check health thresholds + MCP endpoints
  // Each endpoint has an optional healthUrl for services where the MCP URL
  // isn't suitable for health checks (e.g. SSE endpoints that hang or require auth).
  const mcpEndpoints: Array<{
    name: string;
    url: string | undefined;
    healthUrl?: string;
  }> = [
    { name: 'QMD', url: 'http://localhost:8181/mcp' },
    { name: 'Honcho', url: undefined as string | undefined },
    { name: 'Apple Notes', url: process.env.APPLE_NOTES_URL },
    { name: 'Todoist', url: process.env.TODOIST_URL },
    { name: 'Hindsight', url: process.env.HINDSIGHT_URL, healthUrl: 'http://127.0.0.1:8888/health' },
  ];

  // Read URLs from .env if not in process.env
  {
    const envUrls = readEnvFile([
      'HONCHO_URL',
      'APPLE_NOTES_URL',
      'TODOIST_URL',
      'HINDSIGHT_URL',
    ]);
    if (!mcpEndpoints[1].url && envUrls.HONCHO_URL) {
      mcpEndpoints[1].url = `${envUrls.HONCHO_URL}/v3/workspaces/list`;
    }
    if (!mcpEndpoints[2].url) mcpEndpoints[2].url = envUrls.APPLE_NOTES_URL;
    if (!mcpEndpoints[3].url) mcpEndpoints[3].url = envUrls.TODOIST_URL;
    if (!mcpEndpoints[4].url) mcpEndpoints[4].url = envUrls.HINDSIGHT_URL;
    if (!mcpEndpoints[4].healthUrl && mcpEndpoints[4].url) {
      mcpEndpoints[4].healthUrl = 'http://127.0.0.1:8888/health';
    }
  }

  setInterval(async () => {
    healthMonitor.checkThresholds();

    // Check MCP endpoints (only after channels are connected)
    if (channels.length === 0) return;
    for (const ep of mcpEndpoints) {
      if (!ep.url) continue;
      const result = await checkMcpEndpoint(ep.healthUrl || ep.url);
      if (result.reachable) {
        healthMonitor.clearInfraEvent(`mcp:${ep.name}`);
      } else {
        healthMonitor.recordInfraEvent(
          `mcp:${ep.name}`,
          `MCP server ${ep.name} is unreachable`,
        );
        // Auto-fix: attempt repair if handler registered and threshold met
        const failCount = healthMonitor.getInfraFailureCount(`mcp:${ep.name}`);
        if (failCount >= 3) {
          void healthMonitor.attemptFix(`mcp:${ep.name}`);
        }
      }
      // Update cached QMD reachability for container-runner
      if (ep.name === 'QMD') {
        setQmdReachable(result.reachable);
      }
    }
  }, HEALTH_MONITOR_INTERVAL);

  // Initial QMD health check so first container spawn has accurate state
  checkMcpEndpoint('http://localhost:8181/mcp').then((r) =>
    setQmdReachable(r.reachable),
  );

  // Inter-agent message bus
  const messageBus = new MessageBus(path.join(process.cwd(), 'data', 'bus'));
  setInterval(() => messageBus.pruneOld(72 * 3600_000), 6 * 3600_000);

  // Bus watcher: dispatch pending bus messages to agents
  if (loadedAgents.length > 0) {
    busWatcher = new BusWatcher(
      path.join(DATA_DIR, 'bus'),
      async (cKey, messages) => {
        const { group: baseGroup, agent } = parseCompoundKey(cKey);
        if (!agent) return;

        const chatJid = Object.entries(registeredGroups).find(
          ([, g]) => g.folder === baseGroup,
        )?.[0];
        if (!chatJid) {
          logger.warn(
            { compoundKey: cKey },
            'Bus dispatch: no chat JID for base group',
          );
          return;
        }

        logger.info(
          { compoundKey: cKey, messageCount: messages.length },
          'Bus dispatching to agent',
        );

        // Enqueue for processing through the normal queue system
        queue.enqueueMessageCheck(cKey);
      },
    );
    busWatcher.start();
  }

  // Event router and watchers (Phase 2)
  if (EVENT_ROUTER_ENABLED) {
    // Load trust matrix
    let trustRules: TrustConfig = { default_routing: 'notify', rules: [] };
    if (fs.existsSync(TRUST_MATRIX_PATH)) {
      try {
        trustRules = YAML.parse(
          fs.readFileSync(TRUST_MATRIX_PATH, 'utf-8'),
        ) as TrustConfig;
        logger.info('Trust matrix loaded');
      } catch (err) {
        logger.warn({ err }, 'Failed to parse trust matrix, using defaults');
      }
    } else {
      logger.info('No trust matrix found, using default routing (notify)');
    }

    const eventRouter = new EventRouter({
      ollamaHost: OLLAMA_HOST,
      ollamaModel: OLLAMA_MODEL,
      trustRules: trustRules.rules,
      defaultRouting: trustRules.default_routing,
      messageBus,
      healthMonitor,
      onEscalate: async (event) => {
        const mainJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid]?.isMain,
        );
        if (mainJid) {
          const channel = findChannel(channels, mainJid);
          await channel?.sendMessage(
            mainJid,
            `Escalated event: ${event.classification.summary}`,
          );
        }
      },
    });

    const watcherStateDir = path.join(DATA_DIR, 'watchers');

    // Gmail watcher
    if (fs.existsSync(GMAIL_CREDENTIALS_PATH)) {
      const gmailWatcher = new GmailWatcher({
        credentialsPath: GMAIL_CREDENTIALS_PATH,
        account: GMAIL_ACCOUNT,
        eventRouter,
        pollIntervalMs: GMAIL_POLL_INTERVAL,
        stateDir: watcherStateDir,
        onAuthFailure: (error) => {
          void sendSystemAlert(
            'Gmail',
            error,
            ['telegram_code-claw'],
            'Re-authorize Gmail OAuth: run the OAuth refresh flow in ~/.gmail-mcp/',
          );
        },
      });
      gmailWatcher
        .start()
        .catch((err) => logger.error({ err }, 'Gmail watcher failed to start'));
    } else {
      logger.info('Gmail credentials not found, Gmail watcher disabled');
    }

    // Calendar watcher (requires macOS Calendar TCC permission for the runtime binary)
    if (CALENDAR_WATCHER_ENABLED) {
      const calendarWatcher = new CalendarWatcher({
        calendars: CALENDAR_NAMES,
        eventRouter,
        pollIntervalMs: CALENDAR_POLL_INTERVAL,
        lookAheadDays: CALENDAR_LOOKAHEAD_DAYS,
        stateDir: watcherStateDir,
      });
      calendarWatcher
        .start()
        .catch((err) =>
          logger.error({ err }, 'Calendar watcher failed to start'),
        );
    } else {
      logger.info(
        'Calendar watcher disabled (set CALENDAR_WATCHER_ENABLED=true to enable)',
      );
    }

    logger.info('Event router and watchers initialized');
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
    (statusCode) => {
      void sendSystemAlert(
        'Credential Proxy',
        `${statusCode} auth failures from Anthropic API — token may be expired or invalid`,
        ['telegram_code-claw'],
        'Check CLAUDE_CODE_OAUTH_TOKEN in .env or run scripts/refresh-api-key.sh',
      );
    },
  );

  // Health endpoint for external heartbeat (separate from credential proxy)
  const startTime = Date.now();
  let startupComplete = false;
  const healthServer = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          uptime: Math.floor((Date.now() - startTime) / 1000),
          startupComplete,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const HEALTH_PORT = CREDENTIAL_PROXY_PORT + 1;
  healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
    logger.info({ port: HEALTH_PORT }, 'Health endpoint started');
  });

  // Event loop liveness: if the loop is blocked >30s, exit and let launchd restart
  let lastEventLoopTick = Date.now();
  setInterval(() => {
    lastEventLoopTick = Date.now();
  }, 5000);
  setInterval(() => {
    if (Date.now() - lastEventLoopTick > 30_000) {
      logger.fatal('Event loop stalled for >30s, exiting for launchd restart');
      process.exit(1);
    }
  }, 10_000);

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // 1. Stop bus watcher
    busWatcher?.stop();
    // 2. Stop accepting new work (signals containers to wind down)
    await queue.shutdown(15000);
    // 3. Now close proxy and channels (containers are done)
    proxyServer.close();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    // Only the owner (is_from_me) can start/stop remote control
    if (!msg.is_from_me) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not owner',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Cache image attachments in memory (not stored in DB — too large)
      if (msg.images?.length) {
        const key = `${chatJid}:${msg.id}`;
        pendingImages.set(key, msg.images);
      }
      try {
        storeMessage(msg);
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to store message');
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      try {
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to store chat metadata');
      }
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent swarm (send-only bots)
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
    },
    sendFile: async (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) {
        throw new Error(`Channel for JID ${jid} does not support sendFile`);
      }
      await channel.sendFile(jid, filePath, caption);
    },
    sendWebAppButton: async (jid, label, url) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        throw new Error(`No channel for JID: ${jid}`);
      }
      if (!channel.sendWebAppButton) {
        throw new Error(
          `Channel for JID ${jid} does not support sendWebAppButton`,
        );
      }
      await channel.sendWebAppButton(jid, label, url);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    messageBus,
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  startupComplete = true;
  logger.info('NanoClaw startup complete');
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
