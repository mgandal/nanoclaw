import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HealthMonitor,
  type HealthAlert,
  type FixHandler,
  type FixActions,
} from './health-monitor.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
  });

  it('tracks container spawns', () => {
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1);
  });

  it('alerts when spawn rate exceeds threshold', () => {
    for (let i = 0; i < 31; i++) {
      monitor.recordSpawn('main');
    }
    const alerts = monitor.checkThresholds();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({
      type: 'excessive_spawns',
      group: 'main',
    });
    expect(alertFn).toHaveBeenCalled();
  });

  it('tracks errors by group', () => {
    monitor.recordError('main', 'Container timeout');
    expect(monitor.getErrorCount('main', 3600_000)).toBe(1);
  });

  it('alerts when error rate exceeds threshold', () => {
    for (let i = 0; i < 21; i++) {
      monitor.recordError('main', 'fail');
    }
    const alerts = monitor.checkThresholds();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({
      type: 'excessive_errors',
      group: 'main',
    });
  });

  it('pauses and resumes groups', () => {
    monitor.pauseGroup('main', 'test');
    expect(monitor.isGroupPaused('main')).toBe(true);
    monitor.resumeGroup('main');
    expect(monitor.isGroupPaused('main')).toBe(false);
  });

  it('only counts events within the time window', () => {
    // Inject an old event directly
    monitor['spawnLog'].push({
      group: 'main',
      timestamp: Date.now() - 7200_000,
    });
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1);
  });

  it('returns status summary', () => {
    monitor.recordSpawn('main');
    monitor.recordError('main', 'test');
    const status = monitor.getStatus();
    expect(status['main']).toMatchObject({
      spawns_1h: 1,
      errors_1h: 1,
      paused: false,
    });
  });
});

describe('HealthMonitor infra alerts (consecutive failures)', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
  });

  it('does not alert on a single transient failure', () => {
    monitor.recordInfraEvent('mcp:QMD', 'MCP server QMD is unreachable');
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(0);
  });

  it('does not alert on two consecutive failures', () => {
    monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(0);
  });

  it('alerts after 3 consecutive failures', () => {
    for (let i = 0; i < 3; i++) {
      monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    }
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(1);
    expect(infraAlerts[0]).toMatchObject({
      type: 'infra_error',
      group: 'mcp:QMD',
    });
  });

  it('resets failure count on clearInfraEvent (success)', () => {
    monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    // A successful check clears the counter
    monitor.clearInfraEvent('mcp:QMD');
    // Next failure starts from 0 again
    monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(0);
  });

  it('clears alert when service recovers after threshold was reached', () => {
    for (let i = 0; i < 3; i++) {
      monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    }
    expect(
      monitor.checkThresholds().filter((a) => a.type === 'infra_error'),
    ).toHaveLength(1);
    // Service recovers
    monitor.clearInfraEvent('mcp:QMD');
    expect(
      monitor.checkThresholds().filter((a) => a.type === 'infra_error'),
    ).toHaveLength(0);
  });

  it('tracks multiple services independently', () => {
    for (let i = 0; i < 3; i++) {
      monitor.recordInfraEvent('mcp:QMD', 'unreachable');
    }
    monitor.recordInfraEvent('mcp:SimpleMem', 'unreachable'); // only 1 failure
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(1);
    expect(infraAlerts[0].group).toBe('mcp:QMD');
  });
});

