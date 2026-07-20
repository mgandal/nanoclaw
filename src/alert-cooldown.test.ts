import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, beforeEach, afterEach, it } from 'vitest';
import {
  shouldDeliverAlert,
  resetAlertCooldowns,
  initAlertCooldownPersistence,
  ALERT_COOLDOWN_MS,
} from './alert-cooldown.js';

describe('shouldDeliverAlert', () => {
  beforeEach(() => {
    resetAlertCooldowns();
  });

  it('delivers the first alert for a key', () => {
    const verdict = shouldDeliverAlert('Credential Proxy:401', 1000);
    expect(verdict).toEqual({ send: true, suppressedCount: 0 });
  });

  it('suppresses repeats within the cooldown window', () => {
    shouldDeliverAlert('k', 1000);
    expect(shouldDeliverAlert('k', 2000)).toEqual({
      send: false,
      suppressedCount: 1,
    });
    expect(shouldDeliverAlert('k', 3000)).toEqual({
      send: false,
      suppressedCount: 2,
    });
  });

  it('delivers again after the window and reports suppressed count', () => {
    shouldDeliverAlert('k', 1000);
    shouldDeliverAlert('k', 2000);
    shouldDeliverAlert('k', 3000);
    const verdict = shouldDeliverAlert('k', 1000 + ALERT_COOLDOWN_MS);
    expect(verdict).toEqual({ send: true, suppressedCount: 2 });
    // and the counter reset: an immediate repeat is suppressed with count 1
    expect(shouldDeliverAlert('k', 1001 + ALERT_COOLDOWN_MS)).toEqual({
      send: false,
      suppressedCount: 1,
    });
  });

  it('tracks keys independently', () => {
    shouldDeliverAlert('a', 1000);
    expect(shouldDeliverAlert('b', 1000)).toEqual({
      send: true,
      suppressedCount: 0,
    });
    expect(shouldDeliverAlert('a', 2000).send).toBe(false);
  });

  it('resetAlertCooldowns clears state', () => {
    shouldDeliverAlert('k', 1000);
    resetAlertCooldowns();
    expect(shouldDeliverAlert('k', 1001)).toEqual({
      send: true,
      suppressedCount: 0,
    });
  });

  describe('persistence across restarts', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-alertcd-'));
      file = path.join(dir, 'alert-cooldowns.json');
    });

    afterEach(() => {
      resetAlertCooldowns();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('suppresses a repeat after a simulated restart within the window', () => {
      initAlertCooldownPersistence(file);
      expect(shouldDeliverAlert('k', 1000).send).toBe(true);

      // Simulated restart: fresh in-memory state, same file
      initAlertCooldownPersistence(file);
      expect(shouldDeliverAlert('k', 2000)).toEqual({
        send: false,
        suppressedCount: 1,
      });
    });

    it('delivers after a restart once the window has passed', () => {
      initAlertCooldownPersistence(file);
      shouldDeliverAlert('k', 1000);

      initAlertCooldownPersistence(file);
      expect(shouldDeliverAlert('k', 1000 + ALERT_COOLDOWN_MS).send).toBe(true);
    });

    it('round-trips multiple keys independently', () => {
      initAlertCooldownPersistence(file);
      shouldDeliverAlert('a', 1000);
      shouldDeliverAlert('b', 2000);

      initAlertCooldownPersistence(file);
      expect(shouldDeliverAlert('a', 3000).send).toBe(false);
      expect(shouldDeliverAlert('b', 3000).send).toBe(false);
      expect(shouldDeliverAlert('c', 3000).send).toBe(true);
    });

    it('survives a corrupted state file without throwing', () => {
      fs.writeFileSync(file, '{not json');
      initAlertCooldownPersistence(file);
      expect(shouldDeliverAlert('k', 1000).send).toBe(true);
    });

    it('works when the state file does not exist yet', () => {
      initAlertCooldownPersistence(path.join(dir, 'missing', 'state.json'));
      expect(shouldDeliverAlert('k', 1000).send).toBe(true);
    });
  });

  it('prunes stale entries instead of growing unbounded', () => {
    for (let i = 0; i < 600; i++) {
      shouldDeliverAlert(`k${i}`, 1000);
    }
    // Far past the window: stale entries are prunable; a new key still works
    const verdict = shouldDeliverAlert('fresh', 1000 + ALERT_COOLDOWN_MS * 2);
    expect(verdict).toEqual({ send: true, suppressedCount: 0 });
    // Old key past window also delivers again
    expect(shouldDeliverAlert('k0', 1000 + ALERT_COOLDOWN_MS * 2).send).toBe(
      true,
    );
  });
});
