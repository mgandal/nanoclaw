import { registerIpcHandler } from '../handler.js';
import { cancelTaskHandler } from './cancel-task.js';
import { dashboardQueryHandler } from './dashboard-query.js';
import { deployMiniAppHandler } from './deploy-mini-app.js';
import {
  imessageListContactsHandler,
  imessageReadHandler,
  imessageSearchHandler,
  imessageSendHandler,
} from './imessage.js';
import { kgQueryHandler } from './kg-query.js';
import { messageHandler } from './message.js';
import { sendFileHandler } from './send-file.js';
import { pageindexFetchHandler, pageindexIndexHandler } from './pageindex.js';
import { slackDmReadHandler, slackDmHandler } from './slack.js';
import { skillSearchHandler, saveSkillHandler } from './skills.js';
import {
  taskAddHandler,
  taskCloseHandler,
  taskListHandler,
  taskReopenHandler,
} from './tasks.js';
import { knowledgePublishHandler } from './knowledge-publish.js';
import { knowledgeSearchHandler } from './knowledge-search.js';
import { pauseTaskHandler } from './pause-task.js';
import { publishToBusHandler } from './publish-to-bus.js';
import { refreshGroupsHandler } from './refresh-groups.js';
import { registerGroupHandler } from './register-group.js';
import { resumeTaskHandler } from './resume-task.js';
import { scheduleTaskHandler } from './schedule-task.js';
import { scheduleWakeupHandler } from './schedule-wakeup.js';
import { updateTaskHandler } from './update-task.js';
import { writeAgentMemoryHandler } from './write-agent-memory.js';
import { writeAgentStateHandler } from './write-agent-state.js';

let registered = false;

export function registerBuiltinHandlers(): void {
  if (registered) return;
  registerIpcHandler(scheduleTaskHandler);
  registerIpcHandler(scheduleWakeupHandler);
  registerIpcHandler(pauseTaskHandler);
  registerIpcHandler(resumeTaskHandler);
  registerIpcHandler(cancelTaskHandler);
  registerIpcHandler(updateTaskHandler);
  registerIpcHandler(refreshGroupsHandler);
  registerIpcHandler(registerGroupHandler);
  registerIpcHandler(publishToBusHandler);
  registerIpcHandler(knowledgePublishHandler);
  registerIpcHandler(knowledgeSearchHandler);
  registerIpcHandler(writeAgentMemoryHandler);
  registerIpcHandler(writeAgentStateHandler);
  registerIpcHandler(dashboardQueryHandler);
  registerIpcHandler(deployMiniAppHandler);
  registerIpcHandler(kgQueryHandler);
  registerIpcHandler(messageHandler);
  registerIpcHandler(sendFileHandler);
  registerIpcHandler(imessageSearchHandler);
  registerIpcHandler(imessageReadHandler);
  registerIpcHandler(imessageSendHandler);
  registerIpcHandler(imessageListContactsHandler);
  registerIpcHandler(taskAddHandler);
  registerIpcHandler(taskListHandler);
  registerIpcHandler(taskCloseHandler);
  registerIpcHandler(taskReopenHandler);
  registerIpcHandler(pageindexFetchHandler);
  registerIpcHandler(pageindexIndexHandler);
  registerIpcHandler(slackDmReadHandler);
  registerIpcHandler(slackDmHandler);
  registerIpcHandler(skillSearchHandler);
  registerIpcHandler(saveSkillHandler);
  registered = true;
}

export function _resetBuiltinHandlersForTests(): void {
  registered = false;
}
