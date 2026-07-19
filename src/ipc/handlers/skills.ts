import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

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
 * save_skill — write a global skill to container/skills/{name}/SKILL.md.
 * Open to all groups (Phase 0b dropped the isMain gate; trust.yaml policy
 * is the only restriction once Phase 4 strips skipGate). Migrated from
 * src/ipc.ts:1107-1199 (handleSaveSkillIpc).
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

  authorize(input, _ctx) {
    // Phase 0b: non-main authorize block dropped — trust.yaml policy is now
    // the only restriction. Non-main agents can stage save_skill calls
    // which land in pending_actions. See spec R2-I2.
    // Phase 0a (gate-activation prep): payloadForStaging contains the
    // actual skillName + skillContent so the /approve replay path receives
    // the full input. See spec R3-C2.
    // Phase 4 (gate-activation): skipGate REMOVED — every call now flows
    // through gateAndStage. With trust.yaml `save_skill: draft` on all 9
    // agents, dispatch stages in pending_actions; user `/approve pa-xxx`
    // invokes the replay module (Phase 2) which calls execute() inline.
    // See spec Phase 4 + docs/superpowers/plans/2026-05-19-ipc-gate-
    // activation-plan.md.
    return {
      target: '',
      notifySummary: '',
      payloadForStaging: {
        type: 'save_skill',
        skillName: input.skillName,
        skillContent: input.skillContent,
      },
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