describe('HealthMonitor alert dedup cooldown', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 5,
      maxErrorsPerHour: 5,
      onAlert: alertFn,
    });
  });

  it('suppresses duplicate spawn alerts within 10min cooldown', () => {
    // Trigger first alert
    for (let i = 0; i < 6; i++) monitor.recordSpawn('g1');
    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(1);

    // Second check within cooldown — alert still returned but onAlert NOT called again
    const alerts2 = monitor.checkThresholds();
    expect(alerts2.some((a) => a.type === 'excessive_spawns')).toBe(true);
    expect(alertFn).toHaveBeenCalledTimes(1); // still 1
  });

  it('suppresses duplicate error alerts within 10min cooldown', () => {
    for (let i = 0; i < 6; i++) monitor.recordError('g1', 'fail');
    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(1);

    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(1); // not called again
  });

  it('suppresses duplicate infra alerts within cooldown', () => {
    for (let i = 0; i < 3; i++) monitor.recordInfraEvent('mcp:X', 'down');
    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(1);

    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(1); // deduped
  });

  it('re-fires alert after cooldown expires', () => {
    for (let i = 0; i < 6; i++) monitor.recordSpawn('g1');
    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(1);

    // Simulate cooldown expiry by backdating the recentAlerts entry
    const recentAlerts = monitor['recentAlerts'] as Map<string, number>;
    recentAlerts.set('excessive_spawns:g1', Date.now() - 11 * 60_000);

    monitor.checkThresholds();
    expect(alertFn).toHaveBeenCalledTimes(2);
  });
});

describe('HealthMonitor auto-pause and auto-resume', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 5,
      maxErrorsPerHour: 5,
      onAlert: alertFn,
    });
  });

  it('auto-pauses group when spawn threshold exceeded', () => {
    for (let i = 0; i < 6; i++) monitor.recordSpawn('g1');
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(true);
  });

  it('auto-resumes group when spawns drop below threshold', () => {
    for (let i = 0; i < 6; i++) monitor.recordSpawn('g1');
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(true);

    // Clear spawn log to simulate events expiring
    monitor['spawnLog'] = [];
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(false);
  });

  it('auto-resumes multiple paused groups in single checkThresholds call', () => {
    // Pause two groups
    for (let i = 0; i < 6; i++) {
      monitor.recordSpawn('g1');
      monitor.recordSpawn('g2');
    }
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(true);
    expect(monitor.isGroupPaused('g2')).toBe(true);

    // Clear events so both should resume
    monitor['spawnLog'] = [];
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(false);
    expect(monitor.isGroupPaused('g2')).toBe(false);
  });

  it('does not resume group that still exceeds error threshold', () => {
    for (let i = 0; i < 6; i++) monitor.recordError('g1', 'fail');
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(true);

    // Errors still present, should stay paused
    monitor.checkThresholds();
    expect(monitor.isGroupPaused('g1')).toBe(true);
  });
});

describe('HealthMonitor concurrent and mixed scenarios', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 10,
      maxErrorsPerHour: 10,
      onAlert: alertFn,
    });
  });

  it('handles spawn and error thresholds independently per group', () => {
    // g1 exceeds spawns, g2 exceeds errors
    for (let i = 0; i < 11; i++) monitor.recordSpawn('g1');
    for (let i = 0; i < 11; i++) monitor.recordError('g2', 'fail');

    const alerts = monitor.checkThresholds();
    const spawnAlerts = alerts.filter((a) => a.type === 'excessive_spawns');
    const errorAlerts = alerts.filter((a) => a.type === 'excessive_errors');
    expect(spawnAlerts).toHaveLength(1);
    expect(spawnAlerts[0].group).toBe('g1');
    expect(errorAlerts).toHaveLength(1);
    expect(errorAlerts[0].group).toBe('g2');
    expect(monitor.isGroupPaused('g1')).toBe(true);
    expect(monitor.isGroupPaused('g2')).toBe(true);
  });

  it('getStatus reflects paused state correctly', () => {
    for (let i = 0; i < 11; i++) monitor.recordSpawn('g1');
    monitor.checkThresholds();

    const status = monitor.getStatus();
    expect(status['g1']).toMatchObject({ paused: true });
  });

  it('getStatus returns empty object when no events recorded', () => {
    const status = monitor.getStatus();
    expect(Object.keys(status)).toHaveLength(0);
  });

  it('infra failure count persists across threshold exactly at boundary', () => {
    // 2 failures — below threshold
    monitor.recordInfraEvent('svc', 'down');
    monitor.recordInfraEvent('svc', 'down');
    expect(monitor.checkThresholds().filter((a) => a.type === 'infra_error')).toHaveLength(0);

    // 3rd failure — hits threshold
    monitor.recordInfraEvent('svc', 'down');
    expect(monitor.checkThresholds().filter((a) => a.type === 'infra_error')).toHaveLength(1);

    // 4th failure — stays alerting (count > threshold)
    monitor.recordInfraEvent('svc', 'still down');
    expect(monitor.checkThresholds().filter((a) => a.type === 'infra_error')).toHaveLength(1);
  });
});

