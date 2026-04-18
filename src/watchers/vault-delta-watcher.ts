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

  private enqueue(abs: string): void {
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
    if (this.flushTimer) clearTimeout(this.flushTimer);
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
