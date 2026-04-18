import { getDb } from './db.js';

export interface ProactiveLogRow {
  id: number;
  timestamp: string;
  from_agent: string;
  to_group: string;
  decision: 'send' | 'defer' | 'drop';
  reason: string;
  urgency: number | null;
  rule_id: string | null;
  correlation_id: string;
  message_preview: string | null;
  /** Full message body. Preview is the 200-char digest slice; body is the
   * full text to re-dispatch on defer. May be null for drop decisions where
   * the body is not needed. */
  message_body: string | null;
  contributing_events: string | null;
  deliver_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  reaction_kind: 'emoji' | 'reply' | null;
  reaction_value: string | null;
}

export interface InsertLog {
  timestamp: string;
  fromAgent: string;
  toGroup: string;
  decision: 'send' | 'defer' | 'drop';
  reason: string;
  urgency?: number;
  ruleId?: string;
  correlationId: string;
  messagePreview?: string;
  messageBody?: string;
  contributingEvents: string[];
  deliverAt?: string;
}

export function insertLog(row: InsertLog): number {
  const res = getDb()
    .prepare(
      `INSERT INTO proactive_log
        (timestamp, from_agent, to_group, decision, reason, urgency, rule_id,
         correlation_id, message_preview, message_body, contributing_events, deliver_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.timestamp,
      row.fromAgent,
      row.toGroup,
      row.decision,
      row.reason,
      row.urgency ?? null,
      row.ruleId ?? null,
      row.correlationId,
      row.messagePreview ?? null,
      row.messageBody ?? null,
      JSON.stringify(row.contributingEvents),
      row.deliverAt ?? null,
    );
  return Number(res.lastInsertRowid);
}

export function hasDeliveredOrDispatchedRecent(
  correlationId: string,
  hoursBack: number,
): boolean {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const row = getDb()
    .prepare(
      `SELECT id FROM proactive_log
       WHERE correlation_id = ? AND timestamp >= ?
         AND (delivered_at IS NOT NULL OR dispatched_at IS NOT NULL)
       LIMIT 1`,
    )
    .get(correlationId, since);
  return !!row;
}

export function getLastAgentSend(fromAgent: string): ProactiveLogRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM proactive_log WHERE from_agent = ? AND decision = 'send'
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(fromAgent) as ProactiveLogRow | undefined) ?? null
  );
}

export function markDispatched(id: number, at: string): void {
  getDb()
    .prepare('UPDATE proactive_log SET dispatched_at = ? WHERE id = ?')
    .run(at, id);
}

export function markDelivered(id: number, at: string): void {
  getDb()
    .prepare('UPDATE proactive_log SET delivered_at = ? WHERE id = ?')
    .run(at, id);
}

export function clearDispatch(id: number): void {
  getDb()
    .prepare('UPDATE proactive_log SET dispatched_at = NULL WHERE id = ?')
    .run(id);
}

export function getDueDefers(nowIso: string): ProactiveLogRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM proactive_log
       WHERE decision = 'defer' AND delivered_at IS NULL AND deliver_at <= ?
       ORDER BY deliver_at ASC`,
    )
    .all(nowIso) as ProactiveLogRow[];
}

export function backfillReaction(
  toGroup: string,
  correlationPattern: RegExp,
  kind: 'emoji' | 'reply',
  value: string,
  windowMs = 3600_000,
): boolean {
  const since = new Date(Date.now() - windowMs).toISOString();
  const candidates = getDb()
    .prepare(
      `SELECT * FROM proactive_log
       WHERE to_group = ? AND decision = 'send' AND reaction_kind IS NULL
         AND delivered_at >= ?
       ORDER BY delivered_at DESC LIMIT 20`,
    )
    .all(toGroup, since) as ProactiveLogRow[];
  const match = candidates.find((r) =>
    correlationPattern.test(r.correlation_id),
  );
  if (!match) return false;
  getDb()
    .prepare(
      `UPDATE proactive_log SET reaction_kind = ?, reaction_value = ? WHERE id = ?`,
    )
    .run(kind, value.slice(0, 500), match.id);
  return true;
}
