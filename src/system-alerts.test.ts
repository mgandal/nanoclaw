import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendAlert,
  cleanupAlerts,
  getUnresolvedAlerts,
  resolveAlert,
  type SystemAlert,
} from './system-alerts.js';

const TEST_DIR = path.join(import.meta.dirname, '..', 'data', 'test-alerts');
const ALERTS_FILE = path.join(TEST_DIR, 'system-alerts.json');

describe('system-alerts', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
  });

  afterEach(() => {
    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('appends an alert and reads it back', () => {
    appendAlert(
      {
        timestamp: new Date().toISOString(),
        service: 'gmail',
        message: 'OAuth token expired (invalid_grant)',
        fixInstructions: 'Re-authorize Gmail OAuth',
      },
      ALERTS_FILE,
    );

    const alerts = getUnresolvedAlerts(ALERTS_FILE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].service).toBe('gmail');
    expect(alerts[0].resolved).toBeFalsy();
  });

  it('resolves an alert by id', () => {
    appendAlert(
      {
        timestamp: new Date().toISOString(),
        service: 'mcp:QMD',
        message: 'Unreachable at startup',
      },
      ALERTS_FILE,
    );

    const before = getUnresolvedAlerts(ALERTS_FILE);
    expect(before).toHaveLength(1);

    resolveAlert(before[0].id, ALERTS_FILE);

    const after = getUnresolvedAlerts(ALERTS_FILE);
    expect(after).toHaveLength(0);
  });

  it('cleans up alerts older than 24h', () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const recent = new Date().toISOString();

    appendAlert(
      { timestamp: old, service: 'gmail', message: 'old alert' },
      ALERTS_FILE,
    );
    appendAlert(
      { timestamp: recent, service: 'gmail', message: 'new alert' },
      ALERTS_FILE,
    );

    cleanupAlerts(ALERTS_FILE);

    const all = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')) as SystemAlert[];
    expect(all).toHaveLength(1);
    expect(all[0].message).toBe('new alert');
  });

  it('handles missing file gracefully', () => {
    const alerts = getUnresolvedAlerts(ALERTS_FILE);
    expect(alerts).toEqual([]);
  });
});
