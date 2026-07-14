import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type { RawEvent } from '../event-router.js';

export interface VaultDeltaConfig {
  roots: string[];
  onEvent: (event: RawEvent) => void;
  coalesceMs?: number;
}

export class VaultDeltaWatcher {
  private cfg: VaultDeltaConfig;
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, { count: number; firstSeen: number }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: VaultDeltaConfig) {
    this.cfg = cfg;
  }

  start(): void {
    for (const root of this.cfg.roots) {
      if (!fs.existsSync(root)) {
        logger.warn({ root }, 'vault-delta-watcher: root not found');
        continue;
      }
      try {
        this.watchers.push(
          fs.watch(root, { recursive: true }, (_ev, filename) => {
            if (!filename) return;
            this.enqueue(path.join(root, filename.toString()));
          }),
        );
      } catch (err) {
        logger.error({ root, err }, 'failed to watch');
      }
    }
  }

  /** @internal Enqueue a path for coalesced emission. Public for tests only;
   * production code uses fs.watch to call this. */
  enqueueForTest(abs: string): void {
    this.enqueue(abs);
  }

  private enqueue(abs: string): void {
    // FSEvents coalesces a newly-created subtree into ONE event for the
    // topmost new directory (observed under Bun on macOS: mkdir -p a/b +
    // write a/b/f.md while watching → a single 'rename a' event; edits to
    // files under pre-existing directories DO carry the file path). A
    // directory path carries no useful tag/author, so recover file
    // granularity with a bounded scan: recurse only into directories whose
    // mtime is fresh (every level of a new subtree is fresh; a big old
    // tree that gets a spurious dir event is pruned immediately). The
    // pending Map dedupes against events that also arrive file-level.
    // Paths that no longer exist fall through — a deletion/rename of a
    // file is a real change signal.
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(abs).isDirectory();
    } catch {
      // ENOENT — deleted/renamed entry; treat as a file-level change
    }
    if (isDirectory) {
      const windowMs = (this.cfg.coalesceMs ?? 30_000) + 5_000;
      const found = this.scanRecentFiles(abs, windowMs, 0);
      // Fresh-mtime scanning misses changes that PRESERVE mtimes (mv or
      // rsync -a of an existing tree into the vault), events delivered
      // after the window, and trees nested past the depth cap. Never
      // swallow those silently (the repo's silent-failure-wedge
      // anti-pattern) — fall back to the pre-2026-07-14 coarse dir-path
      // event so the router still sees SOMETHING changed here.
      if (found === 0) this.enqueueFile(abs);
      return;
    }
    this.enqueueFile(abs);
  }

  /** Returns how many files were enqueued. */
  private scanRecentFiles(
    dir: string,
    windowMs: number,
    depth: number,
  ): number {
    if (depth > 5) return 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    let found = 0;
    for (const entry of entries) {
      const p = path.join(dir, entry);
      try {
        const s = fs.statSync(p);
        const fresh = Date.now() - s.mtimeMs <= windowMs;
        if (s.isFile() && fresh) {
          this.enqueueFile(p);
          found += 1;
        } else if (s.isDirectory() && fresh) {
          found += this.scanRecentFiles(p, windowMs, depth + 1);
        }
      } catch {
        // entry vanished mid-scan
      }
    }
    return found;
  }

  private enqueueFile(abs: string): void {
    const existing = this.pending.get(abs);
    if (existing) existing.count += 1;
    else this.pending.set(abs, { count: 1, firstSeen: Date.now() });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(
        () => this.flush(),
        this.cfg.coalesceMs ?? 30_000,
      );
    }
  }

  private flush(): void {
    this.flushTimer = null;
    for (const [abs, meta] of this.pending.entries()) {
      this.cfg.onEvent({
        type: 'vault_change',
        id: `vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        payload: {
          path: abs,
          tag: extractTag(abs),
          author: inferAuthor(abs),
          coalescedCount: meta.count,
        },
      });
    }
    this.pending.clear();
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      // Null the reference so a subsequent start() + enqueue() can schedule
      // a new flush. clearTimeout cancels the callback but leaves the handle
      // truthy, which would otherwise defeat the `if (!this.flushTimer)`
      // guard in enqueue() forever after the first stop.
      this.flushTimer = null;
    }
    // Drop pending events too — they belong to the stopped session.
    this.pending.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

function extractTag(abs: string): string {
  const n = abs.replace(/\\/g, '/');
  const m = n.match(/\/99-wiki\/([^/]+)\//);
  if (m) return m[1];
  const m2 = n.match(/\/(\d{2}-[^/]+)\//);
  return m2 ? m2[1] : 'other';
}

function inferAuthor(abs: string): 'user' | 'agent' | 'unknown' {
  return abs.includes('/agents/output/') ? 'agent' : 'user';
}
