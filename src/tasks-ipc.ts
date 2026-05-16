// IPC handlers for task-table agent requests.
//
// Four request types (symmetric to the MCP tool names exposed in the
// container):
//   { type: 'task_add',    requestId, title, ... }
//   { type: 'task_list',   requestId, status, owner, due_before, ... }
//   { type: 'task_close',  requestId, id|title_match, outcome, reason }
//   { type: 'task_reopen', requestId, id, reason }
//
// Results go to data/ipc/{sourceGroup}/task_results/{requestId}.json —
// container MCP tool polls for the file, parses, returns to the model.
//
// Two consumer surfaces share the per-action runners below:
//   1. `handleTasksIpc` — legacy library entry point, retained for the
//      tasks-ipc.test.ts + tasks-ipc-reopen.test.ts harnesses.
//   2. The four handlers in src/ipc/handlers/{task-add,task-list,
//      task-close,task-reopen}.ts — dispatched via the IpcHandler registry.
//      The dispatcher writes the result file (Rule 1).

import fs from 'fs';
import os from 'os';
import path from 'path';

import { addTask, closeTask, listTasksDetailed, reopenTask } from './tasks.js';
import { logger } from './logger.js';

const TASK_TYPES = new Set([
  'task_add',
  'task_list',
  'task_close',
  'task_reopen',
]);

export type TaskIpcResult = Record<string, unknown>;

/**
 * task_add core. Caller-attribution rule preserved exactly:
 *   - Main callers may stamp any group_folder, or '' for global.
 *   - Non-main callers are always stamped with their own sourceGroup,
 *     regardless of payload. Prevents one group from planting tasks
 *     attributed to another.
 */
export function runTaskAdd(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
): TaskIpcResult {
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
  logger.info(
    { sourceGroup, taskId: result.id, success: result.success },
    'task_add handled',
  );
  return result as unknown as Record<string, unknown>;
}

export function runTaskList(data: Record<string, unknown>): TaskIpcResult {
  const detailed = listTasksDetailed({
    status: data.status as 'open' | 'done' | 'archived' | 'all' | undefined,
    owner: data.owner as string | undefined,
    due_before: data.due_before as string | undefined,
    group_folder: data.group_folder as string | undefined,
    limit: data.limit as number | undefined,
  });
  logger.info(
    { count: detailed.count, truncated: detailed.truncated },
    'task_list handled',
  );
  return {
    success: true,
    tasks: detailed.tasks,
    count: detailed.count,
    truncated: detailed.truncated,
    limit: detailed.limit,
  };
}

export function runTaskClose(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
): TaskIpcResult {
  const result = closeTask({
    id: data.id as number | undefined,
    title_match: data.title_match as string | undefined,
    outcome: data.outcome as 'done' | 'archived',
    reason: data.reason as string | undefined,
    callerGroup: sourceGroup,
    callerIsMain: isMain,
  });
  logger.info(
    { sourceGroup, isMain, matched: result.matched, success: result.success },
    'task_close handled',
  );
  return result as unknown as Record<string, unknown>;
}

export function runTaskReopen(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
): TaskIpcResult {
  const id = data.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return { success: false, error: 'id must be a positive integer' };
  }
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (!reason) {
    return { success: false, error: 'reason is required' };
  }
  const result = reopenTask({
    id,
    reason,
    callerGroup: sourceGroup,
    callerIsMain: isMain,
  });
  if (result.success) {
    // Append a cooling-off event to the email-ingest JSONL so the
    // closure-trainer can downweight the counterparty that produced
    // the false-positive close. Non-fatal — failure is logged.
    try {
      const jsonlPath = path.join(
        process.env.HOME ?? os.homedir(),
        '.cache',
        'email-ingest',
        'task-closures.jsonl',
      );
      fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
      const event = {
        ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        action: 'reopened',
        task_id: id,
        reason,
        feedback_source: 'agent',
      };
      fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n');
    } catch (err) {
      logger.warn(
        { taskId: id, err },
        'task_reopen: failed to append cooling-off event (non-fatal)',
      );
    }
  }
  logger.info(
    { sourceGroup, isMain, taskId: id, success: result.success },
    'task_reopen handled',
  );
  return result as unknown as Record<string, unknown>;
}

/**
 * Legacy library entry point. Validates requestId, dispatches to the
 * appropriate run* function, writes the result file. Retained for the
 * tasks-ipc.test.ts + tasks-ipc-reopen.test.ts harnesses.
 *
 * The dispatcher-driven path lives in src/ipc/handlers/task-*.ts and
 * is registered through the IpcHandler registry. The if-ladder caller
 * has been removed.
 */
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
      writeResult(runTaskAdd(data, sourceGroup, isMain));
      return true;
    }
    if (type === 'task_list') {
      writeResult(runTaskList(data));
      return true;
    }
    if (type === 'task_close') {
      writeResult(runTaskClose(data, sourceGroup, isMain));
      return true;
    }
    if (type === 'task_reopen') {
      writeResult(runTaskReopen(data, sourceGroup, isMain));
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
