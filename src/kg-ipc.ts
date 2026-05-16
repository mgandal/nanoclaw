// IPC handler for `kg_query` agent requests.
//
// Agents send { type: 'kg_query', requestId, query, ... } via the IPC task
// mechanism. The host reads store/knowledge-graph.db and writes the result
// to data/ipc/{sourceGroup}/kg_results/{requestId}.json.

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { queryKg, type KgQueryInput } from './kg.js';

export const DEFAULT_KG_DB_PATH = path.join(
  process.cwd(),
  'store',
  'knowledge-graph.db',
);

export type KgQueryResult = Record<string, unknown>;

/**
 * Run a knowledge-graph query and return the result payload (no filesystem
 * side effects in the IPC results dir).
 *
 * Two callers consume this seam:
 *   1. {@link handleKgIpc} — legacy library entry point, writes the result
 *      to data/ipc/.../kg_results/{requestId}.json. Retained for the
 *      kg-ipc.test.ts harness (which passes a per-test dbPath override).
 *   2. `kgQueryHandler` (src/ipc/handlers/kg-query.ts) — new registered
 *      IPC handler. Reads the default DB path; the dispatcher writes the
 *      result file (Rule 1).
 *
 * Returns the failure shape `{success:false, error, matched:[],
 * neighbors:[], edges:[]}` for missing required fields or thrown errors,
 * matching the legacy on-disk schema.
 */
export function runKgQuery(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dbPath: string,
): KgQueryResult {
  const query = data.query as string | undefined;
  const fromEntityId = data.from_entity_id as string | undefined;
  if ((!query || typeof query !== 'string') && !fromEntityId) {
    return {
      success: false,
      error: 'Missing required field: query (or from_entity_id)',
      matched: [],
      neighbors: [],
      edges: [],
    };
  }

  const input: KgQueryInput = {
    query: query ?? '',
    entity_type: data.entity_type as string | undefined,
    relation_type: data.relation_type as string | undefined,
    hops: data.hops as number | undefined,
    limit: data.limit as number | undefined,
    from_entity_id: fromEntityId,
    callerGroup: sourceGroup,
    callerIsMain: isMain,
  };

  try {
    const result = queryKg(dbPath, input);
    logger.info(
      {
        sourceGroup,
        matched: result.matched.length,
        neighbors: result.neighbors.length,
      },
      'kg query handled',
    );
    return result as unknown as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, sourceGroup }, 'kg query error');
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      matched: [],
      neighbors: [],
      edges: [],
    };
  }
}

/**
 * Legacy library entry point. Validates requestId, computes the result
 * via {@link runKgQuery}, writes to dataDir/ipc/.../kg_results/.
 *
 * The new dispatcher-driven path lives in src/ipc/handlers/kg-query.ts
 * and is registered through the IpcHandler registry. This function is
 * retained for the kg-ipc test harness (which needs the dbPath override
 * to inject a per-test temp DB). The if-ladder caller has been removed.
 */
export async function handleKgIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
  dbPath: string = DEFAULT_KG_DB_PATH,
): Promise<boolean> {
  const type = data.type as string;
  if (type !== 'kg_query') return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    logger.warn({ type, sourceGroup, requestId }, 'kg IPC invalid requestId');
    return true;
  }

  const result = runKgQuery(data, sourceGroup, isMain, dbPath);

  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'kg_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const tmpFile = `${resultFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(result));
  fs.renameSync(tmpFile, resultFile);

  logger.info({ type, requestId, sourceGroup }, 'kg IPC handled');
  return true;
}
