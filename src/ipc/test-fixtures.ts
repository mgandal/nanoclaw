import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

/**
 * Shared fixtures for IPC handler tests that need an on-disk agent with a
 * trust.yaml. gateAndStage loads trust from AGENTS_DIR (cwd-derived, not
 * test-overridable), so fixtures must live in the REAL data/agents/ —
 * which makes leak hygiene matter:
 *
 *   - makeTrustAgent / rmTrustAgent pair inside try/finally per test.
 *   - sweepStaleFixtureAgents(prefix) in beforeAll so dirs orphaned by a
 *     SIGKILLed earlier run (finally never ran) are cleaned before the
 *     suite writes new ones, instead of accumulating as git-visible noise
 *     that the daemon's agent-registry scan warn-logs at startup.
 *
 * The same inline pattern predates this module in ~15 test files
 * (skills.test.ts, ipc.test.ts, handler-*.test.ts, …) — new tests should
 * import from here; migrate old sites opportunistically.
 */

const AGENTS_DIR = path.join(DATA_DIR, 'agents');

/** `${prefix}-<epoch-ms>-<6 alphanumerics>` — what makeTrustAgent mints
 * and the ONLY shape sweepStaleFixtureAgents will delete. */
const fixtureNameRe = (prefix: string): RegExp =>
  new RegExp(`^${prefix}-\\d{10,}-[a-z0-9]{1,8}$`);

export function makeTrustAgent(prefix: string, trustYaml: string): string {
  const agentName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const agentDir = path.join(AGENTS_DIR, agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'trust.yaml'), trustYaml);
  return agentName;
}

export function rmTrustAgent(agentName: string): void {
  fs.rmSync(path.join(AGENTS_DIR, agentName), {
    recursive: true,
    force: true,
  });
}

/**
 * makeTrustAgent + register the agent as enabled for `groupFolder` in
 * agent_registry, so the dispatcher's payload-attribution eligibility
 * check accepts a payload `agent` claim from that group. Requires an
 * initialized test DB (call after _initTestDatabase). Import
 * upsertAgentRegistry lazily to avoid a static db import in this
 * fs-only fixtures module.
 */
export async function makeEligibleAgent(
  prefix: string,
  groupFolder: string,
  trustYaml: string,
): Promise<string> {
  const agentName = makeTrustAgent(prefix, trustYaml);
  const { upsertAgentRegistry } = await import('../db.js');
  upsertAgentRegistry([
    { agent_name: agentName, group_folder: groupFolder, enabled: 1 },
  ]);
  return agentName;
}

/**
 * Delete leftover fixture agent dirs from previous killed runs. Guarded
 * by the exact minted-name shape so a real agent (or anything
 * hand-created) can never match.
 */
export function sweepStaleFixtureAgents(prefix: string): void {
  const re = fixtureNameRe(prefix);
  let entries: string[];
  try {
    entries = fs.readdirSync(AGENTS_DIR);
  } catch (err) {
    // A missing agents dir just means nothing to sweep.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (re.test(entry)) {
      fs.rmSync(path.join(AGENTS_DIR, entry), {
        recursive: true,
        force: true,
      });
    }
  }
}

/**
 * Read a dispatcher-written result file:
 * {dataDir}/ipc/{source}/{resultsDirName}/{requestId}.json.
 * `source` is the FULL source dir — pass the compound `group--agent`
 * form for agent-attributed dispatches.
 */
export function readIpcResult(
  dataDir: string,
  source: string,
  resultsDirName: string,
  requestId: string,
): Record<string, unknown> | null {
  const file = path.join(
    dataDir,
    'ipc',
    source,
    resultsDirName,
    `${requestId}.json`,
  );
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}
