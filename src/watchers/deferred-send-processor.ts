import { getDueDefers, markDelivered } from '../proactive-log.js';
import { logger } from '../logger.js';

export interface DeferredSendProcessorConfig {
  send: (s: {
    toGroup: string;
    text: string;
    correlationId: string;
    fromAgent: string;
    urgency: number;
    ruleId?: string;
    contributingEvents: string[];
  }) => Promise<void>;
  now?: () => Date;
}

export class DeferredSendProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private cfg: DeferredSendProcessorConfig) {}

  async poll(): Promise<void> {
    const now = this.cfg.now?.() ?? new Date();
    const due = getDueDefers(now.toISOString());
    for (const r of due) {
      try {
        // Prefer the full body; fall back to the 200-char preview only for
        // legacy rows written before the message_body column was added.
        const text = r.message_body ?? r.message_preview ?? '';
        await this.cfg.send({
          toGroup: r.to_group,
          text,
          correlationId: r.correlation_id,
          fromAgent: r.from_agent,
          urgency: r.urgency ?? 0.5,
          ruleId: r.rule_id ?? undefined,
          contributingEvents: r.contributing_events
            ? JSON.parse(r.contributing_events)
            : [],
        });
        markDelivered(r.id, new Date().toISOString());
      } catch (err) {
        logger.warn({ err, id: r.id }, 'deferred send failed, will retry');
      }
    }
  }

  start(intervalMs = 60_000): void {
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.poll();
      }, intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
