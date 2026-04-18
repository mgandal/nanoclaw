import type { RawEvent } from '../event-router.js';

export interface ThreadMessage {
  direction: 'inbound' | 'outbound';
  from: string;
  subject: string;
  timestamp: string;
}

export interface QmdEmailClient {
  queryThreads: () => Promise<
    { threadId: string; messages: ThreadMessage[] }[]
  >;
}

export interface ThreadSilenceConfig {
  qmd: QmdEmailClient;
  onEvent: (event: RawEvent) => void;
  hasRecentEmission: (threadId: string) => boolean;
  silentThresholdHours?: number;
}

export class ThreadSilenceWatcher {
  constructor(private cfg: ThreadSilenceConfig) {}

  async poll(): Promise<void> {
    const threshold = (this.cfg.silentThresholdHours ?? 48) * 3600_000;
    const now = Date.now();
    const threads = await this.cfg.qmd.queryThreads();
    for (const t of threads) {
      if (this.cfg.hasRecentEmission(t.threadId)) continue;
      const sorted = [...t.messages].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
      );
      const latest = sorted[sorted.length - 1];
      if (!latest || latest.direction !== 'inbound') continue;
      const age = now - Date.parse(latest.timestamp);
      if (age < threshold) continue;
      this.cfg.onEvent({
        type: 'silent_thread',
        id: `silent-${t.threadId}-${now}`,
        timestamp: new Date(now).toISOString(),
        payload: {
          thread_id: t.threadId,
          sender: latest.from,
          subject: latest.subject,
          lastReceivedAt: latest.timestamp,
          daysSilent: Math.floor(age / 86400_000),
        },
      });
    }
  }
}
