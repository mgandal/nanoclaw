// Knowledge Graph query layer.
//
// Provides read-only traversal over store/knowledge-graph.db produced by
// scripts/kg/ingest_phase1.py. Exposed to agents as the `kg_query` MCP tool
// via src/kg-ipc.ts.

import { Database } from 'bun:sqlite';
import fs from 'fs';

const MAX_HOPS = 3;
const DEFAULT_LIMIT = 20;

export interface KgQueryInput {
  query: string;
  entity_type?: string;
  relation_type?: string;
  hops?: number;
  limit?: number;
  from_entity_id?: string;
  callerGroup?: string;
  callerIsMain?: boolean;
}

export interface KgEntity {
  id: string;
  canonical_name: string;
  type: string;
  confidence: number;
  source_doc: string | null;
}

export interface KgEdge {
  source_id: string;
  target_id: string;
  relation: string;
  evidence: string | null;
}

export interface KgQueryResult {
  success: boolean;
  error?: string;
  matched: KgEntity[];
  neighbors: KgEntity[];
  edges: KgEdge[];
}

function normalizeHops(n: number | undefined): number {
  if (n === undefined || n === null) return 1;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_HOPS);
}

function normalizeLimit(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), 100);
}

/**
 * Build a visibility WHERE clause fragment for entity/edge SELECTs. Main
 * callers see everything (no filter). Non-main callers see rows whose
 * visibility is 'public' or equal to their own group_folder. Callers with
 * no context at all (neither callerIsMain nor callerGroup) are denied by
 * pinning visibility to a sentinel-impossible value — this is a fail-safe
 * that catches forgotten plumbing at call sites.
 */
function visibilityClause(
  column: string,
  input: KgQueryInput,
): { clause: string; params: string[] } {
  if (input.callerIsMain) return { clause: '', params: [] };
  if (!input.callerGroup) {
    // Fail-safe: no caller context -> return only a sentinel-impossible value.
    // IPC call sites always supply callerGroup; direct in-process
    // callers must opt in explicitly.
    return { clause: `AND ${column} = ?`, params: ['__none__'] };
  }
  return {
    clause: `AND ${column} IN (?, ?)`,
    params: ['public', input.callerGroup],
  };
}

/**
 * Find matched entities by canonical name (exact) or alias match (scoped by
 * entity_type if provided). Case-insensitive on alias lookup.
 */
function findMatched(
  db: Database,
  input: KgQueryInput,
  limit: number,
): KgEntity[] {
  if (input.from_entity_id) {
    const vis = visibilityClause('visibility', input);
    const row = db
      .prepare(
        `SELECT id, canonical_name, type, confidence, source_doc FROM entities
         WHERE id = ? ${vis.clause}`,
      )
      .get(input.from_entity_id, ...vis.params) as KgEntity | undefined;
    return row ? [row] : [];
  }

  const q = input.query.trim();
  if (!q) return [];

  const params: (string | number)[] = [];
  const typeClause = input.entity_type ? 'AND e.type = ?' : '';
  if (input.entity_type) params.push(input.entity_type);

  const vis = visibilityClause('e.visibility', input);

  // Union of exact canonical match + alias match, scoped by type filter.
  const sql = `
    SELECT DISTINCT e.id, e.canonical_name, e.type, e.confidence, e.source_doc
    FROM entities e
    WHERE (
      e.canonical_name = ?
      OR e.id IN (SELECT entity_id FROM aliases WHERE alias = ?)
    )
    ${typeClause}
    ${vis.clause}
    LIMIT ?
  `;
  const all = db
    .prepare(sql)
    .all(q, q, ...params, ...vis.params, limit) as KgEntity[];
  return all;
}

/**
 * Bidirectional BFS from seed IDs out to maxHops. Applies optional
 * relation_type filter on each edge traversal.
 */
