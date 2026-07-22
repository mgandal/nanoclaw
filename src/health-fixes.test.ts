import { execFileSync } from 'child_process';
import path from 'path';

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
  it('registers the seven watchdog handlers and the fix actions', () => {
    const addFixHandler = vi.fn();
    const setFixActions = vi.fn();
    const monitor = {
      addFixHandler,
      setFixActions,
    } as unknown as HealthMonitor;

    registerFixHandlers(monitor, '/tmp/fixes');

    expect(addFixHandler).toHaveBeenCalledTimes(7);
    const ids = addFixHandler.mock.calls.map((c) => c[0].id);
    expect(ids).toEqual([
      'mcp-qmd',
      'mcp-honcho',
      'mcp-apple-notes',
      'mcp-todoist',
      'mcp-hindsight',
      'container-runtime',
      'sqlite-lock',
    ]);
    expect(addFixHandler.mock.calls[0][0].fixScript).toBe(
      '/tmp/fixes/restart-qmd.sh',
    );
    expect(setFixActions).toHaveBeenCalledTimes(1);
  });

  // Regression: Honcho went dark for ~9h after the 2026-07-20 reboot because
  // the watchdog alerted on `mcp:Honcho` but had no handler to restart it.
  it('can self-heal Honcho (handler exists for the mcp:Honcho service key)', () => {
    const addFixHandler = vi.fn();
    const monitor = {
      addFixHandler,
      setFixActions: vi.fn(),
    } as unknown as HealthMonitor;

    registerFixHandlers(monitor, '/tmp/fixes');

    const honcho = addFixHandler.mock.calls
      .map((c) => c[0])
      .find((h) => h.service === 'mcp:Honcho');
    expect(honcho).toBeDefined();
    expect(honcho.fixScript).toBe('/tmp/fixes/restart-honcho.sh');
    expect(honcho.verify).toEqual({
      type: 'http',
      url: 'http://localhost:8010/health',
      expectStatus: 200,
    });
  });

  // Regression: Hindsight went dark three times across three separate
  // NanoClaw processes (2026-07-21 22:04, 2026-07-22 07:24, 09:59) because
  // it was the one polled MCP endpoint with no handler — the watchdog
  // alerted OPS-claw once per incident and then waited for a human.
  it('can self-heal Hindsight (handler exists for the mcp:Hindsight service key)', () => {
    const addFixHandler = vi.fn();
    const monitor = {
      addFixHandler,
      setFixActions: vi.fn(),
    } as unknown as HealthMonitor;

    registerFixHandlers(monitor, '/tmp/fixes');

    const hindsight = addFixHandler.mock.calls
      .map((c) => c[0])
      .find((h) => h.service === 'mcp:Hindsight');
    expect(hindsight).toBeDefined();
    expect(hindsight.fixScript).toBe('/tmp/fixes/restart-hindsight.sh');
    // Regression: at 120s the next attempt lands while a slow (~135s) start is
    // still in flight, so kickstart -k SIGKILLs it and the watchdog livelocks
    // at the cooldown cadence. Must stay above the worst-case startup.
    expect(hindsight.cooldownMs).toBeGreaterThan(135_000);
    // Verify against the upstream (8888), not the 8889 proxy: the proxy
    // answers 503 with a JSON body while the upstream is down, and any HTTP
    // response counts as reachable — probing it would mask the outage.
    expect(hindsight.verify).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8888/health',
      expectStatus: 200,
    });
  });
});

describe('restart-hindsight.sh', () => {
  // The watchdog is the only caller and it runs at 3am; a bad shebang, a
  // syntax error, or a lost exec bit would otherwise surface as an
  // unexplained "Auto-fix failed". --dry-run parses the whole script and
  // exercises the arg handling without touching a service.
  it('runs --dry-run cleanly without touching any service', () => {
    const script = path.join(
      process.cwd(),
      'scripts',
      'fixes',
      'restart-hindsight.sh',
    );
    const out = execFileSync(script, ['--dry-run'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME },
    });
    expect(out).toContain('DRY-RUN');
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
