import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { getTaskById, updateTask } from '../../db.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';
import { WIRE_SCHEMAS, wireParse } from '../wire-schemas.js';

interface Input {
  taskId: string;
}

export const resumeTaskHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'resume_task',

  parse: wireParse(WIRE_SCHEMAS.resume_task),

  authorize({ taskId }, ctx) {
    const task = getTaskById(taskId);
    if (!task) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'resume_task: task not found',
      );
      return null;
    }
    if (!ctx.isMain && task.group_folder !== ctx.baseGroup) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'Unauthorized task resume attempt',
      );
      return null;
    }
    return {
      target: taskId,
      notifySummary: `resumed task ${taskId}`,
      payloadForStaging: { type: 'resume_task', taskId },
    };
  },

  execute({ taskId }, ctx) {
    const task = getTaskById(taskId);
    if (!task) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'resume_task: task disappeared between authorize and execute',
      );
      return { executed: false };
    }

    const updates: Parameters<typeof updateTask>[1] = { status: 'active' };
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
      if (new Date(task.next_run).getTime() < Date.now()) {
        updates.next_run = new Date(Date.now() + 60000).toISOString();
      }
    }

    updateTask(taskId, updates);
    logger.info(
      { taskId, sourceGroup: ctx.sourceGroup },
      'Task resumed via IPC',
    );
    ctx.deps.onTasksChanged();
  },
};
