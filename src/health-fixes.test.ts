import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import { readEnvFile } from './env.js';
import { registerFixHandlers, resolveMcpEndpoints } from './health-fixes.js';
import type { HealthMonitor } from './health-monitor.js';

afterEach(() => {
  delete process.env.APPLE_NOTES_URL;
  vi.mocked(readEnvFile).mockReturnValue({});
});

describe('registerFixHandlers', () => {
  it('registers the five watchdog handlers and the fix actions', () => {
    const addFixHandler = vi.fn();
    const setFixActions = vi.fn();
    const monitor = { addFixHandler, setFixActions } as unknown as HealthMonitor;

    registerFixHandlers(monitor, '/tmp/fixes');

    expect(addFixHandler).toHaveBeenCalledTimes(5);
    const ids = addFixHandler.mock.calls.map((c) => c[0].id);
    expect(ids).toEqual([
      'mcp-qmd',
      'mcp-apple-notes',
      'mcp-todoist',
      'container-runtime',
      'sqlite-lock',
    ]);
    expect(addFixHandler.mock.calls[0][0].fixScript).toBe(
      '/tmp/fixes/restart-qmd.sh',
    );
    expect(setFixActions).toHaveBeenCalledTimes(1);
  });
});

describe('resolveMcpEndpoints', () => {
  it('prefers process.env over the .env file layer', () => {
    process.env.APPLE_NOTES_URL = 'http://env:8184/mcp';
    vi.mocked(readEnvFile).mockReturnValue({
      APPLE_NOTES_URL: 'http://file:8184/mcp',
    });
    const eps = resolveMcpEndpoints();
    expect(eps.find((e) => e.name === 'Apple Notes')?.url).toBe(
      'http://env:8184/mcp',
    );
  });

  it('falls back to the .env file layer and derives the Honcho list URL', () => {
    // The dev shell exports real integration URLs; clear them so this test
    // exercises the file-fallback layer.
    const saved = {
      HONCHO_URL: process.env.HONCHO_URL,
      TODOIST_URL: process.env.TODOIST_URL,
    };
    delete process.env.HONCHO_URL;
    delete process.env.TODOIST_URL;
    try {
      vi.mocked(readEnvFile).mockReturnValue({
        HONCHO_URL: 'http://localhost:8010',
        TODOIST_URL: 'http://file:8186/mcp',
      });
      const eps = resolveMcpEndpoints();
      expect(eps.find((e) => e.name === 'Honcho')?.url).toBe(
        'http://localhost:8010/v3/workspaces/list',
      );
      expect(eps.find((e) => e.name === 'Todoist')?.url).toBe(
        'http://file:8186/mcp',
      );
    } finally {
      if (saved.HONCHO_URL !== undefined)
        process.env.HONCHO_URL = saved.HONCHO_URL;
      if (saved.TODOIST_URL !== undefined)
        process.env.TODOIST_URL = saved.TODOIST_URL;
    }
  });

  it('QMD always polls its unauthenticated /health URL', () => {
    const qmd = resolveMcpEndpoints().find((e) => e.name === 'QMD');
    expect(qmd?.healthUrl).toBe('http://localhost:8181/health');
  });
});
