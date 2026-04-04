/**
 * System Health Monitor for NanoClaw
 *
 * Deterministic monitoring (no LLM calls). Tracks:
 * - Container spawn rates per group (detects runaway tasks)
 * - Error rates per group (detects degraded performance)
 *
 * Alerts via callback. In-memory only (resets on restart — acceptable
 * since the 2-hour sliding window means most state rebuilds quickly).
 */
import { logger } from './logger.js';

interface SpawnEvent {
  group: string;
  timestamp: number;
}

interface ErrorEvent {
  group: string;
  message: string;
  timestamp: number;
}

export interface HealthAlert {
  type: 'excessive_spawns' | 'excessive_errors' | 'infra_error' | 'fix_escalation';
  group: string;
  detail: string;
  timestamp: number;
}

export interface HealthMonitorConfig {
  maxSpawnsPerHour: number;
  maxErrorsPerHour: number;
  onAlert: (alert: HealthAlert) => void;
}

export interface FixVerify {
  type: 'http' | 'command';
  url?: string; // for type: 'http'
  expectStatus?: number; // for type: 'http' (default: 200)
  cmd?: string; // for type: 'command' — path to script
  args?: string[]; // for type: 'command'
}

export interface FixHandler {
  id: string;
  service: string; // matches the service key used in recordInfraEvent
  fixScript: string; // absolute path to fix script
  fixArgs?: string[]; // optional args for fix script
  verify: FixVerify;
  cooldownMs: number;
  maxAttempts: number;
}

export type FixResult = 'fixed' | 'verify-failed' | 'escalated' | 'cooldown' | 'locked' | 'no-handler' | 'script-failed';

export interface FixActions {
  execScript: (script: string, args?: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  httpCheck: (url: string) => Promise<{ reachable: boolean; statusCode?: number }>;
  acquireLock: (action: string) => Promise<boolean>;
  releaseLock: () => Promise<void>;
}

export class HealthMonitor {
  private spawnLog: SpawnEvent[] = [];
  private errorLog: ErrorEvent[] = [];
  private config: HealthMonitorConfig;
  private pausedGroups: Set<string> = new Set();
  private recentAlerts: Map<string, number> = new Map(); // dedup: key → timestamp
  private ollamaLatencyLog: Array<{ latencyMs: number; timestamp: number }> =
    [];
  private infraAlerts: Map<string, string> = new Map(); // service → message
  private infraFailureCounts: Map<string, number> = new Map(); // service → consecutive failures
  private static readonly INFRA_FAILURE_THRESHOLD = 3; // consecutive failures before alerting
  private fixHandlers: Map<string, FixHandler> = new Map();
  private fixActions?: FixActions;
  private fixAttemptCounts: Map<string, number> = new Map();
  private fixLastAttempt: Map<string, number> = new Map();

  constructor(config: HealthMonitorConfig) {
    this.config = config;
  }

  addFixHandler(handler: FixHandler): void {
    this.fixHandlers.set(handler.service, handler);
  }

  getFixHandler(service: string): FixHandler | undefined {
    return this.fixHandlers.get(service);
  }

  setFixActions(actions: FixActions): void {
    this.fixActions = actions;
  }

  getInfraFailureCount(service: string): number {
    return this.infraFailureCounts.get(service) ?? 0;
  }

