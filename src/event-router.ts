/**
 * Event Router for NanoClaw Phase 2
 *
 * Classifies incoming email and calendar events via Ollama, applies trust
 * matrix rules to determine routing (notify / autonomous / escalate), then
 * publishes the result to the message bus.
 *
 * Architecture:
 *   RawEvent → classify (Ollama) → applyTrustRules → publish → (onEscalate?)
 */

import { logger } from './logger.js';
import {
  getEmailClassificationPrompt,
  getCalendarClassificationPrompt,
  getVaultChangeClassificationPrompt,
  getSilentThreadPrompt,
  getTaskOutcomePrompt,
  type EmailPayload,
  type CalendarPayload,
  type VaultChangePayload,
  type SilentThreadPayload,
  type TaskOutcomePayload,
} from './classification-prompts.js';

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface RawEvent {
  type:
    | 'email'
    | 'calendar'
    | 'vault_change'
    | 'silent_thread'
    | 'task_outcome';
  id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface Classification {
  importance: number;
  urgency: number;
  topic: string;
  summary: string;
  suggestedRouting: 'notify' | 'autonomous' | 'escalate';
  requiresClaude: boolean;
  confidence: number;
}

export interface ClassifiedEvent {
  event: RawEvent;
  classification: Classification;
  routing: 'notify' | 'autonomous' | 'escalate';
  classifiedAt: string;
  latencyMs: number;
}

export interface TrustRuleConditions {
  importance_lt?: number;
  importance_gte?: number;
  change_type?: string;
  sender_domain?: string[];
}

export interface TrustRule {
  event_type?: 'email' | 'calendar';
  conditions?: TrustRuleConditions;
  routing: 'notify' | 'autonomous' | 'escalate';
  action?: string;
}

export interface TrustConfig {
  default_routing: 'notify' | 'autonomous' | 'escalate';
  rules: TrustRule[];
}

export interface MessageBusLike {
  publish: (data: Record<string, unknown>) => unknown;
}

export interface HealthMonitorLike {
  recordOllamaLatency: (ms: number) => void;
  isOllamaDegraded: () => boolean;
  tryProbeAndRecover?: (ollamaHost: string) => Promise<boolean>;
}

export interface EventRouterConfig {
  ollamaHost: string;
  ollamaModel: string;
  trustRules: TrustRule[];
  defaultRouting?: 'notify' | 'autonomous' | 'escalate';
  messageBus: MessageBusLike;
  healthMonitor: HealthMonitorLike;
  onEscalate?: (event: ClassifiedEvent) => void;
  ollamaTimeoutMs?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CLASSIFICATION: Classification = {
  importance: 0.5,
  urgency: 0.5,
  topic: 'unknown',
  summary: 'Classification unavailable',
  suggestedRouting: 'notify',
  requiresClaude: false,
  confidence: 0,
};

const DEFAULT_OLLAMA_TIMEOUT_MS = 15_000;

// ─── C12: Sanitize Ollama-derived classification fields ──────────────────────
//
// Ollama classifies attacker-controlled email bodies. The returned `topic`
// and `summary` then flow into urgentTopics matching (routing), bus message
// payloads (downstream prompts), and system alerts. Treat Ollama output as
// adversarial: bound length, strip structural tokens (XML tags, control
// chars, markdown headers), and collapse whitespace for `summary`.
//
// Sanitizing at the parse boundary means every consumer reads an
// already-bounded string — no need to re-implement caps everywhere.

export const CLASSIFICATION_TOPIC_MAX_LEN = 80;
export const CLASSIFICATION_SUMMARY_MAX_LEN = 500;

export function sanitizeClassificationText(
  value: unknown,
  mode: 'topic' | 'summary',
): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  let s = value.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  // Strip XML/HTML tags wholesale — attackers use them to inject pseudo
  // agent/system prompts in downstream contexts.
  s = s.replace(/<[^>]*>/g, '');
  if (mode === 'topic') {
    // Topic is a short categorical label — restrict to word chars, hyphens,
    // colons, spaces. This also strips `#`, `*`, `---`, quotes.
    s = s.replace(/[^\w\-:\s]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, CLASSIFICATION_TOPIC_MAX_LEN);
  }
  // Summary — allow natural punctuation but collapse all whitespace
  // (including newlines) to a single space.
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, CLASSIFICATION_SUMMARY_MAX_LEN);
}

