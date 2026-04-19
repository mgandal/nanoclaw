import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { fsPathToCompoundKey } from './compound-key.js';
import { BUS_POLL_INTERVAL, BUS_HIGH_PRIORITY_INTERVAL } from './config.js';
import type { BusMessage } from './message-bus.js';

// B3(iii): the bus protocol carries `from` inside the JSON payload. An agent
// with shell access can write a bus-message file directly under a recipient's
// bus dir with `from: "SYSTEM"` (or a traversal path), bypassing the IPC-
// layer `from = sourceAgent || sourceGroup` attribution. Full attribution
// would require signed sender stamps (future work); the cheap containment is
// syntactic + reserved-label blocklist.
const FROM_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FROM = new Set(['SYSTEM', 'USER', 'MAIN', 'OWNER', 'ROOT']);

type DispatchFn = (
  compoundKey: string,
  messages: BusMessage[],
) => Promise<void>;

export class BusWatcher {
  private busDir: string;
  private agentsDir: string;
  private dispatch: DispatchFn;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(busDir: string, dispatch: DispatchFn) {
    this.busDir = busDir;
    this.agentsDir = path.join(busDir, 'agents');
    this.dispatch = dispatch;
  }

  async poll(): Promise<number> {
    if (!fs.existsSync(this.agentsDir)) return BUS_POLL_INTERVAL;

    let hasHighPriority = false;

    for (const entry of fs.readdirSync(this.agentsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      // B3(iii): rejected bus messages land in _errors/; don't re-scan them.
      if (entry.name === '_errors') continue;

      const dirPath = path.join(this.agentsDir, entry.name);
      const pendingFiles = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.json'));
      if (pendingFiles.length === 0) continue;

      // Claim all pending messages
      const messages: BusMessage[] = [];
      const claimedFiles: string[] = [];
      for (const file of pendingFiles) {
        try {
          const filePath = path.join(dirPath, file);
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

          // B3(iii): reject reserved-label or invalid `from`. Move to an
          // _errors/ sibling so the record persists for inspection but is
          // not replayed. Keep this check AFTER parse (need to read content)
          // and BEFORE rename to .processing (otherwise a rejected file
          // ends up stuck in the recipient dir).
          const from = content?.from;
          if (
            typeof from !== 'string' ||
            !FROM_REGEX.test(from) ||
            RESERVED_FROM.has(from.toUpperCase())
          ) {
            logger.warn(
              { file, from },
              'Bus message rejected: invalid or reserved from',
            );
            const errorsDir = path.join(this.agentsDir, '_errors');
            fs.mkdirSync(errorsDir, { recursive: true });
            fs.renameSync(filePath, path.join(errorsDir, file));
            continue;
          }

          const processingPath = filePath.replace('.json', '.processing');
          fs.renameSync(filePath, processingPath);
          messages.push(content);
          claimedFiles.push(file);
          if (content.priority === 'high') hasHighPriority = true;
        } catch (err) {
          logger.warn({ file, err }, 'Failed to read/claim bus message');
        }
      }

      if (messages.length === 0) continue;

      const compoundKey = fsPathToCompoundKey(entry.name);
      try {
        await this.dispatch(compoundKey, messages);
        // Move to done
        const doneDir = path.join(this.busDir, 'done');
        fs.mkdirSync(doneDir, { recursive: true });
        for (const file of claimedFiles) {
          try {
            fs.renameSync(
              path.join(dirPath, file.replace('.json', '.processing')),
              path.join(doneDir, `${entry.name}-${file}`),
            );
          } catch {
            /* already moved */
          }
        }
      } catch (err) {
        logger.error(
          { compoundKey, err },
          'Bus dispatch failed, restoring messages',
        );
        // Restore on failure
        for (const file of claimedFiles) {
          try {
            fs.renameSync(
              path.join(dirPath, file.replace('.json', '.processing')),
              path.join(dirPath, file),
            );
          } catch {
            /* already restored */
          }
        }
      }
    }

    return hasHighPriority ? BUS_HIGH_PRIORITY_INTERVAL : BUS_POLL_INTERVAL;
  }

  start(): void {
    const tick = async () => {
      try {
        const nextInterval = await this.poll();
        this.timer = setTimeout(tick, nextInterval);
      } catch (err) {
        logger.error({ err }, 'Bus watcher poll error');
        this.timer = setTimeout(tick, BUS_POLL_INTERVAL);
      }
    };
    this.timer = setTimeout(tick, BUS_POLL_INTERVAL);
    logger.info('Bus watcher started');
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
