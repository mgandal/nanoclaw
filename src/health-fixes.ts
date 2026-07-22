import path from 'path';

import { readEnvFile } from './env.js';
import { checkMcpEndpoint } from './health-check.js';
import { createDefaultFixActions, HealthMonitor } from './health-monitor.js';

/**
 * The operational tables the health watchdog runs from: which services it
 * knows how to fix (fix-handler table) and which MCP endpoints it polls
 * (endpoint table with .env fallbacks). Extracted from main() so the
 * tables are data a test can read, not closures inside the composition
 * root.
 */

/**
 * Register the watchdog fix handlers on a HealthMonitor. `fixScriptsDir`
 * is scripts/fixes under the project root.
 */
export function registerFixHandlers(
  monitor: HealthMonitor,
  fixScriptsDir: string,
): void {
  monitor.addFixHandler({
    id: 'mcp-qmd',
    service: 'mcp:QMD',
    fixScript: path.join(fixScriptsDir, 'restart-qmd.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8181/health',
      expectStatus: 200,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  monitor.addFixHandler({
    id: 'mcp-honcho',
    service: 'mcp:Honcho',
    fixScript: path.join(fixScriptsDir, 'restart-honcho.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8010/health',
      expectStatus: 200,
    },
    // Docker Desktop takes ~60-90s to cold-start, so allow a third attempt
    // before escalating to the user.
    cooldownMs: 120_000,
    maxAttempts: 3,
  });
  monitor.addFixHandler({
    id: 'mcp-apple-notes',
    service: 'mcp:Apple Notes',
    fixScript: path.join(fixScriptsDir, 'restart-apple-notes.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8184/mcp',
      expectStatus: 405,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  monitor.addFixHandler({
    id: 'mcp-todoist',
    service: 'mcp:Todoist',
    fixScript: path.join(fixScriptsDir, 'restart-todoist.sh'),
    verify: {
      type: 'http',
      url: 'http://localhost:8186/mcp',
      expectStatus: 405,
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  monitor.addFixHandler({
    id: 'mcp-hindsight',
    service: 'mcp:Hindsight',
    fixScript: path.join(fixScriptsDir, 'restart-hindsight.sh'),
    verify: {
      type: 'http',
      // The upstream, not the 8889 proxy: the proxy answers 503-with-body
      // while the upstream is down, and any HTTP response reads as reachable.
      url: 'http://127.0.0.1:8888/health',
      expectStatus: 200,
    },
    // Startup re-runs the LLM verify against the shim and can trail a cold
    // model load, so allow a third attempt before escalating.
    cooldownMs: 120_000,
    maxAttempts: 3,
  });
  monitor.addFixHandler({
    id: 'container-runtime',
    service: 'container-runtime',
    fixScript: path.join(fixScriptsDir, 'restart-container-runtime.sh'),
    verify: {
      type: 'command',
      cmd: '/usr/local/bin/container',
      args: ['system', 'status'],
    },
    cooldownMs: 120_000,
    maxAttempts: 2,
  });
  monitor.addFixHandler({
    id: 'sqlite-lock',
    service: 'sqlite-lock',
    fixScript: path.join(fixScriptsDir, 'kill-sqlite-orphans.sh'),
    verify: {
      type: 'command',
      cmd: '/bin/sh',
      args: ['-c', 'echo "SELECT 1" | sqlite3 store/messages.db'],
    },
    cooldownMs: 60_000,
    maxAttempts: 2,
  });

  monitor.setFixActions(createDefaultFixActions());
}

export interface McpEndpoint {
  name: string;
  url: string | undefined;
  healthUrl?: string;
}

/**
 * The MCP endpoints the health poll watches. Each has an optional
 * healthUrl for services where the MCP URL isn't suitable for health
 * checks (SSE endpoints that hang or require auth — B1: each HTTP-auth'd
 * bridge proxy exposes /health unauth'd so the monitor needs no bearer).
 * URLs resolve process.env first, then .env.
 */
export function resolveMcpEndpoints(): McpEndpoint[] {
  const endpoints: McpEndpoint[] = [
    {
      name: 'QMD',
      url: 'http://localhost:8181/mcp',
      healthUrl: 'http://localhost:8181/health',
    },
    { name: 'Honcho', url: undefined },
    {
      name: 'Apple Notes',
      url: process.env.APPLE_NOTES_URL,
      healthUrl: 'http://localhost:8184/health',
    },
    {
      name: 'Todoist',
      url: process.env.TODOIST_URL,
      healthUrl: 'http://localhost:8186/health',
    },
    {
      name: 'Hindsight',
      url: process.env.HINDSIGHT_URL,
      healthUrl: 'http://127.0.0.1:8888/health',
    },
  ];

  const envUrls = readEnvFile([
    'HONCHO_URL',
    'APPLE_NOTES_URL',
    'TODOIST_URL',
    'HINDSIGHT_URL',
  ]);
  if (!endpoints[1].url && envUrls.HONCHO_URL) {
    endpoints[1].url = `${envUrls.HONCHO_URL}/v3/workspaces/list`;
  }
  if (!endpoints[2].url) endpoints[2].url = envUrls.APPLE_NOTES_URL;
  if (!endpoints[3].url) endpoints[3].url = envUrls.TODOIST_URL;
  if (!endpoints[4].url) endpoints[4].url = envUrls.HINDSIGHT_URL;

  return endpoints;
}

/**
 * One poll tick over the MCP endpoint table: record/clear infra events,
 * escalate to attemptFix after 3 consecutive failures, and report QMD
 * reachability (consumed by container-runner's mount decisions).
 */
export async function checkMcpEndpoints(
  monitor: HealthMonitor,
  endpoints: McpEndpoint[],
  onQmdReachable: (reachable: boolean) => void,
): Promise<void> {
  for (const ep of endpoints) {
    if (!ep.url) continue;
    const result = await checkMcpEndpoint(ep.healthUrl || ep.url);
    if (result.reachable) {
      monitor.clearInfraEvent(`mcp:${ep.name}`);
    } else {
      monitor.recordInfraEvent(
        `mcp:${ep.name}`,
        `MCP server ${ep.name} is unreachable`,
      );
      const failCount = monitor.getInfraFailureCount(`mcp:${ep.name}`);
      if (failCount >= 3) {
        void monitor.attemptFix(`mcp:${ep.name}`);
      }
    }
    if (ep.name === 'QMD') {
      onQmdReachable(result.reachable);
    }
  }
}
