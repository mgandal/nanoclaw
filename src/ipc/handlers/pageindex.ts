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
 * Trust shape:
 *   The if-ladder bypassed the gate for both actions. Rule 5 preserves
 *   that via skipGate. pageindex_fetch is already on SKIP_GATE_ALLOWLIST
 *   as read-only; pageindex_index is a write, added to the allowlist with
 *   a TODO(Batch4) marker so closing the bypass is deliberate future work.
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
      payloadForStaging: { type: 'pageindex_index' },
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
