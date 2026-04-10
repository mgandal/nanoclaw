import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { fsPathToCompoundKey } from './compound-key.js';
import { BUS_POLL_INTERVAL, BUS_HIGH_PRIORITY_INTERVAL } from './config.js';
import type { BusMessage } from './message-bus.js';

type DispatchFn = (compoundKey: string, messages: BusMessage[]) => Promise<void>;

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

    for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(this.agentsDir, entry.name);
      const pendingFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
      if (pendingFiles.length === 0) continue;

      // Claim all pending messages
      const messages: BusMessage[] = [];
      const claimedFiles: string[] = [];
      for (const file of pendingFiles) {
        try {
          const filePath = path.join(dirPath, file);
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
          } catch { /* already moved */ }
        }
      } catch (err) {
        logger.error({ compoundKey, err }, 'Bus dispatch failed, restoring messages');
        // Restore on failure
        for (const file of claimedFiles) {
          try {
            fs.renameSync(
              path.join(dirPath, file.replace('.json', '.processing')),
              path.join(dirPath, file),
            );
          } catch { /* already restored */ }
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
