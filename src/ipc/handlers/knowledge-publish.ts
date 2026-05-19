import { execFile } from 'child_process';
import path from 'path';

import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  /**
   * Self-assessed confidence 1-10. Distinct from KnowledgeEntry.confidence:
   * this is the IPC-payload-side input; KnowledgeEntry is the publishKnowledge()
   * file-writer input. Both gained `confidence` in the same commit (Phase 1.2
   * round-1 amendment §4.1) — they are structurally separate types.
   *
   * parse() always returns a number here (defaulted to 5 if missing or
   * out-of-range), so the field is non-optional.
   */
  confidence: number;
}

// AUDIT_TARGET stays module-level — it's a constant string used in the audit
// row's `target` column, NOT a filesystem path. The actual knowledge directory
// is derived from ctx.dataDir at call time (see execute()).
const AUDIT_TARGET = 'agent-knowledge';

// Verified path on this host: /usr/local/bin/qmd is a stable shim that
// hardcodes the fnm-installed node + qmd package. The raw `which qmd` output
// (an fnm-shell-pid symlink) is unstable and must NOT be used here. Under
// launchd, PATH and HOME are stripped — both are explicit in the execFile env
// (round-1 amendment §3.5). If the path differs on the host, update this
// constant.
const QMD_BIN = '/usr/local/bin/qmd';

// Once-per-process startup probe. Runs at module-import time (when the
// dispatcher first imports the handler registry). If QMD_BIN is rotten
// (e.g. fnm node version upgrade broke the shim), this surfaces loudly
// at startup via logger.error rather than silently per-publish via
// logger.warn. Non-blocking — uses execFile callback, not execFileSync,
// so a slow probe doesn't delay handler registration.
let qmdProbeFired = false;
function probeQmdBinaryOnce(): void {
  if (qmdProbeFired) return;
  qmdProbeFired = true;
  execFile(
    QMD_BIN,
    ['--version'],
    {
      timeout: 2_000,
      env: {
        PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '/Users/mgandal',
      },
    },
    (err, stdout) => {
      if (err) {
        logger.error(
          { err, qmdBin: QMD_BIN },
          'QMD_BIN probe failed at startup — knowledge_publish background ' +
            'qmd update calls will silently fail. Check fnm node version, ' +
            'shim wrapper at /usr/local/bin/qmd, or reinstall @tobilu/qmd.',
        );
      } else {
        logger.info(
          { qmdBin: QMD_BIN, version: stdout.trim().slice(0, 50) },
          'QMD_BIN probe ok at startup',
        );
      }
    },
  );
}
probeQmdBinaryOnce();

export const knowledgePublishHandler: IpcHandler<Input> = {
  type: 'knowledge_publish',

  parse(raw) {
    // Original case accepted any payload, substituting sensible defaults for
    // missing fields. Preserve that lenient behavior — no reject path here.
    const r =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    // Confidence: clamp to [1, 10] integers; default 5 for missing, non-numeric,
    // non-integer, or out-of-range values. Lenient parsing matches the original
    // handler's behavior for other fields.
    const rawConf = r.confidence;
    const confidence =
      typeof rawConf === 'number' &&
      Number.isInteger(rawConf) &&
      rawConf >= 1 &&
      rawConf <= 10
        ? rawConf
        : 5;
    return {
      topic: typeof r.topic === 'string' ? r.topic : 'unknown',
      finding: typeof r.finding === 'string' ? r.finding : '',
      evidence: typeof r.evidence === 'string' ? r.evidence : '',
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      confidence,
    };
  },

  authorize(input) {
    return {
      target: AUDIT_TARGET,
      auditSummary: input.topic,
      notifySummary: `published "${input.topic}"`,
      payloadForStaging: {
        type: 'knowledge_publish',
        topic: input.topic,
        finding: input.finding,
        evidence: input.evidence,
        tags: input.tags,
        confidence: input.confidence,
      },
    };
  },

  async execute(input, ctx) {
    const { publishKnowledge } = await import('../../knowledge.js');
    // Derive knowledgeDir from ctx.dataDir (not module-frozen DATA_DIR) so that
    // tests with dataDir overrides don't pollute production data/agent-knowledge/.
    // The 4-hour qmd update sync would otherwise index test fixtures into the
    // BM25 corpus and surface them to live agent queries.
    const knowledgeDir = path.join(ctx.dataDir, 'agent-knowledge');
    const filePath = publishKnowledge(input, ctx.sourceGroup, knowledgeDir);
    logger.info(
      { sourceGroup: ctx.sourceGroup, topic: input.topic, filePath },
      'Knowledge entry published',
    );

    // Fire-and-forget QMD index update so the finding is BM25-searchable
    // within ~30 seconds (vs. the 4-hour sync cycle). Under launchd, BOTH
    // PATH and HOME are stripped; provide both explicitly (round-1 amendment
    // §3.5). Failure is logged but does not propagate — same pattern as the
    // bus publish below.
    execFile(
      QMD_BIN,
      ['update', 'agent-knowledge'],
      {
        timeout: 30_000,
        env: {
          PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? '/Users/mgandal',
        },
      },
      (err) => {
        if (err) {
          logger.warn(
            { err, sourceGroup: ctx.sourceGroup, topic: input.topic },
            'qmd update agent-knowledge failed (non-fatal)',
          );
        }
      },
    );

    if (ctx.deps.messageBus) {
      ctx.deps.messageBus.publish({
        from: ctx.sourceGroup,
        topic: `knowledge:${input.topic}`,
        summary: input.finding.slice(0, 200),
        action_needed: '',
        priority: 'low',
      });
    }
  },
};
