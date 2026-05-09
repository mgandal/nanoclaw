import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { getTaskById, updateTask, validateTaskSchedule } from '../../db.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

interface Input {
  taskId: string;
  prompt?: string;
  script?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;
}

const VALID_SCHEDULE_TYPES = new Set(['cron', 'interval', 'once']);

export const updateTaskHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'update_task',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.taskId !== 'string' || r.taskId.length === 0) return null;

    const out: Input = { taskId: r.taskId };
    if (r.prompt !== undefined) {
      if (typeof r.prompt !== 'string') return null;
      out.prompt = r.prompt;
    }
    if (r.script !== undefined) {
      if (typeof r.script !== 'string') return null;
      out.script = r.script;
    }
    if (r.schedule_type !== undefined) {
      if (
        typeof r.schedule_type !== 'string' ||
        !VALID_SCHEDULE_TYPES.has(r.schedule_type)
      ) {
        return null;
      }
      out.schedule_type = r.schedule_type as Input['schedule_type'];
    }
    if (r.schedule_value !== undefined) {
      if (typeof r.schedule_value !== 'string') return null;
      out.schedule_value = r.schedule_value;
    }
    return out;
  },

  authorize(input, ctx) {
    const task = getTaskById(input.taskId);
    if (!task) {
      logger.warn(
        { taskId: input.taskId, sourceGroup: ctx.sourceGroup },
        'Task not found for update',
      );
      return null;
    }
    if (!ctx.isMain && task.group_folder !== ctx.baseGroup) {
      logger.warn(
        { taskId: input.taskId, sourceGroup: ctx.sourceGroup },
        'Unauthorized task update attempt',
      );
      return null;
    }

    // A1: non-main groups cannot add/modify the script field via update_task.
    // The original case rejects this BEFORE trust enforcement (script
    // injection is always blocked, regardless of trust level), so we reject
    // here in authorize() rather than in execute().
    if (input.script !== undefined && !ctx.isMain) {
      logger.warn(
        { taskId: input.taskId, sourceGroup: ctx.sourceGroup },
        'update_task rejected: script field is main-only',
      );
      return null;
    }

    return {
      target: input.taskId,
      notifySummary: `updated task ${input.taskId}`,
      payloadForStaging: {
        type: 'update_task',
        taskId: input.taskId,
        prompt: input.prompt,
        schedule_type: input.schedule_type,
        schedule_value: input.schedule_value,
        // script intentionally omitted — main-only per A1
      },
    };
  },

  execute(input, ctx) {
    const task = getTaskById(input.taskId);
    if (!task) {
      logger.warn(
        { taskId: input.taskId, sourceGroup: ctx.sourceGroup },
        'update_task: task disappeared between authorize and execute',
      );
      return { executed: false };
    }

    const updates: Parameters<typeof updateTask>[1] = {};
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    if (input.script !== undefined) updates.script = input.script || null;
    if (input.schedule_type !== undefined) {
      updates.schedule_type = input.schedule_type;
    }
    if (input.schedule_value !== undefined) {
      updates.schedule_value = input.schedule_value;
    }

    if (input.schedule_type || input.schedule_value) {
      const newType = (input.schedule_type || task.schedule_type) as string;
      const newValue = (input.schedule_value || task.schedule_value) as string;
      try {
        validateTaskSchedule(newType, newValue);
      } catch (err) {
        logger.warn(
          { taskId: input.taskId, err },
          'Task update rejected: invalid schedule',
        );
        return { executed: false };
      }

      const updatedTask = { ...task, ...updates };
      if (updatedTask.schedule_type === 'cron') {
        try {
          const interval = CronExpressionParser.parse(
            updatedTask.schedule_value,
            { tz: TIMEZONE },
          );
          updates.next_run = interval.next().toISOString();
        } catch {
          logger.warn(
            { taskId: input.taskId, value: updatedTask.schedule_value },
            'Invalid cron in task update',
          );
          return { executed: false };
        }
      } else if (updatedTask.schedule_type === 'interval') {
        const ms = parseInt(updatedTask.schedule_value, 10);
        if (!isNaN(ms) && ms > 0) {
          updates.next_run = new Date(Date.now() + ms).toISOString();
        }
      }
    }

    updateTask(input.taskId, updates);
    logger.info(
      { taskId: input.taskId, sourceGroup: ctx.sourceGroup, updates },
      'Task updated via IPC',
    );
    ctx.deps.onTasksChanged();
  },
};
