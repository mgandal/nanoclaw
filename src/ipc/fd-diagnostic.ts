import { spawnSync } from 'child_process';
import fs from 'fs';

import { logger } from '../logger.js';

/**
 * FD-pressure diagnostic. Called from any catch that sees EMFILE or ENFILE.
 * Captures process FD count + open-handle counts (timers, sockets, etc.) so
 * a post-mortem can distinguish a process leak from a system-wide overflow.
 *
 * Best-effort — never throws (the caller is already in error-handling).
 */
export function logFdPressureDiagnostic(
  context: Record<string, unknown>,
  err: unknown,
): void {
  // Pull active handle counts via the undocumented but stable Node APIs.
  // These are cheap and tell us whether the leak is in this process.
  let activeHandles = -1;
  let activeRequests = -1;
  try {
    activeHandles = (process as any)._getActiveHandles?.()?.length ?? -1;
    activeRequests = (process as any)._getActiveRequests?.()?.length ?? -1;
  } catch {
    // ignore
  }

  // Try to count this process's open FDs. On Linux read /proc/self/fd.
  // On macOS fall back to lsof via spawnSync (no shell, fixed args).
  let processFdCount: number | string = 'unknown';
  try {
    processFdCount = fs.readdirSync('/proc/self/fd').length;
  } catch {
    try {
      const result = spawnSync('lsof', ['-p', String(process.pid)], {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result.stdout) {
        processFdCount = result.stdout.split('\n').filter(Boolean).length;
      }
    } catch {
      // give up
    }
  }

  logger.error(
    {
      ...context,
      err,
      diagnostic: {
        activeHandles,
        activeRequests,
        processFdCount,
        pid: process.pid,
        rss: process.memoryUsage?.().rss,
      },
    },
    'FD-pressure diagnostic (EMFILE/ENFILE)',
  );
}

/**
 * Scan the IPC base directory for per-group subfolders. Returns the list
 * of directory names (excluding `errors/`).
 *
 * Hardened against FD exhaustion:
 *   - Uses fs.opendirSync so the Dir handle is held in a try/finally
 *     and explicitly closed even on throw. (readdirSync doesn't leak
 *     directly, but the older codepath called statSync inside the
 *     filter; this is a single syscall per entry via Dirent.)
 *   - On EMFILE/ENFILE, fires `logFdPressureDiagnostic` then re-throws.
 *   - Uses Dirent.isDirectory() — saves one stat() syscall per entry.
 *
 * Exported for unit testing.
 */
export function scanIpcGroupFolders(ipcBaseDir: string): string[] {
  const out: string[] = [];
  let dir: fs.Dir | null = null;
  try {
    dir = fs.opendirSync(ipcBaseDir);
    let entry: fs.Dirent | null;
    while ((entry = dir.readSync()) !== null) {
      if (entry.name === 'errors') continue;
      if (entry.isDirectory()) out.push(entry.name);
    }
    return out;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EMFILE' || code === 'ENFILE') {
      logFdPressureDiagnostic({ ipcBaseDir, op: 'scanIpcGroupFolders' }, err);
    }
    throw err;
  } finally {
    if (dir) {
      try {
        dir.closeSync();
      } catch {
        // already closed or stale — irrelevant
      }
    }
  }
}
