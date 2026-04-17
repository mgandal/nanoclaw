import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  AGENTS_DIR,
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import { parseCompoundKey, fsPathToCompoundKey } from './compound-key.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  insertAgentAction,
  insertPendingAction,
  updateTask,
  validateTaskSchedule,
} from './db.js';
import { loadAgentTrust } from './agent-registry.js';
import { checkTrust } from './trust-enforcement.js';
import { resolveGroupFolderPath, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { handleDashboardIpc } from './dashboard-ipc.js';
import { handleDeployMiniApp } from './vercel-deployer.js';
import { handlePageindexIpc } from './pageindex-ipc.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendWebAppButton?: (jid: string, label: string, url: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  messageBus?: import('./message-bus.js').MessageBus;
}

let ipcWatcherRunning = false;

/**
 * Tracks chatJids that received IPC send_message deliveries recently.
 * Used by the streaming output callback to suppress duplicate sends
 * when pool bots already delivered the agent's message via IPC.
 * Entries auto-expire after 60 seconds.
 */
const recentIpcSends = new Map<string, number>(); // chatJid → timestamp

export function markIpcSend(chatJid: string): void {
  recentIpcSends.set(chatJid, Date.now());
}

export function hasRecentIpcSend(chatJid: string): boolean {
  const ts = recentIpcSends.get(chatJid);
  if (!ts) return false;
  // Expire after 60 seconds
  if (Date.now() - ts > 60_000) {
    recentIpcSends.delete(chatJid);
    return false;
  }
  return true;
}

export function clearIpcSend(chatJid: string): void {
  recentIpcSends.delete(chatJid);
}

/**
 * Deliver a send_message payload through the appropriate channel path:
 * WebApp button → pool bot with sender prefix → plain main-bot send.
 *
 * Pure delivery: no trust check, no audit log. Callers (processIpcMessage
 * for fresh actions, approval executor for replayed ones) are responsible
 * for those concerns so they can attribute outcomes correctly.
 *
 * On pool-bot delivery, marks the chatJid as recently-IPC-sent to suppress
 * duplicate output from the streaming callback.
 */
export async function deliverSendMessage(
  data: {
    chatJid: string;
    text: string;
    sender?: string;
    webAppUrl?: string;
  },
  deps: Pick<IpcDeps, 'sendMessage' | 'sendWebAppButton'>,
  sourceGroup: string,
): Promise<void> {
  if (
    data.webAppUrl &&
    typeof data.webAppUrl === 'string' &&
    deps.sendWebAppButton
  ) {
    await deps.sendWebAppButton(data.chatJid, data.text, data.webAppUrl);
    logger.info(
      { chatJid: data.chatJid, sourceGroup },
      'IPC WebApp button sent',
    );
    return;
  }

  if (
    data.sender &&
    data.chatJid.startsWith('tg:') &&
    TELEGRAM_BOT_POOL.length > 0
  ) {
    const sent = await sendPoolMessage(
      data.chatJid,
      data.text,
      data.sender,
      sourceGroup,
    );
    if (!sent) {
      const prefixed = `*${data.sender}:*\n${data.text}`;
      await deps.sendMessage(data.chatJid, prefixed);
    }
    markIpcSend(data.chatJid);
    logger.info(
      { chatJid: data.chatJid, sourceGroup, sender: data.sender },
      'IPC message sent',
    );
    return;
  }

  await deps.sendMessage(data.chatJid, data.text);
  logger.info(
    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
    'IPC message sent',
  );
}

function cleanupStaleProcessing(ipcBaseDir: string): void {
  try {
    const errorDir = path.join(ipcBaseDir, 'errors');
    for (const groupDir of fs.readdirSync(ipcBaseDir)) {
      const groupPath = path.join(ipcBaseDir, groupDir);
      if (!fs.statSync(groupPath).isDirectory() || groupDir === 'errors')
        continue;
      for (const subDir of ['messages', 'tasks']) {
        const dirPath = path.join(groupPath, subDir);
        if (!fs.existsSync(dirPath)) continue;
        const stale = fs
          .readdirSync(dirPath)
          .filter((f) => f.endsWith('.processing'));
        for (const file of stale) {
          fs.mkdirSync(errorDir, { recursive: true });
          try {
            fs.renameSync(
              path.join(dirPath, file),
              path.join(errorDir, `${groupDir}-stale-${file}`),
            );
          } catch {
            // already moved or gone
          }
        }
        if (stale.length > 0) {
          logger.warn(
            { group: groupDir, subDir, count: stale.length },
            'Moved stale .processing IPC files to errors/',
          );
        }
      }
    }
  } catch {
    // Non-fatal: best-effort cleanup
  }
}

