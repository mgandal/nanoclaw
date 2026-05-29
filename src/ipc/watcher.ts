import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import type { IpcDeps } from '../ipc.js';
import { processIpcMessage, processTaskIpc } from '../ipc.js';
import { scanIpcGroupFolders } from './fd-diagnostic.js';

/**
 * Claim and process every `.json` file in `queueDir`.
 *
 * Each file is claimed by renaming it to `<name>.processing` BEFORE any side
 * effect runs — if the process crashes mid-handler, the `.processing` file is
 * not re-read on the next poll (cleanupStaleProcessing sweeps it to errors/
 * instead of replaying). A rename that loses the race (another poll cycle
 * already claimed the file) is skipped silently.
 *
 * On success the `.processing` file is unlinked. On a parse error or a
 * `processor` throw, the file is moved to `errorDir` named
 * `<sourceGroup>-<originalName>` for manual inspection.
 *
 * A missing `queueDir` is a no-op. Errors reading the directory propagate to
 * the caller (the watcher logs them per-group).
 *
 * `sourceGroup` is the per-group namespace (used both as the errors/ filename
 * prefix and as the `sourceGroup` log field). `kind` ('message' | 'task')
 * only shapes the failure log message so it reads identically to the original
 * inline loops ("Error processing IPC message" / "...task"). Both default to
 * neutral values so the helper is testable without a group context.
 *
 * Exported for unit testing.
 */
export async function claimAndProcessDir(
  queueDir: string,
  errorDir: string,
  processor: (
    data: { type: string } & Record<string, unknown>,
  ) => Promise<void>,
  sourceGroup = '',
  kind: 'message' | 'task' = 'message',
): Promise<void> {
  if (!fs.existsSync(queueDir)) return;

  const files = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(queueDir, file);
    const processingPath = `${filePath}.processing`;
    try {
      fs.renameSync(filePath, processingPath);
    } catch {
      continue; // another poll cycle already claimed it
    }
    try {
      const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
      await processor(data);
      fs.unlinkSync(processingPath);
    } catch (err) {
      logger.error(
        { file, sourceGroup, err },
        `Error processing IPC ${kind}`,
      );
      fs.mkdirSync(errorDir, { recursive: true });
      try {
        const errorName = sourceGroup ? `${sourceGroup}-${file}` : file;
        fs.renameSync(processingPath, path.join(errorDir, errorName));
      } catch {
        // processingPath may already be gone
      }
    }
  }
}

function cleanupStaleProcessing(ipcBaseDir: string): void {
  try {
    const errorDir = path.join(ipcBaseDir, 'errors');
    for (const groupDir of fs.readdirSync(ipcBaseDir)) {
      const groupPath = path.join(ipcBaseDir, groupDir);
      if (!fs.statSync(groupPath).isDirectory() || groupDir === 'errors')
        continue;
      for (const subDir of ['messages', 'tasks']) {
        const dirPath = path.join(groupPath, subDir);
        if (!fs.existsSync(dirPath)) continue;
        const stale = fs
          .readdirSync(dirPath)
          .filter((f) => f.endsWith('.processing'));
        for (const file of stale) {
          fs.mkdirSync(errorDir, { recursive: true });
          try {
            fs.renameSync(
              path.join(dirPath, file),
              path.join(errorDir, `${groupDir}-stale-${file}`),
            );
          } catch {
            // already moved or gone
          }
        }
        if (stale.length > 0) {
          logger.warn(
            { group: groupDir, subDir, count: stale.length },
            'Moved stale .processing IPC files to errors/',
          );
        }
      }
    }
  } catch {
    // Non-fatal: best-effort cleanup
  }
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Clean up stale .processing files from previous crashes.
  // These represent IPC that may or may not have been executed,
  // so we move them to errors/ for manual inspection rather than replaying.
  cleanupStaleProcessing(ipcBaseDir);

  const errorDir = path.join(ipcBaseDir, 'errors');

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory).
    // scanIpcGroupFolders wraps the Dir handle in try/finally and emits an
    // FD-pressure diagnostic on EMFILE/ENFILE before re-throwing.
    let groupFolders: string[];
    try {
      groupFolders = scanIpcGroupFolders(ipcBaseDir);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory.
      try {
        await claimAndProcessDir(
          messagesDir,
          errorDir,
          (data) => processIpcMessage(data, sourceGroup, isMain, deps),
          sourceGroup,
          'message',
        );
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory. Source group identity
      // (sourceGroup, isMain) comes from the directory path, not the payload.
      try {
        await claimAndProcessDir(
          tasksDir,
          errorDir,
          (data) => processTaskIpc(data, sourceGroup, isMain, deps),
          sourceGroup,
          'task',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}
