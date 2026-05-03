import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  OPS_ALERT_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { parseCompoundKey } from './compound-key.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getConsecutiveFailures,
  getDueTasks,
  getLastSuccessTime,
  getTaskById,
  healOrphanedNextRun,
  logTaskRun,
  markTaskRunning,
  recoverRunningTasks,
  setSession,
  touchSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { appendAlert, getUnresolvedAlerts } from './system-alerts.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    const next = interval.next();
    const nextMs = next.getTime();

    // Safety net: never schedule sooner than 30 minutes from now.
    // Catches 6-field cron expressions that fire every few minutes.
    const MIN_GAP_MS = 30 * 60 * 1000;
    if (nextMs - now < MIN_GAP_MS) {
      const second = interval.next();
      if (second.getTime() - nextMs < MIN_GAP_MS) {
        logger.warn(
          {
            taskId: task.id,
            cron: task.schedule_value,
            gapMs: second.getTime() - nextMs,
          },
          'Cron fires too frequently (< 30min), throttling to next safe run',
        );
        // Skip ahead until we find a gap >= 30min from now
        let candidate = second;
        while (candidate.getTime() - now < MIN_GAP_MS) {
          candidate = interval.next();
        }
        return candidate.toISOString();
      }
    }

    return next.toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    // Guard against null next_run (corrupted DB row) to avoid near-infinite loop.
    const base = task.next_run ? new Date(task.next_run).getTime() : now;
    let next = base + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

const GUARD_TIMEOUT_MS = 15_000;
const GUARD_ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Return an unresolved guard alert for this task that was written within
 * the dedupe window. Used so that a failing guard doesn't spam an alert on
 * every cron tick — one is enough until someone resolves it or the cooldown
 * expires.
 */
function getUnresolvedGuardAlertFor(taskId: string) {
  const now = Date.now();
  return getUnresolvedAlerts().find(
    (a) =>
      a.service === `guard:${taskId}` &&
      now - new Date(a.timestamp).getTime() < GUARD_ALERT_DEDUPE_MS,
  );
}

export interface GuardResult {
  shouldRun: boolean;
  reason?: string;
  /**
   * Classification for alerting:
   *  - 'normal'   — guard returned exit 1 (legitimate skip, quiet)
   *  - 'abnormal' — exit 2+, ENOENT/EACCES, timeout, non-exit crash (alert)
   *  - 'ok'       — exit 0, agent should run
   */
  kind: 'normal' | 'abnormal' | 'ok';
}

/**
 * Run a guard script before spawning the agent container.
 * Exit 0 → run agent. Non-zero → skip agent. Errors/timeouts → run agent (fail-open).
 */
