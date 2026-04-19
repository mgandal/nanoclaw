import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  checkTrust,
  checkTrustAndStage,
  type TrustDecision,
} from './trust-enforcement.js';
import { _initTestDatabase, _getTestDb } from './db.js';

describe('checkTrust', () => {
  it('returns allow for autonomous actions', () => {
    const trust = { actions: { send_message: 'autonomous' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_message',
      trust,
    );
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('autonomous');
    expect(result.notify).toBe(false);
  });

  it('returns allow + notify for notify actions', () => {
    const trust = { actions: { send_message: 'notify' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_message',
      trust,
    );
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('notify');
    expect(result.notify).toBe(true);
  });

  it('returns stage=true for ask actions (not silent drop)', () => {
    const trust = { actions: { schedule_meeting: 'ask' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'schedule_meeting',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
    expect(result.level).toBe('ask');
  });

  it('returns stage=true for draft actions', () => {
    const trust = { actions: { send_email: 'draft' } };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_email',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
    expect(result.level).toBe('draft');
  });

  it('defaults unknown actions to ask (stage, not silent drop)', () => {
    const trust = { actions: {} };
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'unknown_action',
      trust,
    );
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
    expect(result.level).toBe('ask');
  });

  it('returns allow for null trust (no trust file = legacy mode)', () => {
    const result = checkTrust(
      'einstein',
      'telegram_science-claw',
      'send_message',
      null,
    );
    expect(result.allowed).toBe(true);
    expect(result.level).toBe('autonomous');
    expect(result.stage).toBe(false);
  });

  it('autonomous and notify both have stage=false (execute immediately)', () => {
    const a = checkTrust('x', 'g', 'a', { actions: { a: 'autonomous' } });
    const n = checkTrust('x', 'g', 'a', { actions: { a: 'notify' } });
    expect(a.stage).toBe(false);
    expect(n.stage).toBe(false);
  });

  it('invalid level string also stages (fail-safe)', () => {
    const trust = { actions: { x: 'unrecognized_level_xyz' } };
    const result = checkTrust('einstein', 'g', 'x', trust);
    expect(result.allowed).toBe(false);
    expect(result.stage).toBe(true);
  });
});

describe('checkTrustAndStage', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const baseInput = {
    agentName: 'claire',
    groupFolder: 'telegram_claire',
    actionType: 'publish_to_bus',
    summary: 'test summary',
    payloadForStaging: { foo: 'bar' },
  };

  it('returns allowed=true and no pendingId when trust is null (legacy)', () => {
    const result = checkTrustAndStage({ ...baseInput, trust: null });
    expect(result).toEqual({
      allowed: true,
      level: 'autonomous',
      notify: false,
      pendingId: null,
    });
  });

  it('returns allowed=true, notify=true for notify level, no pendingId', () => {
    const result = checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'notify' } },
    });
    expect(result.allowed).toBe(true);
    expect(result.notify).toBe(true);
    expect(result.level).toBe('notify');
    expect(result.pendingId).toBeNull();
  });

  it('returns allowed=true, notify=false for autonomous level', () => {
    const result = checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'autonomous' } },
    });
    expect(result.allowed).toBe(true);
    expect(result.notify).toBe(false);
    expect(result.pendingId).toBeNull();
  });

  it('stages on draft, returns pendingId, writes pending_actions row', () => {
    const result = checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'draft' } },
    });
    expect(result.allowed).toBe(false);
    expect(result.level).toBe('draft');
    expect(result.pendingId).toMatch(/^pa-\d+-[a-z0-9]+$/);

    const db = _getTestDb();
    const row = db
      .prepare('SELECT * FROM pending_actions WHERE id = ?')
      .get(result.pendingId) as {
      action_type: string;
      agent_name: string;
      summary: string;
      payload_json: string;
    };
    expect(row).toBeDefined();
    expect(row.action_type).toBe('publish_to_bus');
    expect(row.agent_name).toBe('claire');
    expect(JSON.parse(row.payload_json)).toEqual({ foo: 'bar' });
  });

  it('stages on ask', () => {
    const result = checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'ask' } },
    });
    expect(result.allowed).toBe(false);
    expect(result.pendingId).toMatch(/^pa-/);
  });

  it('stages on unknown level (fail-safe)', () => {
    const result = checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'nonsense' } },
    });
    expect(result.allowed).toBe(false);
    expect(result.pendingId).toMatch(/^pa-/);
  });

  it('always writes an agent_actions audit row with correct outcome', () => {
    const db = _getTestDb();

    checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'autonomous' } },
    });
    checkTrustAndStage({
      ...baseInput,
      trust: { actions: { publish_to_bus: 'draft' } },
    });

    const rows = db
      .prepare('SELECT outcome FROM agent_actions ORDER BY created_at')
      .all() as { outcome: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe('allowed');
    expect(rows[1].outcome).toBe('staged');
  });

  it('truncates summary to 200 chars in the audit log', () => {
    const db = _getTestDb();
    const longSummary = 'x'.repeat(500);

    checkTrustAndStage({
      ...baseInput,
      summary: longSummary,
      trust: { actions: { publish_to_bus: 'autonomous' } },
    });

    const row = db
      .prepare('SELECT summary FROM agent_actions LIMIT 1')
      .get() as { summary: string };
    expect(row.summary).toHaveLength(200);
  });
});