describe('HealthMonitor pruning and time window edge cases', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 100,
      maxErrorsPerHour: 100,
      onAlert: vi.fn(),
    });
  });

  it('prunes events older than 2 hours on recordSpawn', () => {
    // Inject old events
    monitor['spawnLog'] = [
      { group: 'g1', timestamp: Date.now() - 3 * 3600_000 },
      { group: 'g1', timestamp: Date.now() - 2.5 * 3600_000 },
    ];
    // Recording a new spawn triggers pruning
    monitor.recordSpawn('g1');
    expect(monitor['spawnLog']).toHaveLength(1);
    expect(monitor.getSpawnCount('g1', 3600_000)).toBe(1);
  });

  it('prunes error events older than 2 hours on recordError', () => {
    monitor['errorLog'] = [
      { group: 'g1', message: 'old', timestamp: Date.now() - 3 * 3600_000 },
    ];
    monitor.recordError('g1', 'new');
    expect(monitor['errorLog']).toHaveLength(1);
    expect(monitor.getErrorCount('g1', 3600_000)).toBe(1);
  });

  it('getSpawnCount with zero window returns 0', () => {
    monitor.recordSpawn('g1');
    expect(monitor.getSpawnCount('g1', 0)).toBe(0);
  });

  it('getErrorCount with zero window returns 0', () => {
    monitor.recordError('g1', 'x');
    expect(monitor.getErrorCount('g1', 0)).toBe(0);
  });
});

describe('HealthMonitor Ollama tracking', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: vi.fn(),
    });
  });

  it('records Ollama latency', () => {
    monitor.recordOllamaLatency(500);
    monitor.recordOllamaLatency(1000);
    expect(monitor.getOllamaP95Latency(3600_000)).toBeGreaterThan(0);
  });

  it('reports not degraded when latency is low', () => {
    for (let i = 0; i < 10; i++) monitor.recordOllamaLatency(200);
    expect(monitor.isOllamaDegraded()).toBe(false);
  });

  it('reports degraded when p95 exceeds threshold', () => {
    for (let i = 0; i < 19; i++) monitor.recordOllamaLatency(100);
    monitor.recordOllamaLatency(15000);
    expect(monitor.isOllamaDegraded()).toBe(true);
  });

  it('only considers latency within time window', () => {
    monitor['ollamaLatencyLog'].push({
      latencyMs: 15000,
      timestamp: Date.now() - 7200_000,
    });
    for (let i = 0; i < 10; i++) monitor.recordOllamaLatency(100);
    expect(monitor.isOllamaDegraded()).toBe(false);
  });

  it('returns 0 for P95 when no latency data exists', () => {
    expect(monitor.getOllamaP95Latency(3600_000)).toBe(0);
    expect(monitor.isOllamaDegraded()).toBe(false);
  });

  it('handles single latency entry correctly', () => {
    monitor.recordOllamaLatency(5000);
    const p95 = monitor.getOllamaP95Latency(3600_000);
    expect(p95).toBe(5000);
  });

  it('prunes old latency entries on record', () => {
    monitor['ollamaLatencyLog'] = [
      { latencyMs: 99999, timestamp: Date.now() - 3 * 3600_000 },
    ];
    monitor.recordOllamaLatency(100);
    expect(monitor['ollamaLatencyLog']).toHaveLength(1);
    expect(monitor['ollamaLatencyLog'][0].latencyMs).toBe(100);
  });
});

