/**
 * event-router.hardening.test.ts
 *
 * Regression tests targeting known failure modes in EventRouter and
 * HealthMonitor.tryProbeAndRecover, written TDD-first (RED then GREEN).
 *
 * Bug classes covered:
 *   1. Stuck-breaker recovery edges — probe cooldown after failure, non-ok
 *      probe response, partial-recovery (probe ok but still degraded)
 *   2. Breaker OPENING direction — exact sample count to trip the breaker
 *   3. Sanitizer edge cases — object/array/boolean Ollama output, tab char
 *   4. Fallback observability — warn-level log on each fallback path
 *   5. Unknown event type — route() must throw, not silently dispatch
 *   6. DEFAULT_CLASSIFICATION trust-matrix interaction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventRouter,
  sanitizeClassificationText,
  type RawEvent,
  type EventRouterConfig,
} from './event-router.js';
import { HealthMonitor } from './health-monitor.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import after vi.mock so we get the mocked version
import { logger } from './logger.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEmailEvent(id = 'e1'): RawEvent {
  return {
    type: 'email',
    id,
    timestamp: new Date().toISOString(),
    payload: {
      messageId: id,
      threadId: 't1',
      from: 'a@b.com',
      to: ['c@d.com'],
      cc: [],
      subject: 'test',
      snippet: 'hello',
      date: new Date().toISOString(),
      labels: ['INBOX'],
      hasAttachments: false,
    },
  };
}

function makeHealthMonitor() {
  return new HealthMonitor({
    maxSpawnsPerHour: 30,
    maxErrorsPerHour: 20,
    onAlert: vi.fn(),
  });
}

function makeRouter(
  hmOverride?: Partial<EventRouterConfig['healthMonitor']>,
  extra: Partial<EventRouterConfig> = {},
): EventRouter {
  const hm = {
    recordOllamaLatency: vi.fn(),
    isOllamaDegraded: vi.fn(() => false),
    ...hmOverride,
  };
  return new EventRouter({
    ollamaHost: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    trustRules: [],
    messageBus: { publish: vi.fn() },
    healthMonitor: hm as EventRouterConfig['healthMonitor'],
    ...extra,
  });
}

// Typed access to the mocked warn function
const warnMock = () => logger.warn as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────────
// 0. Probe failure MUST be logged at debug level (currently: silent → test FAILS)
// ─────────────────────────────────────────────────────────────────────────────
describe('HealthMonitor.tryProbeAndRecover — probe failure logging', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('emits a debug log when probe fetch throws (ECONNREFUSED)', async () => {
    const monitor = makeHealthMonitor();
    const failFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await monitor.tryProbeAndRecover('http://localhost:11434', Date.now(), failFetch);

    // A silent probe failure is invisible in production logs — operators
    // have no signal that the half-open check is consistently failing.
    // Expect at least a debug-level log with the error and host.
    const debugMock = logger.debug as ReturnType<typeof vi.fn>;
    expect(debugMock).toHaveBeenCalledWith(
      expect.objectContaining({ ollamaHost: 'http://localhost:11434' }),
      expect.stringMatching(/probe.*fail|fail.*probe/i),
    );
  });

  it('emits a debug log when probe returns non-ok status', async () => {
    const monitor = makeHealthMonitor();
    const nonOkFetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    await monitor.tryProbeAndRecover('http://localhost:11434', Date.now(), nonOkFetch);

    const debugMock = logger.debug as ReturnType<typeof vi.fn>;
    expect(debugMock).toHaveBeenCalledWith(
      expect.objectContaining({ ollamaHost: 'http://localhost:11434' }),
      expect.stringMatching(/probe.*fail|fail.*probe/i),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Probe cooldown: failed probe still consumes the cooldown slot
// ─────────────────────────────────────────────────────────────────────────────
describe('HealthMonitor.tryProbeAndRecover — cooldown after failure', () => {
  it('a failed probe sets lastProbeAt so the next probe within cooldown is skipped', async () => {
    const monitor = makeHealthMonitor();
    const failFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    const first = await monitor.tryProbeAndRecover('http://localhost:11434', t0, failFetch);
    expect(first).toBe(false);

    // Within cooldown (59 s later) — should skip without calling fetch again
    const secondFetch = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    const second = await monitor.tryProbeAndRecover(
      'http://localhost:11434',
      t0 + 59_000,
      secondFetch,
    );
    expect(second).toBe(false);
    expect(secondFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Probe with non-ok HTTP response does NOT record a recovery latency sample
// ─────────────────────────────────────────────────────────────────────────────
describe('HealthMonitor.tryProbeAndRecover — non-ok response', () => {
  it('returns false and does not add a latency sample when probe returns 503', async () => {
    const monitor = makeHealthMonitor();
    monitor.recordOllamaLatency(15_000);
    expect(monitor.isOllamaDegraded()).toBe(true);

    const nonOkFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch;
    const recovered = await monitor.tryProbeAndRecover(
      'http://localhost:11434',
      Date.now(),
      nonOkFetch,
    );

    expect(recovered).toBe(false);
    // Only the original 15_000ms sample should exist; no 50ms probe sample
    type LatencyEntry = { latencyMs: number };
    const log = (monitor as unknown as { ollamaLatencyLog: LatencyEntry[] }).ollamaLatencyLog;
    expect(log).toHaveLength(1);
    expect(log[0].latencyMs).toBe(15_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Probe succeeds but breaker is still degraded → fallback path taken
// ─────────────────────────────────────────────────────────────────────────────
describe('EventRouter route() — probe succeeds but still degraded → fallback', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses DEFAULT_CLASSIFICATION when probe returns true but isOllamaDegraded still true', async () => {
    // tryProbeAndRecover returns true (probe succeeded) but
    // isOllamaDegraded() stays true (not enough samples yet to close breaker).
    // route() checks recovered AND !isOllamaDegraded() — if still degraded
    // it must use fallback, not attempt to call Ollama for classification.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hm = {
      recordOllamaLatency: vi.fn(),
      isOllamaDegraded: vi.fn(() => true), // stays degraded after probe
      tryProbeAndRecover: vi.fn(async () => true), // probe "succeeds"
    };

    const router = makeRouter(hm);
    const result = await router.route(makeEmailEvent('e-still-degraded'));

    // Classification fetch should NOT have been called (fallback used)
    expect(fetchMock).not.toHaveBeenCalled();
    // DEFAULT_CLASSIFICATION has confidence 0
    expect(result.classification.confidence).toBe(0);
    // A warn-level log must be emitted so the fallback is observable
    expect(warnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e-still-degraded' }),
      expect.stringContaining('fallback'),
    );

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Breaker OPENING direction — exact sample counts
// ─────────────────────────────────────────────────────────────────────────────
describe('HealthMonitor isOllamaDegraded — opening direction', () => {
  it('stays healthy with only fast samples', () => {
    const monitor = makeHealthMonitor();
    for (let i = 0; i < 19; i++) monitor.recordOllamaLatency(100);
    expect(monitor.isOllamaDegraded()).toBe(false);
  });

  it('opens on a single slow sample (1 total: p95 idx=0 → 15_000 > 10_000)', () => {
    const monitor = makeHealthMonitor();
    monitor.recordOllamaLatency(15_000);
    expect(monitor.isOllamaDegraded()).toBe(true);
  });

  it('opens when 1 slow sample lands at p95 among 19 fast (20 total, idx=19)', () => {
    const monitor = makeHealthMonitor();
    for (let i = 0; i < 19; i++) monitor.recordOllamaLatency(100);
    monitor.recordOllamaLatency(15_000);
    // 20 samples: sorted[floor(20*0.95)] = sorted[19] = 15_000 > 10_000
    expect(monitor.isOllamaDegraded()).toBe(true);
  });

  it('stays healthy when slow sample no longer lands at p95 with 21 samples (20 fast + 1 slow)', () => {
    const monitor = makeHealthMonitor();
    for (let i = 0; i < 20; i++) monitor.recordOllamaLatency(100);
    monitor.recordOllamaLatency(15_000);
    // 21 samples: sorted[floor(21*0.95)] = sorted[19] = 100 (fast), not 15_000
    expect(monitor.isOllamaDegraded()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Sanitizer — non-string Ollama output
// ─────────────────────────────────────────────────────────────────────────────
describe('sanitizeClassificationText — non-string types', () => {
  it('returns empty string for object input', () => {
    expect(sanitizeClassificationText({} as unknown as string, 'topic')).toBe('');
  });

  it('returns empty string for array input', () => {
    expect(sanitizeClassificationText([] as unknown as string, 'summary')).toBe('');
  });

  it('returns empty string for boolean input', () => {
    expect(sanitizeClassificationText(true as unknown as string, 'topic')).toBe('');
  });
});

describe('EventRouter parseClassification — object/array Ollama fields', () => {
  it('falls back to "unknown" topic when Ollama returns object for topic field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            importance: 0.5,
            urgency: 0.5,
            topic: { nested: 'injection' }, // object, not string
            summary: 'normal',
            suggestedRouting: 'notify',
            requiresClaude: false,
            confidence: 0.7,
          }),
        }),
      }),
    );

    const router = makeRouter();
    const result = await router.route(makeEmailEvent('e-obj-topic'));
    expect(result.classification.topic).toBe('unknown');
    vi.unstubAllGlobals();
  });

  it('falls back to "No summary" when Ollama returns array for summary field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            importance: 0.5,
            urgency: 0.5,
            topic: 'legit-topic',
            summary: ['array', 'injection'], // array, not string
            suggestedRouting: 'notify',
            requiresClaude: false,
            confidence: 0.7,
          }),
        }),
      }),
    );

    const router = makeRouter();
    const result = await router.route(makeEmailEvent('e-arr-summary'));
    expect(result.classification.summary).toBe('No summary');
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Topic charset — tab character handling
// ─────────────────────────────────────────────────────────────────────────────
describe('sanitizeClassificationText topic — tab and control chars', () => {
  it('collapses embedded tab to a single space (\\t is \\s, passes charset, collapsed)', () => {
    const out = sanitizeClassificationText('grant\tfunding', 'topic');
    expect(out).not.toContain('\t');
    expect(out).toContain('grant');
    expect(out).toContain('funding');
  });

  it('strips vertical tab (\\x0B) — it is a control char removed before charset filter', () => {
    const out = sanitizeClassificationText('grant\x0Bfunding', 'topic');
    expect(out).not.toContain('\x0B');
    expect(out).toContain('grant');
    expect(out).toContain('funding');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Fallback observability — warn log must fire on each fallback path
// ─────────────────────────────────────────────────────────────────────────────
describe('EventRouter fallback observability', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('emits warn when Ollama is degraded and no probe configured', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const hm = {
      recordOllamaLatency: vi.fn(),
      isOllamaDegraded: vi.fn(() => true),
      // no tryProbeAndRecover
    };

    const router = makeRouter(hm);
    const result = await router.route(makeEmailEvent('e-obs'));

    expect(result.classification.confidence).toBe(0);
    expect(warnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e-obs' }),
      expect.stringContaining('fallback'),
    );
    vi.unstubAllGlobals();
  });

  it('emits warn when Ollama fetch throws (ECONNREFUSED)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const router = makeRouter();
    const result = await router.route(makeEmailEvent('e-throw'));

    expect(result.classification.confidence).toBe(0);
    expect(warnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e-throw' }),
      expect.stringContaining('fallback'),
    );
    vi.unstubAllGlobals();
  });

  it('emits warn when Ollama returns non-OK HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    const router = makeRouter();
    const result = await router.route(makeEmailEvent('e-503'));

    expect(result.classification.confidence).toBe(0);
    expect(warnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      expect.stringContaining('fallback'),
    );
    vi.unstubAllGlobals();
  });

  it('emits warn when Ollama returns no parseable JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'not json at all' }),
      }),
    );
    const router = makeRouter();
    await router.route(makeEmailEvent('e-nojson'));

    expect(warnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ raw: 'not json at all' }),
      expect.stringContaining('fallback'),
    );
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Unknown event type — route() must throw, not silently dispatch
// ─────────────────────────────────────────────────────────────────────────────
describe('EventRouter route() — unknown event type', () => {
  it('throws (does not silently swallow) when event.type is not a known value', async () => {
    const router = makeRouter();
    const badEvent = {
      type: 'unknown_source' as unknown as RawEvent['type'],
      id: 'bad-1',
      timestamp: new Date().toISOString(),
      payload: {},
    };

    await expect(router.route(badEvent)).rejects.toThrow(/unknown event type/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. DEFAULT_CLASSIFICATION trust-matrix interaction
// ─────────────────────────────────────────────────────────────────────────────
describe('EventRouter DEFAULT_CLASSIFICATION trust-matrix', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fallback (importance=0.5) does NOT reach escalate with importance_gte 0.85 rule', async () => {
    const escalateRule = {
      event_type: 'email' as const,
      conditions: { importance_gte: 0.85 },
      routing: 'escalate' as const,
    };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const router = makeRouter(undefined, { trustRules: [escalateRule] });
    const result = await router.route(makeEmailEvent('e-no-escalate'));

    expect(result.routing).toBe('notify'); // 0.5 < 0.85, rule doesn't match
    expect(result.classification.confidence).toBe(0);
    vi.unstubAllGlobals();
  });

  it('fallback (importance=0.5) DOES match importance_lt 0.6 rule → autonomous', async () => {
    const autoRule = {
      event_type: 'email' as const,
      conditions: { importance_lt: 0.6 },
      routing: 'autonomous' as const,
    };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const router = makeRouter(undefined, { trustRules: [autoRule] });
    const result = await router.route(makeEmailEvent('e-auto-fallback'));

    expect(result.routing).toBe('autonomous');
    vi.unstubAllGlobals();
  });
});
