import { getTaskById, updateTask } from '../../db.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';
import { WIRE_SCHEMAS, wireParse } from '../wire-schemas.js';

interface Input {
  taskId: string;
}

export const pauseTaskHandler: IpcHandler<Input> = {
  type: 'pause_task',

  parse: wireParse(WIRE_SCHEMAS.pause_task),

  authorize({ taskId }, ctx) {
    const task = getTaskById(taskId);
    if (!task) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'pause_task: task not found',
      );
      return null;
    }
    if (!ctx.isMain && task.group_folder !== ctx.baseGroup) {
      logger.warn(
        { taskId, sourceGroup: ctx.sourceGroup },
        'Unauthorized task pause attempt',
      );
      return null;
    }
    return {
      target: taskId,
      notifySummary: `paused task ${taskId}`,
      payloadForStaging: { type: 'pause_task', taskId },
    };
  },

  execute({ taskId }, ctx) {
    updateTask(taskId, { status: 'paused' });
    logger.info(
      { taskId, sourceGroup: ctx.sourceGroup },
      'Task paused via IPC',
    );
    ctx.deps.onTasksChanged();
  },
};
