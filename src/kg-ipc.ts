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

  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'kg_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  const query = data.query as string | undefined;
  const fromEntityId = data.from_entity_id as string | undefined;
  if ((!query || typeof query !== 'string') && !fromEntityId) {
    writeResult({
      success: false,
      error: 'Missing required field: query (or from_entity_id)',
      matched: [],
      neighbors: [],
      edges: [],
    });
    return true;
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
    writeResult(result as unknown as Record<string, unknown>);
    logger.info(
      {
        type,
        requestId,
        sourceGroup,
        matched: result.matched.length,
        neighbors: result.neighbors.length,
      },
      'kg IPC handled',
    );
  } catch (err) {
    logger.error({ err, type, requestId }, 'kg IPC error');
    writeResult({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      matched: [],
      neighbors: [],
      edges: [],
    });
  }
  return true;
}
