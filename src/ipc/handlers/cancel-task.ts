import { deleteTask, getTaskById } from '../../db.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  taskId: string;
}

export const cancelTaskHandler: IpcHandler<Input> = {
  type: 'cancel_task',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { taskId } = raw as { taskId?: unknown };
    return typeof taskId === 'string' && taskId.length > 0 ? { taskId } : null;
  },

  authorize({ taskId }, ctx) {
    const task = getTaskById(taskId);
    if (!task) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'cancel_task: task not found',
      );
      return null;
    }
    if (!ctx.isMain && task.group_folder !== ctx.baseGroup) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'Unauthorized task cancel attempt',
      );
      return null;
    }
    return {
      target: taskId,
      notifySummary: `cancelled task ${taskId}`,
      payloadForStaging: { type: 'cancel_task', taskId },
    };
  },

  execute({ taskId }, ctx) {
    deleteTask(taskId);
    logger.info(
      { taskId, sourceGroup: ctx.sourceGroup },
      'Task cancelled via IPC',
    );
    ctx.deps.onTasksChanged();
  },
};
