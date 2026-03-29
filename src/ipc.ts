import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
  validateTaskSchedule,
} from './db.js';
import { resolveGroupFolderPath, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { handleDashboardIpc } from './dashboard-ipc.js';
import { handleDeployMiniApp } from './vercel-deployer.js';
import { handlePageindexIpc } from './pageindex-ipc.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
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
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    data.webAppUrl &&
                    typeof data.webAppUrl === 'string' &&
                    deps.sendWebAppButton
                  ) {
                    // Telegram Mini App button — delegate to channel
                    await deps.sendWebAppButton(
                      data.chatJid,
                      data.text,
                      data.webAppUrl,
                    );
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC WebApp button sent',
                    );
                  } else if (
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
                      // Pool bot can't reach this chat (e.g. DM) — fall back
                      // to main bot with sender name prefixed
                      const prefixed = `*${data.sender}:*\n${data.text}`;
                      await deps.sendMessage(data.chatJid, prefixed);
                    }
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
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

    case 'bus_publish': {
      if (deps.messageBus) {
        const d = data as Record<string, unknown>;
        deps.messageBus.publish({
          from: (d.from as string) || sourceGroup,
          topic: d.topic as string,
          finding: d.finding as string,
          action_needed: d.action_needed as string | undefined,
          priority: d.priority as 'low' | 'medium' | 'high' | undefined,
        });
        logger.info(
          { from: d.from, topic: d.topic },
          'Bus message published via IPC',
        );
      }
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