/**
 * Resolve a container file path to the host filesystem.
 * Only resolves known mount prefixes — returns null for unknown paths.
 */
function resolveContainerFilePathToHost(
  containerFilePath: string,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  if (containerFilePath.includes('..')) return null;

  const projectRoot = path.resolve(GROUPS_DIR, '..');

  // /workspace/group/... → groups/{sourceGroup}/...
  if (containerFilePath.startsWith('/workspace/group/')) {
    const rel = containerFilePath.slice('/workspace/group/'.length);
    return path.join(GROUPS_DIR, sourceGroup, rel);
  }

  // /workspace/project/... → project root/...
  if (containerFilePath.startsWith('/workspace/project/')) {
    const rel = containerFilePath.slice('/workspace/project/'.length);
    return path.join(projectRoot, rel);
  }

  // /workspace/extra/{name}/... → resolve from group's containerConfig
  if (containerFilePath.startsWith('/workspace/extra/')) {
    const rest = containerFilePath.slice('/workspace/extra/'.length);
    const slashIdx = rest.indexOf('/');
    const mountName = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const rel = slashIdx >= 0 ? rest.slice(slashIdx + 1) : '';

    // Find the group's container config to resolve the mount
    for (const group of Object.values(registeredGroups)) {
      if (group.folder !== sourceGroup) continue;
      const mounts = group.containerConfig?.additionalMounts;
      if (!mounts) break;
      for (const m of mounts) {
        if (m.containerPath === mountName) {
          return path.join(m.hostPath, rel);
        }
      }
      break;
    }
  }

  // /workspace/agent/... → data/agents/{agentName}/...
  if (containerFilePath.startsWith('/workspace/agent/')) {
    const { agent } = parseCompoundKey(fsPathToCompoundKey(sourceGroup));
    if (!agent) return null;
    const rel = containerFilePath.slice('/workspace/agent/'.length);
    if (rel.includes('..')) return null;
    return path.join(AGENTS_DIR, agent, rel);
  }

  return null;
}

/**
 * Process a single IPC message (send_message or send_file).
 * Extracted from the inline watcher loop for testability.
 */