  async attemptFix(service: string): Promise<FixResult> {
    const handler = this.fixHandlers.get(service);
    if (!handler) return 'no-handler';
    if (!this.fixActions) return 'no-handler';

    // Cooldown check
    const lastAttempt = this.fixLastAttempt.get(service) ?? 0;
    if (Date.now() - lastAttempt < handler.cooldownMs) return 'cooldown';

    // Max attempts check — escalate if exceeded
    const attempts = this.fixAttemptCounts.get(service) ?? 0;
    if (attempts >= handler.maxAttempts) {
      this.config.onAlert({
        type: 'fix_escalation',
        group: service,
        detail: `Auto-fix failed after ${attempts} attempts for ${handler.id}`,
        timestamp: Date.now(),
      });
      this.fixAttemptCounts.set(service, 0);
      this.fixLastAttempt.set(service, Date.now());
      return 'escalated';
    }

    // Acquire lock
    const locked = await this.fixActions.acquireLock(handler.id);
    if (!locked) return 'locked';

    try {
      this.fixLastAttempt.set(service, Date.now());
      logger.info({ service, handler: handler.id }, 'watchdog: attempting fix');

      // Execute fix script
      const execResult = await this.fixActions.execScript(handler.fixScript, handler.fixArgs);
      if (!execResult.ok) {
        this.fixAttemptCounts.set(service, attempts + 1);
        logger.warn({ service, stderr: execResult.stderr }, 'watchdog: fix script failed');
        return 'script-failed';
      }

      // Verify
      const verified = await this.verifyFix(handler.verify);
      if (verified) {
        this.fixAttemptCounts.set(service, 0);
        this.clearInfraEvent(service);
        logger.info({ service, handler: handler.id }, 'watchdog: fix verified');
        return 'fixed';
      }

      const newAttempts = attempts + 1;
      this.fixAttemptCounts.set(service, newAttempts);

      if (newAttempts >= handler.maxAttempts) {
        this.config.onAlert({
          type: 'fix_escalation',
          group: service,
          detail: `Auto-fix failed after ${newAttempts} attempts for ${handler.id}`,
          timestamp: Date.now(),
        });
        this.fixAttemptCounts.set(service, 0);
        logger.warn({ service, handler: handler.id }, 'watchdog: fix escalated after max attempts');
        return 'escalated';
      }

      logger.warn({ service, handler: handler.id }, 'watchdog: fix verification failed');
      return 'verify-failed';
    } finally {
      await this.fixActions.releaseLock();
    }
  }

  private async verifyFix(verify: FixVerify): Promise<boolean> {
    if (!this.fixActions) return false;

    if (verify.type === 'http' && verify.url) {
      const result = await this.fixActions.httpCheck(verify.url);
      const expectedStatus = verify.expectStatus ?? 200;
      return result.reachable && result.statusCode === expectedStatus;
    }

    if (verify.type === 'command' && verify.cmd) {
      const result = await this.fixActions.execScript(verify.cmd, verify.args);
      return result.ok;
    }

    return false;
  }

  recordSpawn(group: string): void {
    this.spawnLog.push({ group, timestamp: Date.now() });
    this.pruneOldEvents();
  }

  recordError(group: string, message: string): void {
    this.errorLog.push({ group, message, timestamp: Date.now() });
    this.pruneOldEvents();
  }

  recordInfraEvent(service: string, message: string): void {
    const count = (this.infraFailureCounts.get(service) ?? 0) + 1;
    this.infraFailureCounts.set(service, count);
    if (count >= HealthMonitor.INFRA_FAILURE_THRESHOLD) {
      this.infraAlerts.set(service, message);
    }
  }

  clearInfraEvent(service: string): void {
    this.infraFailureCounts.delete(service);
    this.infraAlerts.delete(service);
  }

  getSpawnCount(group: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.spawnLog.filter(
      (e) => e.group === group && e.timestamp > cutoff,
    ).length;
  }

  getErrorCount(group: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.errorLog.filter(
      (e) => e.group === group && e.timestamp > cutoff,
    ).length;
  }

  isGroupPaused(group: string): boolean {
    return this.pausedGroups.has(group);
  }

  pauseGroup(group: string, reason: string): void {
    this.pausedGroups.add(group);
    logger.warn({ group, reason }, 'Group paused by health monitor');
  }

  resumeGroup(group: string): void {
    this.pausedGroups.delete(group);
    logger.info({ group }, 'Group resumed');
  }

