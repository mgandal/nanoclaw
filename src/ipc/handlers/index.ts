import { registerIpcHandler } from '../handler.js';
import { cancelTaskHandler } from './cancel-task.js';
import { pauseTaskHandler } from './pause-task.js';
import { resumeTaskHandler } from './resume-task.js';
import { scheduleTaskHandler } from './schedule-task.js';
import { updateTaskHandler } from './update-task.js';

let registered = false;

export function registerBuiltinHandlers(): void {
  if (registered) return;
  registerIpcHandler(scheduleTaskHandler);
  registerIpcHandler(pauseTaskHandler);
  registerIpcHandler(resumeTaskHandler);
  registerIpcHandler(cancelTaskHandler);
  registerIpcHandler(updateTaskHandler);
  registered = true;
}

export function _resetBuiltinHandlersForTests(): void {
  registered = false;
}