export async function processIpcMessage(
  data: {
    type: string;
    chatJid?: string;
    text?: string;
    sender?: string;
    webAppUrl?: string;
    filePath?: string;
    caption?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  if (data.type === 'message' && data.chatJid && data.text) {
    // Authorization: verify this group can send to this chatJid
    const targetGroup = registeredGroups[data.chatJid];
    // For compound groups, extract base group for authorization
    const baseKey = fsPathToCompoundKey(sourceGroup);
    const { group: baseGroupFolder, agent: agentName } =
      parseCompoundKey(baseKey);
    if (isMain || (targetGroup && targetGroup.folder === baseGroupFolder)) {
      // Trust enforcement for compound groups (agents)
      let trustDecisionForNotify: ReturnType<typeof checkTrust> | null = null;
      if (agentName) {
        const trust = loadAgentTrust(path.join(AGENTS_DIR, agentName));
        const decision = checkTrust(
          agentName,
          baseGroupFolder,
          'send_message',
          trust,
        );
        trustDecisionForNotify = decision;
        insertAgentAction({
          agent_name: agentName,
          group_folder: baseGroupFolder,
          action_type: 'send_message',
          trust_level: decision.level,
          summary: data.text.slice(0, 200),
          target: data.chatJid,
          outcome: decision.allowed
            ? 'allowed'
            : decision.stage
              ? 'staged'
              : 'blocked',
        });
        if (!decision.allowed) {
          if (decision.stage) {
            // Route through the approval queue instead of silently dropping.
            const pendingId = insertPendingAction({
              agent_name: agentName,
              group_folder: baseGroupFolder,
              action_type: 'send_message',
              summary: data.text.slice(0, 500),
              payload: {
                type: 'message',
                chatJid: data.chatJid,
                text: data.text,
                sender: data.sender,
                webAppUrl: data.webAppUrl,
              },
            });
            logger.info(
              {
                pendingId,
                agentName,
                level: decision.level,
                chatJid: data.chatJid,
              },
              'Trust: send_message staged for approval',
            );
            // TODO(A4): surface pending actions in morning briefing; for now
            // the agent's next session will see it via the pending_approvals
            // dashboard query or the /pending session command.
          } else {
            logger.info(
              {
                agentName,
                chatJid: data.chatJid,
                sourceGroup,
                level: decision.level,
              },
              'Trust: send_message blocked for agent',
            );
          }
          return;
        }
      }

      await deliverSendMessage(
        {
          chatJid: data.chatJid,
          text: data.text,
          sender: data.sender,
          webAppUrl: data.webAppUrl,
        },
        deps,
        sourceGroup,
      );

      // Post-hoc notification: if the trust level was 'notify', surface a
      // short receipt in the main group so the user sees what happened
      // without needing to check the group directly. Best-effort; failure
      // to notify does not roll back the already-sent message.
      if (trustDecisionForNotify?.notify && agentName) {
        try {
          const mainJid = Object.entries(registeredGroups).find(
            ([, g]) => g.isMain,
          )?.[0];
          if (mainJid && mainJid !== data.chatJid) {
            await deps.sendMessage(
              mainJid,
              `ℹ️ ${agentName} → ${registeredGroups[data.chatJid]?.name || data.chatJid}: ${data.text.slice(0, 200)}`,
            );
          }
        } catch (err) {
          logger.warn(
            { err, agentName, chatJid: data.chatJid },
            'notify-level post-hoc notification failed',
          );
        }
      }
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC message attempt blocked',
      );
    }
  } else if (
    data.type === 'send_file' &&
    data.chatJid &&
    data.filePath &&
    deps.sendFile
  ) {
    const targetGroup = registeredGroups[data.chatJid];
    // For compound groups, extract base group for authorization
    const sfBaseKey = fsPathToCompoundKey(sourceGroup);
    const { group: sfBaseGroup } = parseCompoundKey(sfBaseKey);
    if (isMain || (targetGroup && targetGroup.folder === sfBaseGroup)) {
      // Resolve container path to host path (or pass through absolute host paths)
      let hostFilePath: string | null;
      if (
        isMain &&
        data.filePath.startsWith('/') &&
        !data.filePath.startsWith('/workspace/') &&
        !data.filePath.includes('..') &&
        fs.existsSync(data.filePath)
      ) {
        // Absolute host path pass-through: restricted to main group only.
        // Non-main groups would otherwise be able to exfiltrate arbitrary
        // host files (SSH keys, credentials) by sending them to their own JID.
        hostFilePath = data.filePath;
      } else {
        hostFilePath = resolveContainerFilePathToHost(
          data.filePath,
          sourceGroup,
          registeredGroups,
        );
      }
      if (!hostFilePath || !fs.existsSync(hostFilePath)) {
        logger.warn(
          {
            chatJid: data.chatJid,
            sourceGroup,
            containerPath: data.filePath,
            hostFilePath,
          },
          'IPC send_file: file not found or path not resolvable',
        );
      } else {
        await deps.sendFile(data.chatJid, hostFilePath, data.caption);
        logger.info(
          {
            chatJid: data.chatJid,
            sourceGroup,
            hostFilePath,
          },
          'IPC file sent',
        );
      }
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC send_file attempt blocked',
      );
    }
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Clean up stale .processing files from previous crashes.
  // These represent IPC that may or may not have been executed,
  // so we move them to errors/ for manual inspection rather than replaying.
  cleanupStaleProcessing(ipcBaseDir);

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            // Claim the file by renaming to .processing before executing
            // side effects. If we crash after send but before cleanup,
            // the .processing file won't be re-read on next poll.
            const processingPath = `${filePath}.processing`;
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              continue; // another poll cycle already claimed it
            }
            try {
              const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
              await processIpcMessage(data, sourceGroup, isMain, deps);
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                // processingPath may already be gone
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            const processingPath = `${filePath}.processing`;
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              continue;
            }
            try {
              const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                // processingPath may already be gone
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          agent_name: (data as any).agent_name || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          // Recompute next_run when resuming
          const updates: Parameters<typeof updateTask>[1] = {
            status: 'active',
          };
          if (task.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(task.schedule_value, {
                tz: TIMEZONE,
              });
              updates.next_run = interval.next().toISOString();
            } catch {
              // Keep existing next_run if cron is invalid
            }
          } else if (task.schedule_type === 'interval') {
            const ms = parseInt(task.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          } else if (task.schedule_type === 'once' && task.next_run) {
            // For 'once' tasks, if next_run is in the past, set to now + 1 min
            if (new Date(task.next_run).getTime() < Date.now()) {
              updates.next_run = new Date(Date.now() + 60000).toISOString();
            }
          }
          updateTask(data.taskId, updates);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Validate new schedule if provided
        if (data.schedule_type || data.schedule_value) {
          const newType = (data.schedule_type || task.schedule_type) as string;
          const newValue = (data.schedule_value ||
            task.schedule_value) as string;
          try {
            validateTaskSchedule(newType, newValue);
          } catch (err) {
            logger.warn(
              { taskId: data.taskId, err },
              'Task update rejected: invalid schedule',
            );
            break;
          }
        }

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'publish_to_bus': {
      const d = data as Record<string, unknown>;
      const toAgent = d.to_agent as string;
      const toGroup = (d.to_group as string) || '';
      const topic = d.topic as string;

      if (!toAgent || !topic) break;
      if (toAgent.includes('..') || toAgent.includes('/')) break;
      if (toGroup.includes('..') || toGroup.includes('/')) break;

      const { agent: sourceAgent, group: pubBaseGroup } = parseCompoundKey(
        fsPathToCompoundKey(sourceGroup),
      );

      // Authorization: non-main senders can only publish to their own base
      // group. Otherwise a specialist could inject a prompt into any other
      // group's lead agent via the bus-watcher dispatch (see index.ts
      // bus dispatch path, which renders m.summary directly into the
      // runAgent prompt).
      const targetGroup = toGroup || pubBaseGroup;
      if (!isMain && targetGroup !== pubBaseGroup) {
        logger.warn(
          { sourceGroup, targetGroup, sourceAgent },
          'Unauthorized publish_to_bus attempt blocked (cross-group)',
        );
        break;
      }

      if (deps.messageBus) {
        const targetFsKey = `${targetGroup}--${toAgent}`;
        deps.messageBus.writeAgentMessage(targetFsKey, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          from: sourceAgent || sourceGroup,
          topic,
          priority: d.priority as 'low' | 'medium' | 'high' | undefined,
          summary: d.summary as string,
          to_agent: toAgent,
          to_group: targetGroup,
          payload: d.payload,
          timestamp: new Date().toISOString(),
        });
        logger.info(
          { from: sourceAgent, to: toAgent, topic },
          'Bus message published via IPC',
        );
      }
      break;
    }

    case 'knowledge_publish': {
      const { publishKnowledge } = await import('./knowledge.js');
      const knowledgeDir = path.join(DATA_DIR, 'agent-knowledge');
      const entry = {
        topic: (data as any).topic || 'unknown',
        finding: (data as any).finding || '',
        evidence: (data as any).evidence || '',
        tags: (data as any).tags || [],
      };
      const filePath = publishKnowledge(entry, sourceGroup, knowledgeDir);
      logger.info(
        { sourceGroup, topic: entry.topic, filePath },
        'Knowledge entry published',
      );

      // Publish notification to message bus if available
      if (deps.messageBus) {
        deps.messageBus.publish({
          from: sourceGroup,
          topic: `knowledge:${entry.topic}`,
          summary: entry.finding.slice(0, 200),
          action_needed: '',
          priority: 'low',
        });
      }
      break;
    }

    case 'write_agent_memory': {
      const d = data as Record<string, unknown>;
      const content = d.content as string;
      if (!content) break;

      // Authorization: agent name must come from the authenticated compound
      // directory (telegram_foo--einstein → einstein). Main group may
      // additionally target a named agent via payload agent_name; non-main
      // non-compound groups must not — otherwise any group could overwrite
      // any agent's memory with arbitrary content (a prompt-injection primitive
      // since memory.md is read back into future context packets).
      const { agent: compoundAgent } = parseCompoundKey(
        fsPathToCompoundKey(sourceGroup),
      );
      const payloadAgent = d.agent_name as string | undefined;
      const agentName = compoundAgent || (isMain ? payloadAgent : undefined);
      if (!agentName) {
        logger.warn(
          { sourceGroup, payloadAgentProvided: Boolean(payloadAgent) },
          'write_agent_memory: cannot determine agent name (must be sent from a compound-key directory, or from main with agent_name)',
        );
        break;
      }

      // Validate agent directory exists (prevents path traversal)
      const agentDir = path.join(AGENTS_DIR, agentName);
      if (
        !fs.existsSync(agentDir) ||
        agentName.includes('..') ||
        agentName.includes('/')
      ) {
        logger.warn(
          { agentName, sourceGroup },
          'write_agent_memory: invalid agent name',
        );
        break;
      }

      const memoryPath = path.join(agentDir, 'memory.md');
      const tmpPath = `${memoryPath}.tmp`;
      const section = d.section as string | undefined;

      if (section) {
        // Section upsert: read existing, replace/append section
        const existing = fs.existsSync(memoryPath)
          ? fs.readFileSync(memoryPath, 'utf-8')
          : `# ${agentName} — Memory\n`;
        const sectionHeader = `## ${section}`;
        const escapedHeader = sectionHeader.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );
        const sectionRegex = new RegExp(
          `${escapedHeader}\\n[\\s\\S]*?(?=\\n## |$)`,
        );
        const newSection = `${sectionHeader}\n${content}`;
        const updated = sectionRegex.test(existing)
          ? existing.replace(sectionRegex, newSection)
          : `${existing.trimEnd()}\n\n${newSection}\n`;
        fs.writeFileSync(tmpPath, updated);
      } else {
        // Full-file replacement (backwards compat)
        fs.writeFileSync(tmpPath, content);
      }
      fs.renameSync(tmpPath, memoryPath);
      logger.info(
        { agent: agentName, section: section || '(full)' },
        'Agent memory updated via IPC',
      );
      break;
    }

    case 'write_agent_state': {
      const d = data as Record<string, unknown>;
      const content = d.content as string;
      if (!content) break;

      const { agent } = parseCompoundKey(fsPathToCompoundKey(sourceGroup));
      if (!agent) {
        logger.warn(
          { sourceGroup },
          'write_agent_state from non-compound group',
        );
        break;
      }

      // Mirror the guard already present in write_agent_memory. The agent
      // name should already be traversal-clean (it comes from a directory
      // that was created by the host), but this is the defense-in-depth
      // version of the check — cheap.
      if (agent.includes('..') || agent.includes('/')) {
        logger.warn(
          { agent, sourceGroup },
          'write_agent_state: invalid agent name',
        );
        break;
      }

      const agentDir = path.join(AGENTS_DIR, agent);
      if (!fs.existsSync(agentDir)) {
        logger.warn(
          { agent, sourceGroup },
          'write_agent_state: agent directory does not exist',
        );
        break;
      }

      const statePath = path.join(AGENTS_DIR, agent, 'state.md');
      const tmpPath = `${statePath}.tmp`;
      const finalContent = d.append
        ? (fs.existsSync(statePath)
            ? fs.readFileSync(statePath, 'utf-8')
            : '') +
          '\n' +
          content
        : content;
      fs.writeFileSync(tmpPath, finalContent);
      fs.renameSync(tmpPath, statePath);
      logger.info({ agent }, 'Agent state updated via IPC');
      break;
    }

    default: {
      let handled = false;
      if (typeof data.type === 'string' && data.type === 'deploy_mini_app') {
        handled = await handleDeployMiniApp(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
          DATA_DIR,
        );
      }
      if (typeof data.type === 'string' && data.type === 'dashboard_query') {
        handled = await handleDashboardIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
          DATA_DIR,
        );
      }
      if (typeof data.type === 'string' && data.type.startsWith('pageindex_')) {
        // Build mount mappings from registered group config
        const groupEntry = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const mounts: Array<{
          hostPath: string;
          containerPath: string;
          readonly: boolean;
        }> = [];
        if (groupEntry?.containerConfig?.additionalMounts) {
          const validated = validateAdditionalMounts(
            groupEntry.containerConfig.additionalMounts,
            groupEntry.name || sourceGroup,
            isMain,
          );
          mounts.push(...validated);
        }
        // Add group folder mount
        mounts.push({
          hostPath: resolveGroupFolderPath(sourceGroup),
          containerPath: '/workspace/group',
          readonly: false,
        });
        handled = await handlePageindexIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
          DATA_DIR,
          mounts,
        );
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type.startsWith('imessage_')
      ) {
        handled = await handleImessageIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
        );
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'slack_dm'
      ) {
        handled = await handleSlackDmIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
        );
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'slack_dm_read'
      ) {
        handled = await handleSlackDmReadIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
        );
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type.startsWith('x_')
      ) {
        try {
          const modPath = [
            '..',
            '.claude',
            'skills',
            'x-integration',
            'host.js',
          ].join('/');
          const mod = await import(modPath);
          handled = await mod.handleXIpc(
            data as Record<string, unknown>,
            sourceGroup,
            isMain,
            DATA_DIR,
          );
        } catch (err) {
          logger.warn({ err }, 'X integration handler not available');
        }
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type.startsWith('browser_')
      ) {
        try {
          const modPath = [
            '..',
            '.claude',
            'skills',
            'browser-automation',
            'host.js',
          ].join('/');
          const mod = await import(modPath);
          handled = await mod.handleBrowserIpc(
            data as Record<string, unknown>,
            sourceGroup,
            isMain,
            DATA_DIR,
          );
        } catch (err) {
          logger.warn({ err }, 'Browser automation handler not available');
        }
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'save_skill'
      ) {
        if (!isMain) {
          logger.warn(
            { sourceGroup },
            'Non-main save_skill IPC attempt blocked',
          );
          handled = true;
        } else {
          handled = handleSaveSkillIpc(data, sourceGroup);
        }
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type === 'skill_search'
      ) {
        handled = await handleSkillSearchIpc(data, sourceGroup);
      }
      if (!handled) {
        logger.warn({ type: data.type }, 'Unknown IPC task type');
      }
    }
  }
}

