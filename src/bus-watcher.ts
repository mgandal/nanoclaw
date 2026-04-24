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

// C15: short-TTL dedup window. A dispatch that threw after partial side
// effects would otherwise re-fire on the next poll after the `.processing`
// → `.json` restore. 5 minutes is long enough that most transient
// exceptions have surfaced by then, and short enough that a legitimate
// operator re-queue (same id, later) is not blocked forever.
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;

export interface BusWatcherOptions {
  /** Override the C15 dedup TTL. Tests use tiny values; production default is 5 min. */
  dedupTtlMs?: number;
}

export class BusWatcher {
  private busDir: string;
  private agentsDir: string;
  private dispatch: DispatchFn;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // C15: message-id → expireAt ms. Checked on claim; populated at the
  // moment dispatch() is called so the restored-on-failure file is
  // recognized as a repeat on the next poll.
  private dispatched: Map<string, number> = new Map();
  private dedupTtlMs: number;

  constructor(
    busDir: string,
    dispatch: DispatchFn,
    opts: BusWatcherOptions = {},
  ) {
    this.busDir = busDir;
    this.agentsDir = path.join(busDir, 'agents');
    this.dispatch = dispatch;
    this.dedupTtlMs = opts.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
  }

  /** C15: sweep expired entries out of the dedup map. */
  private sweepDispatched(): void {
    const now = Date.now();
    for (const [id, expireAt] of this.dispatched) {
      if (expireAt <= now) this.dispatched.delete(id);
    }
  }

  /** C15: move a repeat-id file to agents/_stale/ so it is not re-scanned. */
  private moveToStale(recipientDir: string, file: string): void {
    const staleDir = path.join(this.agentsDir, '_stale');
    try {
      fs.mkdirSync(staleDir, { recursive: true });
      const base = path.basename(recipientDir);
      fs.renameSync(
        path.join(recipientDir, file),
        path.join(staleDir, `${base}-${file}`),
      );
    } catch (err) {
      logger.warn({ err, file }, 'Failed to move repeat bus message to _stale');
    }
  }

  async poll(): Promise<number> {
    if (!fs.existsSync(this.agentsDir)) return BUS_POLL_INTERVAL;

    // C15: expire stale dedup entries before reading the next batch. Cheap
    // — at most N=in-flight-messages iterations per poll under normal load.
    this.sweepDispatched();

    let hasHighPriority = false;

    for (const entry of fs.readdirSync(this.agentsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      // B3(iii): rejected bus messages land in _errors/; don't re-scan them.
      // C15: repeat-id messages land in _stale/; same skip.
      if (entry.name === '_errors' || entry.name === '_stale') continue;

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

          // C15: dedup — if we already attempted dispatch for this id within
          // the TTL window, skip. Previous attempt either succeeded
          // (file is already in done/) or threw after some side effects —
          // either way, re-firing risks duplicate side effects. Move to
          // _stale/ for operator inspection, not done/ (so it's visibly
          // distinct from normal completions).
          const msgId =
            typeof content?.id === 'string' && content.id ? content.id : null;
          if (msgId && this.dispatched.has(msgId)) {
            logger.warn(
              { file, msgId, recipient: entry.name },
              'Bus message repeat within dedup TTL; moving to _stale/',
            );
            this.moveToStale(dirPath, file);
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

      // C15: mark each message's id as attempted BEFORE dispatch runs, so a
      // mid-dispatch throw + .processing → .json restore is recognized as a
      // repeat on the next poll. Messages without an id are not tracked —
      // they still dispatch normally but can't be deduped (best-effort).
      const expireAt = Date.now() + this.dedupTtlMs;
      for (const m of messages) {
        if (typeof m.id === 'string' && m.id) {
          this.dispatched.set(m.id, expireAt);
        }
      }

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
