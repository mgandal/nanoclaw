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
      execScript: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
      httpCheck: vi.fn().mockResolvedValue({ reachable: true, statusCode: 200 }),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      (mockActions.execScript as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, stdout: '', stderr: '' });
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: true, statusCode: 200 });
      (mockActions.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      monitor.setFixActions(mockActions);
    });

    it('executes fix script and verifies success', async () => {
      const handler: FixHandler = {
        id: 'mcp-simplemem',
        service: 'mcp:SimpleMem',
        fixScript: '/scripts/fixes/restart-simplemem.sh',
        verify: { type: 'http', url: 'http://localhost:8200/api/health', expectStatus: 200 },
        cooldownMs: 120_000,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      const result = await monitor.attemptFix('mcp:SimpleMem');
      expect(result).toBe('fixed');
      expect(mockActions.execScript).toHaveBeenCalledWith('/scripts/fixes/restart-simplemem.sh', undefined);
      expect(mockActions.httpCheck).toHaveBeenCalledWith('http://localhost:8200/api/health');
      expect(mockActions.acquireLock).toHaveBeenCalled();
      expect(mockActions.releaseLock).toHaveBeenCalled();
    });

    it('skips fix during cooldown period', async () => {
      const handler: FixHandler = {
        id: 'test-service',
        service: 'mcp:Test',
        fixScript: '/scripts/fixes/test.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
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
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: false, statusCode: undefined });
      const handler: FixHandler = {
        id: 'fail-service',
        service: 'mcp:Failing',
        fixScript: '/scripts/fixes/fail.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
        cooldownMs: 0, // no cooldown for test
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      await monitor.attemptFix('mcp:Failing');
      const result = await monitor.attemptFix('mcp:Failing');
      expect(result).toBe('escalated');
      expect(alertFn).toHaveBeenCalled();
      const call = (alertFn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: [HealthAlert]) => c[0].type === 'fix_escalation',
      );
      expect(call).toBeDefined();
    });

    it('skips fix if lock cannot be acquired', async () => {
      (mockActions.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const handler: FixHandler = {
        id: 'locked',
        service: 'mcp:Locked',
        fixScript: '/scripts/fixes/test.sh',
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
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
        verify: { type: 'http', url: 'http://localhost:9999', expectStatus: 200 },
        cooldownMs: 0,
        maxAttempts: 2,
      };
      monitor.addFixHandler(handler);

      // Fail once
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ reachable: false });
      await monitor.attemptFix('mcp:Reset');

      // Succeed
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ reachable: true, statusCode: 200 });
      await monitor.attemptFix('mcp:Reset');

      // Fail again — should NOT escalate (count was reset)
      (mockActions.httpCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ reachable: false });
      const result = await monitor.attemptFix('mcp:Reset');
      expect(result).toBe('verify-failed');
    });
  });
});