async function handleImessageIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
): Promise<boolean> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Non-main iMessage IPC attempt blocked');
    return true; // handled (rejected)
  }

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn({ data }, 'iMessage IPC invalid requestId');
    return true;
  }

  const resultsDir = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    'imessage_results',
  );
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: {
    success: boolean;
    message: string;
    data?: unknown;
  }) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    const { imessageSearch, imessageRead, imessageSend, imessageListContacts } =
      await import('./imessage-host.js');

    switch (data.type) {
      case 'imessage_search': {
        const results = imessageSearch({
          query: data.query as string | undefined,
          contact: data.contact as string | undefined,
          since_days: data.since_days as number | undefined,
          limit: data.limit as number | undefined,
        });
        writeResult({
          success: true,
          message: `Found ${results.length} messages`,
          data: results,
        });
        break;
      }
      case 'imessage_read': {
        const contact = data.contact as string;
        if (!contact) {
          writeResult({ success: false, message: 'Missing contact parameter' });
          break;
        }
        const conversation = imessageRead({
          contact,
          limit: data.limit as number | undefined,
          since_days: data.since_days as number | undefined,
        });
        writeResult({
          success: true,
          message: `${conversation.messages.length} messages with ${contact}`,
          data: conversation,
        });
        break;
      }
      case 'imessage_send': {
        const to = data.to as string;
        const text = data.text as string;
        if (!to || !text) {
          writeResult({
            success: false,
            message: 'Missing to or text parameter',
          });
          break;
        }
        const sendResult = await imessageSend({ to, text });
        writeResult(sendResult);
        break;
      }
      case 'imessage_list_contacts': {
        const contacts = imessageListContacts({
          since_days: data.since_days as number | undefined,
          limit: data.limit as number | undefined,
        });
        writeResult({
          success: true,
          message: `${contacts.length} contacts`,
          data: contacts,
        });
        break;
      }
      default:
        return false; // not handled
    }

    logger.info(
      { type: data.type, requestId, sourceGroup },
      'iMessage IPC handled',
    );
    return true;
  } catch (err) {
    logger.error({ err, type: data.type, requestId }, 'iMessage IPC error');
    writeResult({
      success: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}

async function handleSlackDmIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
): Promise<boolean> {
  // Trust enforcement: extract agent name from compound key
  const baseKey = fsPathToCompoundKey(sourceGroup);
  const { group: baseGroupFolder, agent: agentName } =
    parseCompoundKey(baseKey);
  if (agentName) {
    const trust = loadAgentTrust(path.join(AGENTS_DIR, agentName));
    const decision = checkTrust(
      agentName,
      baseGroupFolder,
      'send_slack_dm',
      trust,
    );
    insertAgentAction({
      agent_name: agentName,
      group_folder: baseGroupFolder,
      action_type: 'send_slack_dm',
      trust_level: decision.level,
      summary: (data.text as string)?.slice(0, 200) || '',
      target: (data.user_email as string) || (data.user_id as string) || '',
      outcome: decision.allowed ? 'allowed' : 'blocked',
    });
    if (!decision.allowed) {
      logger.info(
        { agentName, sourceGroup, level: decision.level },
        'Trust: send_slack_dm blocked for agent',
      );
      return true;
    }
  }

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn({ data }, 'slack_dm IPC invalid requestId');
    return true;
  }

  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'slack_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: {
    success: boolean;
    message: string;
    data?: unknown;
  }) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    const userId = data.user_id as string | undefined;
    const userEmail = data.user_email as string | undefined;
    const text = data.text as string | undefined;

    if (!text || (!userId && !userEmail)) {
      writeResult({
        success: false,
        message:
          'Missing required parameters: text and either user_id or user_email',
      });
      return true;
    }

    const body: Record<string, string> = { text };
    if (userId) body.user_id = userId;
    if (userEmail) body.user_email = userEmail;

    const response = await fetch('http://127.0.0.1:19876/slack/dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as Record<string, unknown>;

    if (response.ok) {
      writeResult({
        success: true,
        message: (result.message as string) || 'Slack DM sent',
        data: result,
      });
    } else {
      writeResult({
        success: false,
        message:
          (result.error as string) || `Bridge returned ${response.status}`,
      });
    }

    logger.info(
      { requestId, sourceGroup, userId, userEmail },
      'slack_dm IPC handled',
    );
    return true;
  } catch (err) {
    logger.error({ err, requestId }, 'slack_dm IPC error');
    writeResult({
      success: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}

async function handleSlackDmReadIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
): Promise<boolean> {
  // Trust enforcement: extract agent name from compound key
  const baseKey = fsPathToCompoundKey(sourceGroup);
  const { group: baseGroupFolder, agent: agentName } =
    parseCompoundKey(baseKey);
  if (agentName) {
    const trust = loadAgentTrust(path.join(AGENTS_DIR, agentName));
    const decision = checkTrust(
      agentName,
      baseGroupFolder,
      'read_slack_dm',
      trust,
    );
    insertAgentAction({
      agent_name: agentName,
      group_folder: baseGroupFolder,
      action_type: 'read_slack_dm',
      trust_level: decision.level,
      summary: `Read DM channel: ${(data.channel as string) || 'unknown'}`,
      target: (data.channel as string) || '',
      outcome: decision.allowed ? 'allowed' : 'blocked',
    });
    if (!decision.allowed) {
      logger.info(
        { agentName, sourceGroup, level: decision.level },
        'Trust: read_slack_dm blocked for agent',
      );
      return true;
    }
  }

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn({ data }, 'slack_dm_read IPC invalid requestId');
    return true;
  }

  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'slack_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: {
    success: boolean;
    message: string;
    data?: unknown;
  }) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    const channel = data.channel as string | undefined;
    const limit = data.limit as number | undefined;

    if (!channel) {
      writeResult({
        success: false,
        message: 'Missing required parameter: channel',
      });
      return true;
    }

    const body: Record<string, unknown> = { channel };
    if (limit) body.limit = limit;

    const response = await fetch('http://127.0.0.1:19876/slack/dm/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as Record<string, unknown>;

    if (response.ok) {
      const messages = result.messages as unknown[];
      writeResult({
        success: true,
        message: JSON.stringify(messages || [], null, 2),
        data: result,
      });
    } else {
      writeResult({
        success: false,
        message:
          (result.error as string) || `Bridge returned ${response.status}`,
      });
    }

    logger.info(
      { requestId, sourceGroup, channel },
      'slack_dm_read IPC handled',
    );
    return true;
  } catch (err) {
    logger.error({ err, requestId }, 'slack_dm_read IPC error');
    writeResult({
      success: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}

/**
 * Handle save_skill IPC: persist a container-created skill to host's
 * container/skills/ so it survives session resets and is available to all groups.
 */
function handleSaveSkillIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
): boolean {
  const skillName = data.skillName as string | undefined;
  const skillContent = data.skillContent as string | undefined;
  const requestId = data.requestId as string | undefined;

  if (!skillName || !skillContent) {
    logger.warn({ data }, 'save_skill IPC missing skillName or skillContent');
    return true;
  }

  // Sanitize skill name: only allow lowercase alphanumeric and hyphens
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(skillName)) {
    logger.warn(
      { skillName, sourceGroup },
      'save_skill IPC rejected: invalid skill name',
    );
    writeSkillResult(sourceGroup, requestId, {
      success: false,
      message:
        'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).',
    });
    return true;
  }

  // Prevent overwriting built-in skills
  const builtinSkills = [
    'agent-browser',
    'capabilities',
    'slack-formatting',
    'status',
    'skill-creator',
  ];
  if (builtinSkills.includes(skillName)) {
    logger.warn(
      { skillName, sourceGroup },
      'save_skill IPC rejected: cannot overwrite built-in skill',
    );
    writeSkillResult(sourceGroup, requestId, {
      success: false,
      message: `Cannot overwrite built-in skill "${skillName}".`,
    });
    return true;
  }

  try {
    const skillDir = path.join(process.cwd(), 'container', 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

    logger.info(
      { skillName, sourceGroup },
      'Container skill saved permanently via IPC',
    );
    writeSkillResult(sourceGroup, requestId, {
      success: true,
      message: `Skill "${skillName}" saved permanently.`,
    });
  } catch (err) {
    logger.error({ err, skillName, sourceGroup }, 'save_skill IPC error');
    writeSkillResult(sourceGroup, requestId, {
      success: false,
      message: `Error saving skill: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return true;
}

function writeSkillResult(
  sourceGroup: string,
  requestId: string | undefined,
  result: { success: boolean; message: string },
): void {
  if (!requestId) return;
  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'skill_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const tmpFile = `${resultFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(result));
  fs.renameSync(tmpFile, resultFile);
}

async function handleSkillSearchIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
): Promise<boolean> {
  const query = data.query as string | undefined;
  const requestId = data.requestId as string | undefined;

  if (!query || !requestId) {
    logger.warn({ data }, 'skill_search IPC missing query or requestId');
    return true;
  }

  try {
    const response = await fetch('http://localhost:8181/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            searches: [{ type: 'lex', query }],
            collections: ['skill-catalog'],
            intent: query,
            limit: 5,
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    const json = (await response.json()) as {
      result?: {
        content?: Array<{ text?: string }>;
      };
    };

    const rawText = json.result?.content?.[0]?.text;
    if (!rawText) {
      writeSkillResult(sourceGroup, requestId, {
        success: false,
        message: 'QMD returned empty response',
      });
      return true;
    }

    const parsed = JSON.parse(rawText) as {
      results: Array<{
        file: string;
        title: string;
        score: number;
        snippet: string;
      }>;
    };

    if (!parsed.results || parsed.results.length === 0) {
      writeSkillResult(sourceGroup, requestId, {
        success: true,
        message: 'No matching skills found.',
      });
      return true;
    }

    const formatted = parsed.results
      .map((r) => `\u2022 *${r.title}* (score: ${r.score})\n  ${r.snippet}`)
      .join('\n');

    writeSkillResult(sourceGroup, requestId, {
      success: true,
      message: formatted,
    });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    writeSkillResult(sourceGroup, requestId, {
      success: false,
      message: isTimeout
        ? 'Skill search timed out'
        : 'QMD unavailable: ' +
          (err instanceof Error ? err.message : String(err)),
    });
    logger.warn({ err, sourceGroup }, 'skill_search IPC error');
  }

  return true;
}
