import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../../config.js';
import { getBridgeToken } from '../../bridge-auth.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

// Helpers MAX_SKILL_CONTENT_BYTES, getBuiltinSkillNames, and
// _resetBuiltinSkillsCacheForTests will be added in Task 8 (Batch 2G) when
// saveSkillHandler arrives. Eslint forbids declaring them ahead of their
// first user.

/**
 * skill_search — read-only QMD bridge search. Already on SKIP_GATE_ALLOWLIST
 * at handler.ts:28. Migrated verbatim from src/ipc.ts:1444-1532.
 *
 * Wire-format notes:
 *  - resultsDirName: 'skill_results' matches the container-side hardcoded
 *    path. All 4 skill_* handlers share this directory.
 *  - skipGate: true preserves the legacy gate-bypass behavior.
 */
interface SkillSearchInput {
  query: string | undefined;
}

export const skillSearchHandler: IpcHandler<
  SkillSearchInput,
  { executed: true; result: { success: boolean; message: string } }
> = {
  type: 'skill_search',
  responseKind: 'result',
  resultsDirName: 'skill_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return { query: typeof r.query === 'string' ? r.query : undefined };
  },

  authorize() {
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'skill_search' },
      skipGate: true,
    };
  },

  async execute(input, ctx) {
    if (!input.query) {
      return {
        executed: true,
        result: { success: false, message: 'Missing query parameter' },
      };
    }

    try {
      const response = await fetch('http://localhost:8181/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getBridgeToken()}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'query',
            arguments: {
              searches: [{ type: 'lex', query: input.query }],
              collections: ['skill-catalog'],
              intent: input.query,
              limit: 5,
            },
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      const json = (await response.json()) as {
        result?: {
          content?: Array<{ text?: string }>;
        };
      };

      const rawText = json.result?.content?.[0]?.text;
      if (!rawText) {
        return {
          executed: true,
          result: { success: false, message: 'QMD returned empty response' },
        };
      }

      const parsed = JSON.parse(rawText) as {
        results: Array<{
          file: string;
          title: string;
          score: number;
          snippet: string;
        }>;
      };

      const formatted = parsed.results
        .map(
          (r) =>
            `${r.title} (score: ${r.score.toFixed(2)})\n  ${r.snippet}\n  file: ${r.file}`,
        )
        .join('\n\n');

      logger.info(
        { sourceGroup: ctx.sourceGroup, query: input.query, requestId: ctx.requestId },
        'skill_search IPC handled',
      );

      return {
        executed: true,
        result: {
          success: true,
          message: formatted || 'No skills found',
        },
      };
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      logger.warn(
        { err, sourceGroup: ctx.sourceGroup, requestId: ctx.requestId },
        'skill_search IPC error',
      );
      return {
        executed: true,
        result: {
          success: false,
          message: isTimeout
            ? 'Skill search timed out'
            : 'QMD unavailable: ' +
              (err instanceof Error ? err.message : String(err)),
        },
      };
    }
  },
};

/**
 * skill_invoked — telemetry fire-and-forget. Mutates a crystallized skill's
 * frontmatter (invocation_count++, last_invoked_at upsert) and appends to
 * usage.jsonl. NO result file, NO audit row, NO notify.
 *
 * Already on SKIP_GATE_ALLOWLIST at handler.ts:29. Migrated verbatim from
 * src/ipc.ts:1336-1428.
 *
 * Contract pins (DO NOT change without redesign):
 *  - responseKind omitted → defaults to 'notify'. With skipGate=true,
 *    decision === null, so the dispatcher's else-if-decision-not-null
 *    notify branch is unreachable. notifySummary: '' never fires.
 *  - DO NOT change responseKind to 'result' — the dispatcher would
 *    synthesize a {success:true} file alongside the SKILL.md mutation,
 *    surprising downstream consumers.
 *  - skipGate: true is load-bearing. Without it, an agent with no
 *    trust.yaml entry for skill_invoked would be blocked AND a
 *    misleading "blocked" audit row would be written, silently
 *    stopping the telemetry mutation. Regression-guarded by the
 *    SKIP_GATE_ALLOWLIST membership test in skills.test.ts.
 *  - agentsRoot env-gate (`isTestEnv`) is the only barrier preventing a
 *    compromised container from redirecting writes to an arbitrary host
 *    path. DO NOT remove the env-gate.
 */