  checkThresholds(): HealthAlert[] {
    const alerts: HealthAlert[] = [];
    const windowMs = 3600_000;
    const alertCooldownMs = 10 * 60_000; // suppress duplicate alerts for 10 min
    const now = Date.now();

    const spawnGroups = new Set(this.spawnLog.map((e) => e.group));
    for (const group of spawnGroups) {
      const count = this.getSpawnCount(group, windowMs);
      if (count > this.config.maxSpawnsPerHour) {
        const alertKey = `excessive_spawns:${group}`;
        const lastAlerted = this.recentAlerts.get(alertKey) ?? 0;
        const alert: HealthAlert = {
          type: 'excessive_spawns',
          group,
          detail: `${count} container spawns in the last hour (threshold: ${this.config.maxSpawnsPerHour})`,
          timestamp: now,
        };
        alerts.push(alert);
        this.pauseGroup(group, alert.detail);
        if (now - lastAlerted > alertCooldownMs) {
          this.recentAlerts.set(alertKey, now);
          this.config.onAlert(alert);
        }
      } else if (this.isGroupPaused(group)) {
        this.resumeGroup(group);
      }
    }

    const errorGroups = new Set(this.errorLog.map((e) => e.group));
    for (const group of errorGroups) {
      const count = this.getErrorCount(group, windowMs);
      if (count > this.config.maxErrorsPerHour) {
        const alertKey = `excessive_errors:${group}`;
        const lastAlerted = this.recentAlerts.get(alertKey) ?? 0;
        const alert: HealthAlert = {
          type: 'excessive_errors',
          group,
          detail: `${count} errors in the last hour (threshold: ${this.config.maxErrorsPerHour})`,
          timestamp: now,
        };
        alerts.push(alert);
        this.pauseGroup(group, alert.detail);
        if (now - lastAlerted > alertCooldownMs) {
          this.recentAlerts.set(alertKey, now);
          this.config.onAlert(alert);
        }
      } else if (this.isGroupPaused(group)) {
        this.resumeGroup(group);
      }
    }

    // Auto-resume paused groups whose counts have fallen below threshold
    // (covers groups that no longer appear in the log after pruning)
    for (const group of this.pausedGroups) {
      const spawns = this.getSpawnCount(group, windowMs);
      const errors = this.getErrorCount(group, windowMs);
      if (
        spawns <= this.config.maxSpawnsPerHour &&
        errors <= this.config.maxErrorsPerHour
      ) {
        this.resumeGroup(group);
      }
    }

    // Infrastructure alerts
    for (const [service, message] of this.infraAlerts) {
      const alertKey = `infra_error:${service}`;
      const lastAlerted = this.recentAlerts.get(alertKey) ?? 0;
      const alert: HealthAlert = {
        type: 'infra_error',
        group: service,
        detail: message,
        timestamp: now,
      };
      alerts.push(alert);
      if (now - lastAlerted > alertCooldownMs) {
        this.recentAlerts.set(alertKey, now);
        this.config.onAlert(alert);
      }
    }

    return alerts;
  }

  private pruneOldEvents(): void {
    const cutoff = Date.now() - 2 * 3600_000;
    this.spawnLog = this.spawnLog.filter((e) => e.timestamp > cutoff);
    this.errorLog = this.errorLog.filter((e) => e.timestamp > cutoff);
  }

  recordOllamaLatency(latencyMs: number): void {
    this.ollamaLatencyLog.push({ latencyMs, timestamp: Date.now() });
    const cutoff = Date.now() - 2 * 3600_000;
    this.ollamaLatencyLog = this.ollamaLatencyLog.filter(
      (e) => e.timestamp > cutoff,
    );
  }

  getOllamaP95Latency(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const recent = this.ollamaLatencyLog
      .filter((e) => e.timestamp > cutoff)
      .map((e) => e.latencyMs)
      .sort((a, b) => a - b);
    if (recent.length === 0) return 0;
    const idx = Math.floor(recent.length * 0.95);
    return recent[Math.min(idx, recent.length - 1)];
  }

  isOllamaDegraded(): boolean {
    return this.getOllamaP95Latency(3600_000) > 10_000;
  }

  getStatus(): Record<string, unknown> {
    const groups = new Set([
      ...this.spawnLog.map((e) => e.group),
      ...this.errorLog.map((e) => e.group),
    ]);
    const status: Record<string, unknown> = {};
    for (const group of groups) {
      status[group] = {
        spawns_1h: this.getSpawnCount(group, 3600_000),
        errors_1h: this.getErrorCount(group, 3600_000),
        paused: this.pausedGroups.has(group),
      };
    }
    return status;
  }
}