export function runGuardScript(
  script: string | null | undefined,
  timeoutMs: number = GUARD_TIMEOUT_MS,
): Promise<GuardResult> {
  if (!script) return Promise.resolve({ shouldRun: true, kind: 'ok' });

  // A1 audit trail: every guard-script execution is a host shell run. Log
  // the (truncated) script content so an operator can inspect post-hoc.
  logger.info(
    { scriptPreview: script.slice(0, 500), length: script.length },
    'Guard script executed',
  );

  return new Promise((resolve) => {
    // FD note: execFile inherits 3 parent pipes per spawn (stdin/stdout/stderr)
    // and ignores the `stdio` option — to release the unused stdin FD early
    // we close child.stdin explicitly below. (See 2026-04-30 ENFILE incident:
    // 12 fires in 8s during inbox-convert burst.)
    const child = execFile(
      '/bin/bash',
      ['-c', script],
      { timeout: timeoutMs, env: { ...process.env, PATH: process.env.PATH } },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            resolve({
              shouldRun: true,
              kind: 'abnormal',
              reason: `Guard timed out after ${timeoutMs}ms`,
            });
          } else if (
            (error as NodeJS.ErrnoException).code === 'ENOENT' ||
            (error as NodeJS.ErrnoException).code === 'EACCES' ||
            (error as any).code === 127
          ) {
            resolve({
              shouldRun: true,
              kind: 'abnormal',
              reason: `Guard script error: ${error.message}`,
            });
          } else {
            const code = (error as any).code ?? 'unknown';
            const output = (stdout || stderr || '').trim();
            // Exit 1 = legitimate "no work to do" per the guard contract.
            // Exit 2+ / non-numeric = guard itself is broken → alert.
            const kind = code === 1 ? 'normal' : 'abnormal';
            resolve({
              shouldRun: false,
              kind,
              reason: `Guard exit code ${code}: ${output}`,
            });
          }
        } else {
          resolve({ shouldRun: true, kind: 'ok' });
        }
      },
    );
    // Release the parent's stdin pipe FD immediately. The guard never reads
    // stdin; holding the pipe just consumes one FD per concurrent guard.
    child.stdin?.end();
  });
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  // Extract base group for compound keys (e.g., "telegram_lab-claw:einstein" → "telegram_lab-claw")
  const { group: baseGroupFolder } = parseCompoundKey(task.group_folder);
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(baseGroupFolder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find((g) => g.folder === baseGroupFolder);

  if (!group) {
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task — auto-paused to prevent retry storm',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found (auto-paused): ${task.group_folder}`,
    });
    return;
  }

  // --- Guard script pre-check ---
  if (task.script) {
    const guard = await runGuardScript(task.script);

    // Alert on abnormal guard behavior (crash, timeout, ENOENT, exit 2+).
    // Dedupe: check if an unresolved alert for this task already exists
    // within the last 6h to avoid spamming on every 30-min cron tick.
    if (guard.kind === 'abnormal') {
      try {
        const existing = getUnresolvedGuardAlertFor(task.id);
        if (!existing) {
          appendAlert({
            timestamp: new Date().toISOString(),
            service: `guard:${task.id}`,
            message: `Guard script failed for task ${task.id} (${task.group_folder}): ${guard.reason}`,
            fixInstructions:
              'Inspect the script column in scheduled_tasks and run it manually. ' +
              'Guard must return exit 0 (wake agent), exit 1 (skip), or be fixed.',
          });
        }
      } catch (err) {
        logger.warn({ err, taskId: task.id }, 'Failed to append guard alert');
      }
    }

    if (!guard.shouldRun) {
      logger.info(
        { taskId: task.id, reason: guard.reason, kind: guard.kind },
        'Task skipped by guard script',
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'skipped',
        result: guard.reason || 'Guard returned non-zero',
        error: null,
      });
      const nextRun = computeNextRun(task);
      updateTaskAfterRun(task.id, nextRun, `Skipped: ${guard.reason}`);
      return;
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // Pattern detection was removed — the __pattern_detection__ task type
  // generated noisy proposals ("Want me to schedule this?") with no value.
  // The scheduled task is disabled in the DB; skip if it somehow fires.
  if (task.prompt === '__pattern_detection__') {
    logger.info({ taskId: task.id }, 'Pattern detection disabled, skipping');
    updateTaskAfterRun(task.id, computeNextRun(task), 'Disabled');
    return;
  }

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  // For tasks flagged as proactive, inject a stable correlation ID so the
  // agent's `proactive: true` IPC sends all share it and the governor can
  // dedup across retries and runs. Uses local-tz YYYY-MM-DD for daily
  // uniqueness.
  const extraEnv: Record<string, string> | undefined =
    task.proactive === 1
      ? {
          PROACTIVE_CORRELATION_ID: `task:${task.id}:${new Intl.DateTimeFormat(
            'en-CA',
            { timeZone: TIMEZONE },
          ).format(new Date())}`,
        }
      : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        agentName: task.agent_name || undefined,
        script: task.script || undefined,
        extraEnv,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // Persist session updates for group-context tasks
        if (streamedOutput.newSessionId && task.context_mode === 'group') {
          sessions[task.group_folder] = streamedOutput.newSessionId;
          setSession(task.group_folder, streamedOutput.newSessionId);
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    // Update session after task completion (group-context tasks keep session alive)
    if (task.context_mode === 'group') {
      if (output.newSessionId) {
        sessions[task.group_folder] = output.newSessionId;
        setSession(task.group_folder, output.newSessionId);
      } else if (sessions[task.group_folder]) {
        touchSession(task.group_folder);
      }
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  checkAlerts(task, error, deps);

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  // Recover any task left in 'running' after a previous crash/restart —
  // nothing can actually be running in a freshly-booted process.
  const recovered = recoverRunningTasks();
  if (recovered > 0) {
    logger.info({ recovered }, 'Recovered orphaned running tasks to active');
  }

  // Heal active cron/interval tasks where next_run is NULL (would otherwise
  // be silently skipped by getDueTasks forever — a single corrupt write or
  // out-of-band INSERT puts a task in permanent limbo).
  const healed = healOrphanedNextRun();
  for (const row of healed) {
    logger.warn(
      {
        taskId: row.id,
        scheduleValue: row.schedule_value,
        nextRun: row.next_run,
      },
      'Healed orphaned task with NULL next_run',
    );
  }

  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Flip to 'running' before enqueue so long-running tasks cannot
        // reappear in getDueTasks on the next poll (H4). updateTaskAfterRun
        // flips 'running' back to 'active' (or 'completed' for once-tasks).
        markTaskRunning(currentTask.id);

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }

      // Check for stale tasks (next_run far in the past)
      const allTasks = getAllTasks();
      checkStaleTasks(allTasks, deps);
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

// --- Real-time failure alerts ---

const alertedTaskIds = new Set<string>();
let pendingAlerts: Array<{
  taskId: string;
  group: string;
  error: string;
  lastSuccess: string | null;
}> = [];
let alertFlushTimer: ReturnType<typeof setTimeout> | null = null;
const ALERT_BATCH_WINDOW_MS = 60000;

/**
 * Check for failure alerts after a task run completes.
 * Also checks for stale tasks (next_run far in the past).
 */
export function checkAlerts(
  task: ScheduledTask,
  error: string | null,
  deps: SchedulerDependencies,
): void {
  // Clear dedup on success
  if (!error) {
    alertedTaskIds.delete(task.id);
    return;
  }

  // Already alerted for this task
  if (alertedTaskIds.has(task.id)) return;

  const failures = getConsecutiveFailures(task.id);
  if (failures < 2) return;

  alertedTaskIds.add(task.id);

  const lastSuccess = getLastSuccessTime(task.id);

  pendingAlerts.push({
    taskId: task.id,
    group: task.group_folder,
    error: error.slice(0, 200),
    lastSuccess,
  });

  // Batch alerts within a window
  if (!alertFlushTimer) {
    alertFlushTimer = setTimeout(() => {
      flushAlerts(deps);
    }, ALERT_BATCH_WINDOW_MS);
  }
}

/**
 * Check for stale tasks — tasks whose next_run is far in the past.
 * Called from the scheduler loop, not after individual task runs.
 * - interval tasks: stale if next_run > 2x interval behind
 * - cron tasks: stale if next_run > 24h behind
 * - once tasks: excluded
 */
export function checkStaleTasks(
  tasks: ScheduledTask[],
  deps: SchedulerDependencies,
): void {
  const now = Date.now();
  for (const task of tasks) {
    if (task.status !== 'active' || !task.next_run) continue;
    if (task.schedule_type === 'once') continue;
    if (alertedTaskIds.has(`stale:${task.id}`)) continue;

    const nextRunMs = new Date(task.next_run).getTime();
    const lagMs = now - nextRunMs;
    if (lagMs <= 0) continue;

    let isStale = false;
    if (task.schedule_type === 'interval') {
      const intervalMs = parseInt(task.schedule_value, 10);
      isStale = intervalMs > 0 && lagMs > intervalMs * 2;
    } else if (task.schedule_type === 'cron') {
      isStale = lagMs > 24 * 3600000;
    }

    if (isStale) {
      alertedTaskIds.add(`stale:${task.id}`);
      pendingAlerts.push({
        taskId: task.id,
        group: task.group_folder,
        error: `Task is stale — next_run was ${task.next_run}, ${Math.round(lagMs / 3600000)}h ago`,
        lastSuccess: getLastSuccessTime(task.id),
      });

      if (!alertFlushTimer) {
        alertFlushTimer = setTimeout(() => {
          flushAlerts(deps);
        }, ALERT_BATCH_WINDOW_MS);
      }
    }
  }
}

function flushAlerts(deps: SchedulerDependencies): void {
  alertFlushTimer = null;
  if (pendingAlerts.length === 0) return;

  // Find alert destination: prefer OPS_ALERT_FOLDER, fall back to main group
  const groups = deps.registeredGroups();
  const opsEntry = Object.entries(groups).find(
    ([, g]) => g.folder === OPS_ALERT_FOLDER,
  );
  const mainEntry =
    opsEntry || Object.entries(groups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.warn('No main group found for alert delivery');
    pendingAlerts = [];
    return;
  }
  const mainJid = mainEntry[0];

  let text = '\u26a0 *Task Alert*\n';
  for (const alert of pendingAlerts) {
    const shortGroup = alert.group.replace('telegram_', '').toUpperCase();
    const failCount = getConsecutiveFailures(alert.taskId);
    const successLine = alert.lastSuccess
      ? `\nLast success: ${alert.lastSuccess}`
      : '';
    text += `\n*${alert.taskId}* (${shortGroup})${failCount > 0 ? ` failed ${failCount}x in a row` : ' is stale'}.\nLast error: ${alert.error}${successLine}\n`;
  }

  deps
    .sendMessage(mainJid, text)
    .catch((err) => logger.error({ err }, 'Failed to send task alert'));

  pendingAlerts = [];
}

/** @internal - for tests only. */
export function _resetAlertsForTests(): void {
  alertedTaskIds.clear();
  pendingAlerts = [];
  if (alertFlushTimer) {
    clearTimeout(alertFlushTimer);
    alertFlushTimer = null;
  }
}
