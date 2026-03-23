import fs from 'fs';
import path from 'path';

import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getTaskRunLogs,
} from './db.js';
import { logger } from './logger.js';

const GROUPS_DIR = path.join(process.cwd(), 'groups');
const SESSIONS_DIR = path.join(process.cwd(), 'data', 'sessions');

/**
 * Handle dashboard_query IPC requests from container agents.
 * Follows the same pattern as handlePageindexIpc.
 * Returns true if handled, false if not a dashboard type.
 */
export async function handleDashboardIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  if (data.type !== 'dashboard_query') return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn({ sourceGroup, requestId }, 'dashboard IPC invalid requestId');
    return true;
  }

  const queryType = data.queryType as string | undefined;
  const resultsDir = path.join(
    dataDir,
    'ipc',
    sourceGroup,
    'dashboard_results',
  );
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    switch (queryType) {
      case 'task_summary': {
        const tasks = getAllTasks();
        writeResult({
          success: true,
          tasks: tasks.map((t) => ({
            id: t.id,
            group_folder: t.group_folder,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
            last_run: t.last_run,
            last_result: t.last_result,
            context_mode: t.context_mode,
          })),
        });
        break;
      }

      case 'run_logs_24h': {
        const since = new Date(Date.now() - 24 * 3600000).toISOString();
        const logs = getTaskRunLogs(since);
        writeResult({ success: true, logs });
        break;
      }

      case 'run_logs_7d': {
        const since = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
        const logs = getTaskRunLogs(since);
        writeResult({ success: true, logs });
        break;
      }

      case 'group_summary': {
        const groups = getAllRegisteredGroups();
        const sessions = getAllSessions();
        writeResult({
          success: true,
          groups: Object.entries(groups).map(([jid, g]) => ({
            jid,
            name: g.name,
            folder: g.folder,
            isMain: g.isMain,
            hasSession: !!sessions[g.folder],
          })),
        });
        break;
      }

      case 'skill_inventory': {
        const groups = getAllRegisteredGroups();
        const inventory: Record<string, number> = {};
        for (const g of Object.values(groups)) {
          const skillsDir = path.join(
            SESSIONS_DIR,
            g.folder,
            '.claude',
            'skills',
          );
          try {
            const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
            inventory[g.folder] = entries.filter((e) => e.isDirectory()).length;
          } catch {
            inventory[g.folder] = 0;
          }
        }
        writeResult({ success: true, inventory });
        break;
      }

      case 'state_freshness': {
        const stateDir = path.join(GROUPS_DIR, 'global', 'state');
        const freshness: Record<string, string> = {};
        try {
          for (const file of fs.readdirSync(stateDir)) {
            const stat = fs.statSync(path.join(stateDir, file));
            freshness[file] = stat.mtime.toISOString();
          }
        } catch {
          // state dir may not exist
        }
        writeResult({ success: true, freshness });
        break;
      }

      default:
        writeResult({
          success: false,
          error: `Unknown query type: ${queryType}`,
        });
    }

    logger.info({ queryType, requestId, sourceGroup }, 'dashboard IPC handled');
    return true;
  } catch (err) {
    logger.error({ err, queryType, requestId }, 'dashboard IPC error');
    writeResult({
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}