// ─── EventRouter ──────────────────────────────────────────────────────────────

export class EventRouter {
  private config: EventRouterConfig;
  private processed = 0;
  private latencies: number[] = [];
  private routingCounts: Record<string, number> = {
    notify: 0,
    autonomous: 0,
    escalate: 0,
  };

  constructor(config: EventRouterConfig) {
    this.config = config;
  }

  async route(event: RawEvent): Promise<ClassifiedEvent> {
    const start = Date.now();

    let classification: Classification;
    if (this.config.healthMonitor.isOllamaDegraded()) {
      // Half-open probe: try a cheap recovery check before falling back. If
      // Ollama is healthy now, the probe records a small latency that
      // dilutes p95, lets the breaker self-close, and we run real
      // classification. Without this, a single timeout on a cold model
      // wedges the breaker for a full hour.
      const recovered = this.config.healthMonitor.tryProbeAndRecover
        ? await this.config.healthMonitor.tryProbeAndRecover(
            this.config.ollamaHost,
          )
        : false;
      if (recovered && !this.config.healthMonitor.isOllamaDegraded()) {
        logger.info(
          { eventId: event.id },
          'Ollama recovery probe succeeded — resuming classification',
        );
        classification = await this.classify(event);
      } else {
        logger.warn(
          { eventId: event.id },
          'Ollama degraded — using fallback classification',
        );
        classification = { ...DEFAULT_CLASSIFICATION };
      }
    } else {
      classification = await this.classify(event);
    }

    const latencyMs = Date.now() - start;
    const routing = this.applyTrustRules(event, classification);

    const classified: ClassifiedEvent = {
      event,
      classification,
      routing,
      classifiedAt: new Date().toISOString(),
      latencyMs,
    };

    this.config.messageBus.publish({
      from: 'event-router',
      topic: 'classified_event',
      eventId: event.id,
      eventType: event.type,
      routing,
      classification,
      classifiedAt: classified.classifiedAt,
    });

    if (routing === 'escalate' && this.config.onEscalate) {
      Promise.resolve(this.config.onEscalate(classified)).catch((err) =>
        logger.error({ err, eventId: event.id }, 'Escalation callback failed'),
      );
    }

    this.processed++;
    this.latencies.push(latencyMs);
    if (this.latencies.length > 1000) {
      this.latencies = this.latencies.slice(-1000);
    }
    this.routingCounts[routing] = (this.routingCounts[routing] ?? 0) + 1;

    logger.info(
      { eventId: event.id, eventType: event.type, routing, latencyMs },
      'Event classified and routed',
    );

    return classified;
  }

