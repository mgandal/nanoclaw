import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventRouter } from '../event-router.js';

beforeEach(() => {
  delete process.env.PROACTIVE_WATCHERS_ENABLED;
  vi.resetModules();
});

describe('wireProactiveWatchers', () => {
  it('returns a no-op stop handle when PROACTIVE_WATCHERS_ENABLED is false', async () => {
    process.env.PROACTIVE_WATCHERS_ENABLED = 'false';
    vi.resetModules();
    const mod = await import('./proactive-watchers.js');
    const handle = mod.wireProactiveWatchers({
      eventRouter: {} as EventRouter,
      vaultRoots: [],
      emailExportDir: '/nonexistent',
      hasRecentEmission: () => false,
      recordEmission: () => {},
      sendDeferred: async () => {},
    });
    expect(typeof handle.stop).toBe('function');
    handle.stop(); // should not throw
  });

  it('starts watchers when flag is true', async () => {
    process.env.PROACTIVE_WATCHERS_ENABLED = 'true';
    vi.resetModules();
    const mod = await import('./proactive-watchers.js');
    const handle = mod.wireProactiveWatchers({
      eventRouter: { route: vi.fn() } as unknown as EventRouter,
      vaultRoots: [],
      emailExportDir: '/nonexistent',
      hasRecentEmission: () => false,
      recordEmission: () => {},
      sendDeferred: async () => {},
    });
    expect(typeof handle.stop).toBe('function');
    handle.stop();
  });
});