describe('HealthMonitor fix handlers', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
  });

  it('registers and retrieves fix handlers', () => {
    const handler: FixHandler = {
      id: 'mcp-simplemem',
      service: 'mcp:SimpleMem',
      fixScript: '/path/to/restart-simplemem.sh',
      verify: {
        type: 'http',
        url: 'http://localhost:8200/api/health',
        expectStatus: 200,
      },
      cooldownMs: 120_000,
      maxAttempts: 2,
    };
    monitor.addFixHandler(handler);
    expect(monitor.getFixHandler('mcp:SimpleMem')).toBe(handler);
  });

  it('returns undefined for unknown service', () => {
    expect(monitor.getFixHandler('mcp:Unknown')).toBeUndefined();
  });

  describe('attemptFix', () => {
    const mockActions: FixActions = {
      execScript: vi
        .fn()
        .mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
      httpCheck: vi
        .fn()
        .mockResolvedValue({ reachable: true, statusCode: 200 }),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      (mockActions.execScript as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        stdout: '',
        stderr: '',
      });
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        reachable: true,
        statusCode: 200,
      });
      (mockActions.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue(
        true,
      );
      monitor.setFixActions(mockActions);
    });

    it('executes fix script and verifies success', async () => {
      const handler: FixHandler = {
        id: 'mcp-simplemem',
        service: 'mcp:SimpleMem',
        fixScript: '/scripts/fixes/restart-simplemem.sh',
        verify: {
          type: 'http',
          url: 'http://localhost:8200/api/health',
          expectStatus: 200,
        },
        cooldownMs: 120_000,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      const result = await monitor.attemptFix('mcp:SimpleMem');
      expect(result).toBe('fixed');
      expect(mockActions.execScript).toHaveBeenCalledWith(
        '/scripts/fixes/restart-simplemem.sh',
        undefined,
      );
      expect(mockActions.httpCheck).toHaveBeenCalledWith(
        'http://localhost:8200/api/health',
      );
      expect(mockActions.acquireLock).toHaveBeenCalled();
      expect(mockActions.releaseLock).toHaveBeenCalled();
    });

    it('skips fix during cooldown period', async () => {
      const handler: FixHandler = {
        id: 'test-service',
        service: 'mcp:Test',
        fixScript: '/scripts/fixes/test.sh',
        verify: {
          type: 'http',
          url: 'http://localhost:9999',
          expectStatus: 200,
        },
        cooldownMs: 120_000,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      // First attempt succeeds
      await monitor.attemptFix('mcp:Test');
      // Second attempt within cooldown should be skipped
      const result = await monitor.attemptFix('mcp:Test');
      expect(result).toBe('cooldown');
      expect(mockActions.execScript).toHaveBeenCalledTimes(1);
    });

    it('escalates after maxAttempts failures', async () => {
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        reachable: false,
        statusCode: undefined,
      });
      const handler: FixHandler = {
        id: 'fail-service',
        service: 'mcp:Failing',
        fixScript: '/scripts/fixes/fail.sh',
        verify: {
          type: 'http',
          url: 'http://localhost:9999',
          expectStatus: 200,
        },
        cooldownMs: 0, // no cooldown for test
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      await monitor.attemptFix('mcp:Failing');
      const result = await monitor.attemptFix('mcp:Failing');
      expect(result).toBe('escalated');
      expect(alertFn).toHaveBeenCalled();
      const call = (alertFn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[0] as HealthAlert).type === 'fix_escalation',
      );
      expect(call).toBeDefined();
    });

    it('skips fix if lock cannot be acquired', async () => {
      (mockActions.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue(
        false,
      );
      const handler: FixHandler = {
        id: 'locked',
        service: 'mcp:Locked',
        fixScript: '/scripts/fixes/test.sh',
        verify: {
          type: 'http',
          url: 'http://localhost:9999',
          expectStatus: 200,
        },
        cooldownMs: 0,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      const result = await monitor.attemptFix('mcp:Locked');
      expect(result).toBe('locked');
      expect(mockActions.execScript).not.toHaveBeenCalled();
    });

    it('returns no-handler for unknown services', async () => {
      const result = await monitor.attemptFix('mcp:Unknown');
      expect(result).toBe('no-handler');
    });

    it('resets attempt count after successful fix', async () => {
      const handler: FixHandler = {
        id: 'reset-test',
        service: 'mcp:Reset',
        fixScript: '/scripts/fixes/test.sh',
        verify: {
          type: 'http',
          url: 'http://localhost:9999',
          expectStatus: 200,
        },
        cooldownMs: 0,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      // Fail once
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        { reachable: false },
      );
      await monitor.attemptFix('mcp:Reset');

      // Succeed
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        { reachable: true, statusCode: 200 },
      );
      await monitor.attemptFix('mcp:Reset');

      // Fail again — should NOT escalate (count was reset)
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        reachable: false,
      });
      const result = await monitor.attemptFix('mcp:Reset');
      expect(result).toBe('verify-failed');
    });
  });
});

