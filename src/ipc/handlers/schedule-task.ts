import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { createTask } from '../../db.js';
import { isValidAgentName } from '../../ipc.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  taskId: string;
  prompt: string;
  // The original switch cast schedule_type without runtime validation, leaving
  // unknown values as a literal string with a null next_run. Parity preserved
  // here: the handler accepts any non-empty string and the next-run computer
  // returns null for unrecognized types instead of rejecting.
  scheduleType: string;
  scheduleValue: string;
  targetJid: string;
  contextMode: 'group' | 'isolated';
  agentName: string | null;
  script: string | null;
}

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type ComputeResult =
  | { nextRun: string | null; ok: true }
  | { reason: string; ok: false };

function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
): ComputeResult {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      return { nextRun: interval.next().toISOString(), ok: true };
    } catch {
      return { reason: 'Invalid cron expression', ok: false };
    }
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      return { reason: 'Invalid interval', ok: false };
    }
    return { nextRun: new Date(Date.now() + ms).toISOString(), ok: true };
  }
  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      return { reason: 'Invalid timestamp', ok: false };
    }
    return { nextRun: date.toISOString(), ok: true };
  }
  // Unknown schedule type — original behavior was to leave next_run null and
  // still createTask. The if/else cascade fell through silently.
  return { nextRun: null, ok: true };
}

export const scheduleTaskHandler: IpcHandler<Input> = {
  type: 'schedule_task',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    if (typeof r.prompt !== 'string' || r.prompt.length === 0) return null;
    if (typeof r.schedule_type !== 'string' || r.schedule_type.length === 0) {
      return null;
    }
    if (typeof r.schedule_value !== 'string' || r.schedule_value.length === 0) {
      return null;
    }
    if (typeof r.targetJid !== 'string' || r.targetJid.length === 0) {
      return null;
    }

    const taskId =
      typeof r.taskId === 'string' && r.taskId.length > 0
        ? r.taskId
        : generateTaskId();

    const contextMode =
      r.context_mode === 'group' || r.context_mode === 'isolated'
        ? r.context_mode
        : 'isolated';

    let agentName: string | null = null;
    if (r.agent_name !== undefined && r.agent_name !== null) {
      if (
        typeof r.agent_name !== 'string' ||
        !isValidAgentName(r.agent_name)
      ) {
        return null;
      }
      agentName = r.agent_name;
    }

    const script =
      typeof r.script === 'string' && r.script.length > 0 ? r.script : null;

    return {
      taskId,
      prompt: r.prompt,
      scheduleType: r.schedule_type,
      scheduleValue: r.schedule_value,
      targetJid: r.targetJid,
      contextMode,
      agentName,
      script,
    };
  },

  authorize(input, ctx) {
    const targetGroupEntry = ctx.registeredGroups[input.targetJid];
    if (!targetGroupEntry) {
      logger.warn(
        { targetJid: input.targetJid },
        'Cannot schedule task: target group not registered',
      );
      return null;
    }
    const targetFolder = targetGroupEntry.folder;

    // Non-main groups can only schedule tasks for themselves.
    if (!ctx.isMain && targetFolder !== ctx.baseGroup) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup, targetFolder },
        'Unauthorized schedule_task attempt blocked',
      );
      return null;
    }

    // A1: Block script-bearing tasks from non-main groups. task.script is
    // executed by runGuardScript as /bin/bash -c on the host, so accepting
    // it from non-main would be a direct container escape.
    if (input.script !== null && !ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup, targetFolder },
        'schedule_task rejected: script field is main-only',
      );
      return null;
    }

    // Validate the schedule before trust enforcement so an invalid schedule
    // doesn't write an "allowed" row to agent_actions that we then silently
    // drop. Matches the original switch-case ordering.
    const scheduleCheck = computeNextRun(input.scheduleType, input.scheduleValue);
    if (!scheduleCheck.ok) {
      logger.warn(
        { scheduleValue: input.scheduleValue },
        scheduleCheck.reason,
      );
      return null;
    }

    return {
      // notify (and post-hoc display) references the new taskId; audit row
      // references the target group folder per the original switch-case.
      target: input.taskId,
      auditTarget: targetFolder,
      auditSummary: input.prompt.slice(0, 500),
      notifySummary: `added task '${input.prompt.slice(0, 80)}' (${input.scheduleType})`,
      payloadForStaging: {
        type: 'schedule_task',
        prompt: input.prompt,
        schedule_type: input.scheduleType,
        schedule_value: input.scheduleValue,
        targetJid: input.targetJid,
        context_mode: input.contextMode,
        agent_name: input.agentName,
        // script intentionally omitted — main-only per A1
      },
    };
  },

  execute(input, ctx) {
    const targetGroupEntry = ctx.registeredGroups[input.targetJid];
    if (!targetGroupEntry) {
      logger.warn(
        { targetJid: input.targetJid },
        'schedule_task: target group disappeared between authorize and execute',
      );
      return;
    }
    const targetFolder = targetGroupEntry.folder;

    const scheduleCheck = computeNextRun(input.scheduleType, input.scheduleValue);
    if (!scheduleCheck.ok) {
      // Already validated in authorize; re-checking here only because the
      // computeNextRun call recomputes the next-run timestamp. If the
      // re-check fails it's a race or clock issue — log and drop.
      logger.warn(
        { scheduleValue: input.scheduleValue },
        `schedule_task: ${scheduleCheck.reason} (recheck)`,
      );
      return;
    }

    createTask({
      id: input.taskId,
      group_folder: targetFolder,
      chat_jid: input.targetJid,
      prompt: input.prompt,
      script: input.script,
      agent_name: input.agentName,
      schedule_type: input.scheduleType,
      schedule_value: input.scheduleValue,
      context_mode: input.contextMode,
      next_run: scheduleCheck.nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info(
      {
        taskId: input.taskId,
        sourceGroup: ctx.sourceGroup,
        targetFolder,
        contextMode: input.contextMode,
      },
      'Task created via IPC',
    );
    ctx.deps.onTasksChanged();
  },
};