  getStats(): {
    processed: number;
    byRouting: Record<string, number>;
    avgLatencyMs: number;
  } {
    const avg =
      this.latencies.length > 0
        ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
        : 0;
    return {
      processed: this.processed,
      byRouting: { ...this.routingCounts },
      avgLatencyMs: avg,
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private async classify(event: RawEvent): Promise<Classification> {
    const timeoutMs = this.config.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    const { system, prompt } = this.buildPrompt(event);

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.config.ollamaHost}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.config.ollamaModel,
            prompt,
            system,
            stream: false,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - start;
      this.config.healthMonitor.recordOllamaLatency(latencyMs);

      if (!response.ok) {
        logger.warn(
          { status: response.status, eventId: event.id },
          'Ollama returned non-OK status — using fallback',
        );
        return { ...DEFAULT_CLASSIFICATION };
      }

      const body = (await response.json()) as { response?: string };
      return this.parseClassification(body.response ?? '');
    } catch (err) {
      const latencyMs = Date.now() - start;
      this.config.healthMonitor.recordOllamaLatency(latencyMs);
      logger.warn(
        { err, eventId: event.id },
        'Ollama classification failed — using fallback',
      );
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  private buildPrompt(event: RawEvent): { system: string; prompt: string } {
    switch (event.type) {
      case 'email':
        return getEmailClassificationPrompt(
          event.payload as unknown as EmailPayload,
        );
      case 'calendar':
        return getCalendarClassificationPrompt(
          event.payload as unknown as CalendarPayload,
        );
      case 'vault_change':
        return getVaultChangeClassificationPrompt(
          event.payload as unknown as VaultChangePayload,
        );
      case 'silent_thread':
        return getSilentThreadPrompt(
          event.payload as unknown as SilentThreadPayload,
        );
      case 'task_outcome':
        return getTaskOutcomePrompt(
          event.payload as unknown as TaskOutcomePayload,
        );
      default: {
        const _: never = event.type;
        throw new Error(`Unknown event type: ${_}`);
      }
    }
  }

  private parseClassification(raw: string): Classification {
    try {
      // Extract JSON from response (may be wrapped in markdown code fences)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(
          { raw },
          'No JSON found in Ollama response — using fallback',
        );
        return { ...DEFAULT_CLASSIFICATION };
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<Classification>;

      // C12: treat Ollama `topic` and `summary` as adversarial. Clamp
      // length, strip XML/control chars, collapse whitespace — so every
      // downstream consumer (urgentTopics matching, bus payloads, logs,
      // alerts) reads an already-bounded string.
      const rawTopic =
        typeof parsed.topic === 'string' ? parsed.topic : 'unknown';
      const rawSummary =
        typeof parsed.summary === 'string' ? parsed.summary : 'No summary';
      const topic = sanitizeClassificationText(rawTopic, 'topic') || 'unknown';
      const summary =
        sanitizeClassificationText(rawSummary, 'summary') || 'No summary';

      return {
        importance:
          typeof parsed.importance === 'number' ? parsed.importance : 0.5,
        urgency: typeof parsed.urgency === 'number' ? parsed.urgency : 0.5,
        topic,
        summary,
        suggestedRouting: this.isValidRouting(parsed.suggestedRouting)
          ? parsed.suggestedRouting
          : 'notify',
        requiresClaude:
          typeof parsed.requiresClaude === 'boolean'
            ? parsed.requiresClaude
            : false,
        confidence:
          typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      };
    } catch (err) {
      logger.warn(
        { err, raw },
        'Failed to parse Ollama classification JSON — using fallback',
      );
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  private isValidRouting(
    value: unknown,
  ): value is 'notify' | 'autonomous' | 'escalate' {
    return value === 'notify' || value === 'autonomous' || value === 'escalate';
  }

  private applyTrustRules(
    event: RawEvent,
    classification: Classification,
  ): 'notify' | 'autonomous' | 'escalate' {
    for (const rule of this.config.trustRules) {
      if (!this.ruleMatchesEvent(rule, event, classification)) continue;
      return rule.routing;
    }

    // No rule matched — use default
    return this.config.defaultRouting ?? 'notify';
  }

  private ruleMatchesEvent(
    rule: TrustRule,
    event: RawEvent,
    classification: Classification,
  ): boolean {
    // Check event_type filter
    if (rule.event_type && rule.event_type !== event.type) return false;

    const conditions = rule.conditions;
    if (!conditions) return true; // rule has no conditions → always matches for this event_type

    // importance_lt
    if (conditions.importance_lt !== undefined) {
      if (classification.importance >= conditions.importance_lt) return false;
    }

    // importance_gte
    if (conditions.importance_gte !== undefined) {
      if (classification.importance < conditions.importance_gte) return false;
    }

    // change_type — checked against payload field
    if (conditions.change_type !== undefined) {
      const changeType =
        (event.payload['change_type'] as string | undefined) ??
        (event.payload['changeType'] as string | undefined);
      if (changeType !== conditions.change_type) return false;
    }

    // sender_domain — checked against payload.from
    if (conditions.sender_domain !== undefined) {
      const rawFrom = event.payload['from'] as string | undefined;
      if (!rawFrom) return false;
      // Extract address from optional "Display Name <addr>" format
      const addrMatch =
        rawFrom.match(/<([^>]+)>/) || rawFrom.match(/(\S+@\S+)/);
      const addr = addrMatch ? addrMatch[1] : rawFrom;
      const domain = addr.includes('@') ? addr.split('@')[1].toLowerCase() : '';
      if (!conditions.sender_domain.includes(domain)) return false;
    }

    return true;
  }
}
