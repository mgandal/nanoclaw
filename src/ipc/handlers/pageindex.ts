import { resolveGroupFolderPath } from '../../group-folder.js';
import { validateAdditionalMounts } from '../../mount-security.js';
import { type MountMapping } from '../../pageindex.js';
import { runPageindexFetch, runPageindexIndex } from '../../pageindex-ipc.js';
import type {
  ExecuteResult,
  IpcHandler,
  IpcHandlerContext,
} from '../handler.js';

/**
 * pageindex_* cluster handlers. Two registry entries sharing one results
 * dir (`pageindex_results/`).
 *
 * Migrated from the if-ladder arm at git show 7b25dfc6:src/ipc.ts:1061-1092
 * which did pre-dispatch mount resolution before calling handlePageindexIpc.
 * The mount resolution moves into execute() here — only this cluster needs
 * mount info, so plumbing it through the dispatcher would be overkill.
 *
 * Trust shape (Batch 4 closure, 2026-07-19):
 *   pageindex_fetch is read-only and stays on SKIP_GATE_ALLOWLIST
 *   (skipGate for every caller). pageindex_index is a WRITE and is
 *   gated (off the allowlist, no skipGate) so that IF an agent-attributed
 *   caller ever appears it flows through gateAndStage — all 9 agents
 *   ship trust.yaml `pageindex_index: autonomous`.
 *
 *   NOTE: today no producer writes a pageindex_index IPC request — the
 *   only PDF indexing in the system is host-side and direct (indexPdf in
 *   src/channels/telegram.ts auto-indexes >20-page attachments, no IPC,
 *   no gate). So this handler and its gate are dormant scaffolding kept
 *   in lockstep with pageindex_fetch. If a container tool is ever added,
 *   it must stamp a validated `agent` field like the task_* tools do
 *   (payloadAgentAttribution) for the gate to attribute in production.
 *   Do NOT re-add skipGate — the type is off the allowlist, so the
 *   dispatcher would deny every call as a contract violation (Rule 4).
 */

/**
 * Build the same `mounts` array the if-ladder built pre-dispatch. Logic
 * preserved exactly from git show 7b25dfc6:src/ipc.ts:1063-1077: look up
 * the group entry by folder, validate any additionalMounts, then append
 * the /workspace/group mount.
 */
function resolveMountsForGroup(ctx: IpcHandlerContext): MountMapping[] {
  const mounts: MountMapping[] = [];

  const groupEntry = Object.values(ctx.registeredGroups).find(
    (g) => g.folder === ctx.sourceGroup,
  );
  if (groupEntry?.containerConfig?.additionalMounts) {
    const validated = validateAdditionalMounts(
      groupEntry.containerConfig.additionalMounts,
      groupEntry.name || ctx.sourceGroup,
      ctx.isMain,
    );
    mounts.push(...validated);
  }

  // Group-folder mount, matching the if-ladder's behaviour for in-container
  // /workspace/group references.
  mounts.push({
    hostPath: resolveGroupFolderPath(ctx.sourceGroup),
    containerPath: '/workspace/group',
    readonly: false,
  });

  return mounts;
}

// --- pageindex_fetch (read) ---

interface FetchInput {
  raw: Record<string, unknown>;
  pdfPath: string | undefined;
}

export const pageindexFetchHandler: IpcHandler<FetchInput, ExecuteResult> = {
  type: 'pageindex_fetch',
  responseKind: 'result',
  resultsDirName: 'pageindex_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      raw: r,
      pdfPath: typeof r.pdfPath === 'string' ? r.pdfPath : undefined,
    };
  },

  authorize(input) {
    return {
      target: 'pageindex',
      auditSummary: input.pdfPath?.slice(0, 100) ?? '(no path)',
      notifySummary: `fetched ${input.pdfPath?.slice(0, 80) ?? '(no path)'}`,
      payloadForStaging: { type: 'pageindex_fetch' },
      // On SKIP_GATE_ALLOWLIST. Rule 5 preserves the if-ladder's gate
      // bypass for both agent and non-agent callers.
      skipGate: true as const,
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
    const mounts = resolveMountsForGroup(ctx);
    const result = await runPageindexFetch(input.raw, mounts);
    return { executed: true, result };
  },
};

// --- pageindex_index (write) ---

interface IndexInput {
  raw: Record<string, unknown>;
  pdfPath: string | undefined;
}

export const pageindexIndexHandler: IpcHandler<IndexInput, ExecuteResult> = {
  type: 'pageindex_index',
  responseKind: 'result',
  resultsDirName: 'pageindex_results',
  // payloadAgentAttribution intentionally NOT set: no container producer
  // stamps an `agent` field for this action today. Add it together with
  // a stamping tool if pageindex_index ever becomes container-callable.

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      raw: r,
      pdfPath: typeof r.pdfPath === 'string' ? r.pdfPath : undefined,
    };
  },

  authorize(input) {
    return {
      target: 'pageindex',
      auditSummary: input.pdfPath?.slice(0, 100) ?? '(no path)',
      notifySummary: `indexed ${input.pdfPath?.slice(0, 80) ?? '(no path)'}`,
      // Full raw request staged so an /approve replay carries pdfPath
      // and friends — a thin {type} payload deterministically fails
      // replay (runPageindexIndex rejects a missing pdfPath).
      payloadForStaging: { type: 'pageindex_index', ...input.raw },
      // Batch 4 closure: writes go through the gate. Agents need a
      // trust.yaml `pageindex_index` entry (all 9 ship `autonomous`);
      // non-agent callers pass via NON_AGENT_DECISION.
    };
  },

  async execute(input, ctx): Promise<ExecuteResult> {
    const mounts = resolveMountsForGroup(ctx);
    const result = await runPageindexIndex(input.raw, mounts);
    return { executed: true, result };
  },
};
