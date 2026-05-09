import { registerIpcHandler } from '../handler.js';
import { cancelTaskHandler } from './cancel-task.js';
import { knowledgePublishHandler } from './knowledge-publish.js';
import { pauseTaskHandler } from './pause-task.js';
import { publishToBusHandler } from './publish-to-bus.js';
import { refreshGroupsHandler } from './refresh-groups.js';
import { registerGroupHandler } from './register-group.js';
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
  registerIpcHandler(refreshGroupsHandler);
  registerIpcHandler(registerGroupHandler);
  registerIpcHandler(publishToBusHandler);
  registerIpcHandler(knowledgePublishHandler);
  registered = true;
}

export function _resetBuiltinHandlersForTests(): void {
  registered = false;
}