describe('HealthMonitor fix integration', () => {
  let monitor: HealthMonitor;
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);
  let mockActions: FixActions;

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
    mockActions = {
      execScript: vi
        .fn()
        .mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
      httpCheck: vi
        .fn()
        .mockResolvedValue({ reachable: true, statusCode: 200 }),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    monitor.setFixActions(mockActions);
  });

  it('full cycle: detect → fix → verify → clear', async () => {
    monitor.addFixHandler({
      id: 'mcp-test',
      service: 'mcp:Test',
      fixScript: '/test/fix.sh',
      verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
      cooldownMs: 0,
      maxAttempts: 2,
    });

    // Simulate 3 consecutive failures
    monitor.recordInfraEvent('mcp:Test', 'unreachable');
    monitor.recordInfraEvent('mcp:Test', 'unreachable');
    monitor.recordInfraEvent('mcp:Test', 'unreachable');

    // Threshold reached
    expect(monitor.getInfraFailureCount('mcp:Test')).toBe(3);

    // Auto-fix
    const result = await monitor.attemptFix('mcp:Test');
    expect(result).toBe('fixed');

    // Infra event should be cleared
    expect(monitor.getInfraFailureCount('mcp:Test')).toBe(0);

    // No infra alerts should show
    const alerts = monitor.checkThresholds();
    const infraAlerts = alerts.filter((a) => a.type === 'infra_error');
    expect(infraAlerts).toHaveLength(0);
  });

  it('full cycle: detect → fail fix x2 → escalate', async () => {
    (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      reachable: false,
    });

    monitor.addFixHandler({
      id: 'mcp-fail',
      service: 'mcp:Fail',
      fixScript: '/test/fail.sh',
      verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
      cooldownMs: 0,
      maxAttempts: 2,
    });

    // Simulate failures
    for (let i = 0; i < 3; i++) {
      monitor.recordInfraEvent('mcp:Fail', 'unreachable');
    }

    // First fix attempt — verify fails
    const r1 = await monitor.attemptFix('mcp:Fail');
    expect(r1).toBe('verify-failed');

    // Second fix attempt — escalates
    const r2 = await monitor.attemptFix('mcp:Fail');
    expect(r2).toBe('escalated');

    // Alert was sent
    const escalationCalls = (
      alertFn as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      (c: unknown[]) => (c[0] as HealthAlert).type === 'fix_escalation',
    );
    expect(escalationCalls).toHaveLength(1);
    expect(escalationCalls[0][0].group).toBe('mcp:Fail');
  });

  it('verify with command type', async () => {
    (mockActions.execScript as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' }) // fix script
      .mockResolvedValueOnce({ ok: true, stdout: '1', stderr: '' }); // verify command

    monitor.addFixHandler({
      id: 'cmd-verify',
      service: 'test:cmd',
      fixScript: '/test/fix.sh',
      verify: { type: 'command', cmd: '/bin/echo', args: ['ok'] },
      cooldownMs: 0,
      maxAttempts: 2,
    });

    const result = await monitor.attemptFix('test:cmd');
    expect(result).toBe('fixed');
    expect(mockActions.execScript).toHaveBeenCalledTimes(2);
  });
});
