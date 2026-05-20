import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../../config.js';
import { getBridgeToken } from '../../bridge-auth.js';
import { frontmatterDeclaresBash } from '../../skill-frontmatter.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

/**
 * Maximum size of a SKILL.md saved via save_skill IPC (64 KB). The agent
 * writes the body itself, so this is a soft DoS bound rather than a
 * structural limit. Existing builtins fit comfortably under 16 KB.
 *
 * Relocated from src/ipc.ts:1066 in Batch 2G.
 */
const MAX_SKILL_CONTENT_BYTES = 64 * 1024;

/**
 * Discover the active builtin skill names by listing container/skills/.
 * Cached per-process; the directory is read-only at runtime, so a single
 * read at first invocation is sufficient. A reload helper is exposed for
 * tests that swap the cwd between cases.
 *
 * Relocated from src/ipc.ts:1075 in Batch 2G.
 */
let builtinSkillsCache: Set<string> | null = null;
function getBuiltinSkillNames(): Set<string> {
  if (builtinSkillsCache) return builtinSkillsCache;
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    builtinSkillsCache = new Set(
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch (err) {
    logger.error(
      { skillsDir, err: err instanceof Error ? err.message : String(err) },
      'getBuiltinSkillNames: container/skills/ unreadable — save_skill builtin protection is fail-open',
    );
    builtinSkillsCache = new Set();
  }
  return builtinSkillsCache;
}

/** @internal — for tests only. Forces re-scan on next getBuiltinSkillNames(). */
export function _resetBuiltinSkillsCacheForTests(): void {
  builtinSkillsCache = null;
}

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
      logger.warn(
        { sourceGroup: ctx.sourceGroup, requestId: ctx.requestId },
        'skill_search IPC rejected: missing query parameter',
      );
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

      const parsed = JSON.parse(rawText) as unknown;

      // Guard against parsed being a non-object primitive (null, number,
      // boolean, string) or array (H1.6 fix from R2 review round 2).
      // Without this, JSON.parse("null") returns null and the next-line
      // Array.isArray(parsedObj.results) throws TypeError on the null
      // dereference — caught by outer try/catch as the misleading
      // "QMD unavailable: null is not an object..." message that L1 +
      // H1 were already supposed to close.
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        logger.warn(
          {
            sourceGroup: ctx.sourceGroup,
            requestId: ctx.requestId,
            parsedType: parsed === null ? 'null' : typeof parsed,
          },
          'skill_search IPC: QMD returned 200 with non-object payload',
        );
        return {
          executed: true,
          result: {
            success: false,
            message: 'QMD returned malformed results array',
          },
        };
      }

      const parsedObj = parsed as {
        results?: Array<{
          file: string;
          title: string;
          score: number;
          snippet: string;
        }>;
      };

      if (!Array.isArray(parsedObj.results)) {
        logger.warn(
          {
            sourceGroup: ctx.sourceGroup,
            requestId: ctx.requestId,
            parsedKeys: Object.keys(parsedObj),
          },
          'skill_search IPC: QMD returned 200 with malformed results array',
        );
        return {
          executed: true,
          result: {
            success: false,
            message: 'QMD returned malformed results array',
          },
        };
      }

      // Element-level shape validation (H1 fix from R2 review). The outer
      // Array.isArray guard above lets {results: [null]} / {results: [{}]}
      // through; without this check, .map() throws TypeError on r.title /
      // r.score.toFixed() and the outer catch re-reports it as the same
      // misleading 'QMD unavailable: ...' message L1 was supposed to fix.
      // Strict reject (vs lenient filter): malformed elements signal a
      // QMD-side bug worth surfacing, not silently dropping.
      const isValidElement = (
        r: unknown,
      ): r is { file: string; title: string; score: number; snippet: string } =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as Record<string, unknown>).file === 'string' &&
        typeof (r as Record<string, unknown>).title === 'string' &&
        typeof (r as Record<string, unknown>).score === 'number' &&
        Number.isFinite((r as Record<string, unknown>).score) &&
        typeof (r as Record<string, unknown>).snippet === 'string';

      const resultCount = parsedObj.results.length;
      if (!parsedObj.results.every(isValidElement)) {
        logger.warn(
          {
            sourceGroup: ctx.sourceGroup,
            requestId: ctx.requestId,
            resultCount,
          },
          'skill_search IPC: QMD returned 200 with malformed element shape',
        );
        return {
          executed: true,
          result: {
            success: false,
            message: 'QMD returned malformed results array',
          },
        };
      }

      const formatted = parsedObj.results
        .map(
          (r) =>
            `${r.title} (score: ${r.score.toFixed(2)})\n  ${r.snippet}\n  file: ${r.file}`,
        )
        .join('\n\n');

      logger.info(
        {
          sourceGroup: ctx.sourceGroup,
          query: input.query,
          requestId: ctx.requestId,
        },
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
      const isTimeout =
        err instanceof DOMException && err.name === 'AbortError';
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
  // Explicit 'notify' (not omitted) makes the contract intent clear to
  // future readers. DO NOT change to 'result' — the dispatcher would
  // synthesize a {success:true} file alongside the SKILL.md mutation,
  // surprising downstream consumers. See JSDoc above for full rationale.
  responseKind: 'notify',

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

/**
 * save_skill — write a global skill to container/skills/{name}/SKILL.md.
 * Main-only. Migrated from src/ipc.ts:1107-1199 (handleSaveSkillIpc).
 *
 * Validation lives in execute() (NOT parse() or authorize()) so the agent
 * sees the 4 actionable error messages verbatim from legacy. If validation
 * ran in parse(), the dispatcher's default-payload would synthesize
 * `{success:false, message:'execution bailed'}` and the agent would lose
 * the actionable text. See spec Risks for details (R1 Critical 2).
 */
interface SaveSkillInput {
  skillName: string | undefined;
  skillContent: string | undefined;
}

export const saveSkillHandler: IpcHandler<
  SaveSkillInput,
  { executed: true; result: { success: boolean; message: string } }
> = {
  type: 'save_skill',
  responseKind: 'result',
  resultsDirName: 'skill_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      skillName: typeof r.skillName === 'string' ? r.skillName : undefined,
      skillContent:
        typeof r.skillContent === 'string' ? r.skillContent : undefined,
    };
  },

  authorize(_input, ctx) {
    // Preserve legacy non-main block (ipc.ts:1013-1021).
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'save_skill' },
      skipGate: true,
    };
  },

  execute(input, ctx) {
    if (!input.skillName || !input.skillContent) {
      return {
        executed: true,
        result: {
          success: false,
          message: 'Missing required parameters: skillName and skillContent',
        },
      };
    }

    if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(input.skillName)) {
      return {
        executed: true,
        result: {
          success: false,
          message:
            'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).',
        },
      };
    }

    const contentBytes = Buffer.byteLength(input.skillContent, 'utf-8');
    if (contentBytes > MAX_SKILL_CONTENT_BYTES) {
      return {
        executed: true,
        result: {
          success: false,
          message: `Skill content (${contentBytes} bytes) exceeds the ${MAX_SKILL_CONTENT_BYTES}-byte cap.`,
        },
      };
    }

    if (getBuiltinSkillNames().has(input.skillName)) {
      return {
        executed: true,
        result: {
          success: false,
          message: `Cannot overwrite built-in skill "${input.skillName}".`,
        },
      };
    }

    if (frontmatterDeclaresBash(input.skillContent)) {
      return {
        executed: true,
        result: {
          success: false,
          message:
            'Skill frontmatter declares allowed-tools: Bash. Bash-using skills must be vetted and added to the operator-managed allowlist, not persisted via save_skill.',
        },
      };
    }

    try {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        input.skillName,
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), input.skillContent);
      logger.info(
        {
          skillName: input.skillName,
          sourceGroup: ctx.sourceGroup,
          requestId: ctx.requestId,
        },
        'Container skill saved permanently via IPC',
      );
      return {
        executed: true,
        result: {
          success: true,
          message: `Skill "${input.skillName}" saved permanently.`,
        },
      };
    } catch (err) {
      logger.error(
        { err, skillName: input.skillName, sourceGroup: ctx.sourceGroup },
        'save_skill IPC error',
      );
      return {
        executed: true,
        result: {
          success: false,
          message: `Error saving skill: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  },
};

/**
 * crystallize_skill — write a "reusable recipe" skill to
 * data/agents/{agent}/skills/crystallized/{name}/SKILL.md. Main-only.
 * Migrated from src/ipc.ts:1218-1328 (handleCrystallizeSkillIpc).
 *
 * Validation lives in execute() per the same R1 Critical 2 reasoning as
 * saveSkillHandler. agentsRoot env-gate preserved (R2 Critical 2) —
 * production protection against compromised-container path-redirection.
 *
 * Non-main block: legacy at ipc.ts:1028-1036 had an `if (!isMain)` warn +
 * return-true. Both R1 and R2 peer review verified this. The brainstorm's
 * original "no main check" claim was wrong.
 */
interface CrystallizeSkillInput {
  agent: string | undefined;
  name: string | undefined;
  description: string | undefined;
  source_task: string | undefined;
  body: string | undefined;
  confidence: number;
  agentsRoot: string | undefined;
}

export const crystallizeSkillHandler: IpcHandler<
  CrystallizeSkillInput,
  { executed: true; result: { success: boolean; message: string } }
> = {
  type: 'crystallize_skill',
  responseKind: 'result',
  resultsDirName: 'skill_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      agent: typeof r.agent === 'string' ? r.agent : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
      description:
        typeof r.description === 'string' ? r.description : undefined,
      source_task:
        typeof r.source_task === 'string' ? r.source_task : undefined,
      body: typeof r.body === 'string' ? r.body : undefined,
      confidence: typeof r.confidence === 'number' ? r.confidence : NaN,
      agentsRoot: typeof r.agentsRoot === 'string' ? r.agentsRoot : undefined,
    };
  },

  authorize(_input, ctx) {
    // Preserve legacy non-main block at ipc.ts:1028-1036 (R2 Critical 1 +
    // R1 Medium 1 — both reviewers verified the brainstorm's "no main
    // check" claim was wrong).
    if (!ctx.isMain) return null;
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: { type: 'crystallize_skill' },
      skipGate: true,
    };
  },

  execute(input, ctx) {
    const agentRe = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const skillNameRe = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

    // Per-field validation with first-error-wins ordering (M1 fix). Order
    // mirrors the legacy OR-chain at ipc.ts:1218; do not reorder without
    // updating tests 16a–16g which pin each message individually.
    const reject = (
      message: string,
    ): { executed: true; result: { success: boolean; message: string } } => {
      logger.warn(
        {
          agent: input.agent,
          name: input.name,
          sourceGroup: ctx.sourceGroup,
          requestId: ctx.requestId,
          confidence: input.confidence,
          failedField: message,
        },
        'crystallize_skill IPC rejected: invalid payload',
      );
      return {
        executed: true,
        result: { success: false, message },
      };
    };

    if (!input.agent || !agentRe.test(input.agent)) {
      return reject(
        'Invalid agent identifier. Use lowercase letters, numbers, underscores, or hyphens (1-64 chars).',
      );
    }
    if (!input.name || !skillNameRe.test(input.name)) {
      return reject(
        'Invalid skill name. Use lowercase letters, numbers, and hyphens (2-64 chars).',
      );
    }
    if (!input.description) {
      return reject('Missing required field: description.');
    }
    if (!input.source_task) {
      return reject('Missing required field: source_task.');
    }
    if (!input.body) {
      return reject('Missing required field: body.');
    }
    if (!Number.isFinite(input.confidence)) {
      return reject(
        'Invalid confidence. Must be a finite number between 1 and 10.',
      );
    }
    if (input.confidence < 1 || input.confidence > 10) {
      return reject(
        'Invalid confidence. Must be a finite number between 1 and 10.',
      );
    }

    // Env-gate the agentsRoot test seam (R2 Critical 2). DO NOT remove —
    // production protection against path-redirection from compromised
    // container. The negative test (test 19) pins this behavior.
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
      const skillDir = path.join(crystallizedDir, input.name);
      fs.mkdirSync(skillDir, { recursive: true });

      const nowIso = new Date().toISOString();
      const descYaml = JSON.stringify(input.description);
      const taskYaml = JSON.stringify(input.source_task);
      const frontmatter = [
        '---',
        `name: ${input.name}`,
        `description: ${descYaml}`,
        `crystallized_at: ${nowIso}`,
        `source_task: ${taskYaml}`,
        `confidence: ${input.confidence}`,
        `invocation_count: 0`,
        '---',
        '',
      ].join('\n');
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        frontmatter + input.body,
      );

      const logLine =
        JSON.stringify({
          ts: nowIso,
          agent: input.agent,
          name: input.name,
          source_task: input.source_task,
          confidence: input.confidence,
        }) + '\n';
      fs.appendFileSync(path.join(crystallizedDir, 'log.jsonl'), logLine);

      logger.info(
        {
          agent: input.agent,
          name: input.name,
          confidence: input.confidence,
          sourceGroup: ctx.sourceGroup,
          requestId: ctx.requestId,
        },
        'Crystallized skill saved',
      );
      return {
        executed: true,
        result: {
          success: true,
          message: `Crystallized skill "${input.name}" saved for ${input.agent}.`,
        },
      };
    } catch (err) {
      logger.error(
        { err, agent: input.agent, name: input.name },
        'crystallize_skill IPC error',
      );
      return {
        executed: true,
        result: {
          success: false,
          message: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  },
};
