import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import {
  fetchPageRange,
  indexPdf,
  resolveContainerPath,
  type MountMapping,
} from './pageindex.js';

export type PageindexResult = Record<string, unknown>;

/**
 * Resolve a container-side path and check existence. Shared helper used by
 * both pageindex actions.
 */
function resolveAndExists(
  pdfPath: string,
  mounts: MountMapping[],
): { ok: true; hostPath: string } | { ok: false; result: PageindexResult } {
  const hostPath = resolveContainerPath(pdfPath, mounts);
  if (!hostPath) {
    return {
      ok: false,
      result: { success: false, error: `Cannot resolve path: ${pdfPath}` },
    };
  }
  if (!fs.existsSync(hostPath)) {
    return {
      ok: false,
      result: { success: false, error: `File not found: ${pdfPath}` },
    };
  }
  return { ok: true, hostPath };
}

/**
 * Fetch a page range from a PDF and return the result payload.
 *
 * Two callers consume this seam: legacy {@link handlePageindexIpc} and the
 * new pageindexFetchHandler in src/ipc/handlers/pageindex.ts.
 */
export async function runPageindexFetch(
  data: Record<string, unknown>,
  mounts: MountMapping[],
): Promise<PageindexResult> {
  const pdfPath = data.pdfPath as string | undefined;
  const startPage = data.startPage as number | undefined;
  const endPage = data.endPage as number | undefined;

  if (!pdfPath || startPage == null || endPage == null) {
    return {
      success: false,
      error: 'Missing required fields: pdfPath, startPage, endPage',
    };
  }

  const resolved = resolveAndExists(pdfPath, mounts);
  if (!resolved.ok) return resolved.result;

  try {
    const text = await fetchPageRange(resolved.hostPath, startPage, endPage);
    return { success: true, text };
  } catch (err) {
    logger.error({ err, pdfPath }, 'pageindex_fetch error');
    return {
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Index a PDF (build a hierarchical tree) and return the result payload.
 */
export async function runPageindexIndex(
  data: Record<string, unknown>,
  mounts: MountMapping[],
): Promise<PageindexResult> {
  const pdfPath = data.pdfPath as string | undefined;
  if (!pdfPath) {
    return { success: false, error: 'Missing required field: pdfPath' };
  }

  const resolved = resolveAndExists(pdfPath, mounts);
  if (!resolved.ok) return resolved.result;

  try {
    const fileName = path.basename(resolved.hostPath);
    const vaultDir = path.dirname(resolved.hostPath);
    const result = await indexPdf(resolved.hostPath, fileName, { vaultDir });

    if (result.success) {
      return {
        success: true,
        tree: result.tree,
        pageCount: result.pageCount,
      };
    }
    return {
      success: false,
      error: result.error,
      fallbackText: result.fallbackText,
      pageCount: result.pageCount,
    };
  } catch (err) {
    logger.error({ err, pdfPath }, 'pageindex_index error');
    return {
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Legacy library entry point. Validates requestId, dispatches to the
 * appropriate runner, writes the result file. Retained for the
 * pageindex-ipc.test.ts harness (which passes a pre-built mounts array).
 *
 * The dispatcher-driven path lives in src/ipc/handlers/pageindex.ts; the
 * registry handler resolves mounts in execute() using ctx.registeredGroups,
 * matching the if-ladder's behaviour exactly.
 */
export async function handlePageindexIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
  mounts: MountMapping[],
): Promise<boolean> {
  const type = data.type as string;

  if (!type.startsWith('pageindex_')) {
    return false;
  }

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn(
      { type, sourceGroup, requestId },
      'pageindex IPC invalid requestId',
    );
    return true;
  }

  let result: PageindexResult;
  if (type === 'pageindex_fetch') {
    result = await runPageindexFetch(data, mounts);
  } else if (type === 'pageindex_index') {
    result = await runPageindexIndex(data, mounts);
  } else {
    logger.warn({ type, sourceGroup }, 'Unknown pageindex IPC subtype');
    return false;
  }

  const resultsDir = path.join(
    dataDir,
    'ipc',
    sourceGroup,
    'pageindex_results',
  );
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const tmpFile = `${resultFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(result));
  fs.renameSync(tmpFile, resultFile);

  logger.info({ type, requestId, sourceGroup }, 'pageindex IPC handled');
  return true;
}
