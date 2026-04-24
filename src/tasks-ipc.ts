// IPC handler for task-table agent requests.
//
// Three request types (symmetric to the MCP tool names exposed in the
// container):
//   { type: 'task_add',   requestId, title, ... }
//   { type: 'task_list',  requestId, status, owner, due_before, ... }
//   { type: 'task_close', requestId, id|title_match, outcome, reason }
//
// Results go to data/ipc/{sourceGroup}/task_results/{requestId}.json —
// container MCP tool polls for the file, parses, returns to the model.

import fs from 'fs';
import path from 'path';

import { addTask, closeTask, listTasksDetailed } from './tasks.js';
import { logger } from './logger.js';

const TASK_TYPES = new Set(['task_add', 'task_list', 'task_close']);

export async function handleTasksIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;
  if (!TASK_TYPES.has(type)) return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn(
      { type, sourceGroup, requestId },
      'tasks IPC invalid requestId',
    );
    return true; // handled (dropped)
  }

  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'task_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    if (type === 'task_add') {
      // Authorization on group_folder attribution:
      //   Main callers (CLAIRE) may stamp any group_folder, or '' for global.
      //   Non-main callers are always stamped with their own sourceGroup,
      //   regardless of what the payload says. This prevents one group from
      //   planting tasks attributed to another group (which would distort
      //   task_list(group_folder=X) results and the task_close auth trail).
      let groupFolder: string | undefined;
      if (isMain) {
        groupFolder =
          data.group_folder === ''
            ? undefined
            : ((data.group_folder as string | undefined) ?? sourceGroup);
      } else {
        if (
          typeof data.group_folder === 'string' &&
          data.group_folder !== sourceGroup
        ) {
          logger.warn(
            {
              sourceGroup,
              requestedGroupFolder: data.group_folder,
            },
            'task_add: non-main caller tried to set foreign group_folder; forcing sourceGroup',
          );
        }
        groupFolder = sourceGroup;
      }
      const result = addTask({
        title: data.title as string,
        context: data.context as string | undefined,
        owner: data.owner as string | undefined,
        priority: data.priority as number | undefined,
        due_date: data.due_date as string | undefined,
        source: (data.source as string) ?? 'manual',
        source_ref: data.source_ref as string | undefined,
        group_folder: groupFolder,
        force: Boolean(data.force),
      });
      writeResult(result as unknown as Record<string, unknown>);
      logger.info(
        { sourceGroup, taskId: result.id, success: result.success },
        'task_add IPC handled',
      );
      return true;
    }

    if (type === 'task_list') {
      const detailed = listTasksDetailed({
        status: data.status as 'open' | 'done' | 'archived' | 'all' | undefined,
        owner: data.owner as string | undefined,
        due_before: data.due_before as string | undefined,
        group_folder: data.group_folder as string | undefined,
        limit: data.limit as number | undefined,
      });
      writeResult({
        success: true,
        tasks: detailed.tasks,
        count: detailed.count,
        truncated: detailed.truncated,
        limit: detailed.limit,
      });
      logger.info(
        { sourceGroup, count: detailed.count, truncated: detailed.truncated },
        'task_list IPC handled',
      );
      return true;
    }

    if (type === 'task_close') {
      const result = closeTask({
        id: data.id as number | undefined,
        title_match: data.title_match as string | undefined,
        outcome: data.outcome as 'done' | 'archived',
        reason: data.reason as string | undefined,
        callerGroup: sourceGroup,
        callerIsMain: isMain,
      });
      writeResult(result as unknown as Record<string, unknown>);
      logger.info(
        {
          sourceGroup,
          isMain,
          matched: result.matched,
          success: result.success,
        },
        'task_close IPC handled',
      );
      return true;
    }
  } catch (err) {
    logger.error({ err, type, requestId }, 'tasks IPC error');
    writeResult({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