interface SkillInvokedInput {
  agent: string | undefined;
  name: string | undefined;
  agentsRoot: string | undefined;
}

export const skillInvokedHandler: IpcHandler<SkillInvokedInput, void> = {
  type: 'skill_invoked',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      agent: typeof r.agent === 'string' ? r.agent : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
      agentsRoot: typeof r.agentsRoot === 'string' ? r.agentsRoot : undefined,
    };
  },

  authorize() {
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'skill_invoked' },
      skipGate: true,
    };
  },

  execute(input, ctx) {
    const agentRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const skillNameRe = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
    if (!input.agent || !agentRe.test(input.agent)) {
      logger.warn(
        { agent: input.agent, name: input.name, sourceGroup: ctx.sourceGroup },
        'skill_invoked IPC rejected: invalid payload',
      );
      return;
    }
    if (!input.name || !skillNameRe.test(input.name)) {
      logger.warn(
        { agent: input.agent, name: input.name, sourceGroup: ctx.sourceGroup },
        'skill_invoked IPC rejected: invalid payload',
      );
      return;
    }

    // Env-gate the agentsRoot test seam. DO NOT remove — production
    // protection against path-redirection from compromised container.
    const isTestEnv =
      process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
    const agentsRoot =
      isTestEnv && typeof input.agentsRoot === 'string'
        ? input.agentsRoot
        : AGENTS_DIR;

    try {
      const crystallizedDir = path.join(
        agentsRoot,
        input.agent,
        'skills',
        'crystallized',
      );
      const skillFile = path.join(crystallizedDir, input.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        logger.debug(
          { agent: input.agent, name: input.name },
          'skill_invoked: no SKILL.md found, ignoring',
        );
        return;
      }

      const existing = fs.readFileSync(skillFile, 'utf-8');
      const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) {
        logger.warn(
          { agent: input.agent, name: input.name },
          'skill_invoked: malformed frontmatter',
        );
        return;
      }

      let frontmatter = fmMatch[1];
      const body = fmMatch[2];
      const nowIso = new Date().toISOString();

      if (/^invocation_count:\s*\d+/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(
          /^invocation_count:\s*(\d+)/m,
          (_, n) => `invocation_count: ${Number(n) + 1}`,
        );
      } else {
        frontmatter = `${frontmatter}\ninvocation_count: 1`;
      }

      if (/^last_invoked_at:/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(
          /^last_invoked_at:.*$/m,
          `last_invoked_at: ${nowIso}`,
        );
      } else {
        frontmatter = `${frontmatter}\nlast_invoked_at: ${nowIso}`;
      }

      const updated = `---\n${frontmatter}\n---\n${body}`;
      const tmpPath = `${skillFile}.tmp`;
      fs.writeFileSync(tmpPath, updated);
      fs.renameSync(tmpPath, skillFile);

      const usageLine =
        JSON.stringify({
          ts: nowIso,
          agent: input.agent,
          name: input.name,
          sourceGroup: ctx.sourceGroup,
        }) + '\n';
      fs.appendFileSync(path.join(crystallizedDir, 'usage.jsonl'), usageLine);

      logger.info(
        { agent: input.agent, name: input.name, sourceGroup: ctx.sourceGroup },
        'Crystallized skill invoked',
      );
    } catch (err) {
      logger.error(
        { err, agent: input.agent, name: input.name },
        'skill_invoked IPC error',
      );
    }
  },
};