function traverse(
  db: Database,
  seedIds: string[],
  maxHops: number,
  relationFilter: string | undefined,
  input: KgQueryInput,
): { neighbors: KgEntity[]; edges: KgEdge[] } {
  if (seedIds.length === 0 || maxHops === 0) {
    return { neighbors: [], edges: [] };
  }

  const visited = new Set<string>(seedIds);
  const collectedEdges: KgEdge[] = [];
  const neighborIds = new Set<string>();

  let frontier = new Set<string>(seedIds);
  const relClause = relationFilter ? 'AND relation = ?' : '';
  const relParam: string[] = relationFilter ? [relationFilter] : [];

  const edgeVis = visibilityClause('visibility', input);
  const entityVis = visibilityClause('visibility', input);

  const forward = db.prepare(
    `SELECT source_id, target_id, relation, evidence FROM edges
     WHERE source_id IN (SELECT value FROM json_each(?)) ${relClause} ${edgeVis.clause}`,
  );
  const reverse = db.prepare(
    `SELECT source_id, target_id, relation, evidence FROM edges
     WHERE target_id IN (SELECT value FROM json_each(?)) ${relClause} ${edgeVis.clause}`,
  );

  for (let hop = 0; hop < maxHops; hop++) {
    if (frontier.size === 0) break;
    const frontierJson = JSON.stringify([...frontier]);
    const nextFrontier = new Set<string>();

    for (const row of forward.all(
      frontierJson,
      ...relParam,
      ...edgeVis.params,
    ) as KgEdge[]) {
      collectedEdges.push(row);
      if (!visited.has(row.target_id)) {
        visited.add(row.target_id);
        neighborIds.add(row.target_id);
        nextFrontier.add(row.target_id);
      }
    }
    for (const row of reverse.all(
      frontierJson,
      ...relParam,
      ...edgeVis.params,
    ) as KgEdge[]) {
      collectedEdges.push(row);
      if (!visited.has(row.source_id)) {
        visited.add(row.source_id);
        neighborIds.add(row.source_id);
        nextFrontier.add(row.source_id);
      }
    }
    frontier = nextFrontier;
  }

  let neighbors: KgEntity[] = [];
  if (neighborIds.size > 0) {
    const idJson = JSON.stringify([...neighborIds]);
    neighbors = db
      .prepare(
        `SELECT id, canonical_name, type, confidence, source_doc FROM entities
         WHERE id IN (SELECT value FROM json_each(?)) ${entityVis.clause}`,
      )
      .all(idJson, ...entityVis.params) as KgEntity[];
  }

  // Deduplicate edges by id tuple (source,target,relation).
  const edgeKey = (e: KgEdge) => `${e.source_id}|${e.target_id}|${e.relation}`;
  const seen = new Set<string>();
  const dedupEdges = collectedEdges.filter((e) => {
    const k = edgeKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { neighbors, edges: dedupEdges };
}

export function queryKg(dbPath: string, input: KgQueryInput): KgQueryResult {
  if (!fs.existsSync(dbPath)) {
    return {
      success: false,
      error: `Knowledge graph DB not found at ${dbPath}. Run scripts/kg/ingest_phase1.py to seed it.`,
      matched: [],
      neighbors: [],
      edges: [],
    };
  }

  const hops = normalizeHops(input.hops);
  const limit = normalizeLimit(input.limit);

  const db = new Database(dbPath, { readonly: true });
  try {
    const matched = findMatched(db, input, limit);
    const seedIds = matched.map((m) => m.id);
    const { neighbors, edges } = traverse(
      db,
      seedIds,
      hops,
      input.relation_type,
      input,
    );
    return {
      success: true,
      matched,
      neighbors,
      edges,
    };
  } catch (err) {
    return {
      success: false,
      error: `KG query failed: ${err instanceof Error ? err.message : String(err)}`,
      matched: [],
      neighbors: [],
      edges: [],
    };
  } finally {
    db.close();
  }
}
