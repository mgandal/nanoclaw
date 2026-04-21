import type { Snapshot } from '../types.js';

/**
 * Fetch and validate the snapshot from the Worker. Throws descriptive errors
 * for each failure mode so the UI can surface them rather than silently showing
 * a blank dashboard.
 */
export async function fetchSnapshot(origin: string): Promise<Snapshot> {
  const url = `${origin}/data/snapshot.json`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`snapshot fetch failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`snapshot parse failed: ${String(err)}`);
  }

  if (!isSnapshotShape(parsed)) {
    throw new Error('snapshot is malformed: missing required fields');
  }
  return parsed;
}

function isSnapshotShape(x: unknown): x is Snapshot {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.generated_at === 'string' &&
    typeof o.schema_version === 'number' &&
    Array.isArray(o.groups) &&
    Array.isArray(o.tasks) &&
    typeof o.ingestion === 'object' && o.ingestion !== null &&
    Array.isArray(o.watchlists) &&
    (o.blogs === null || Array.isArray(o.blogs)) &&
    Array.isArray(o.priorities) &&
    typeof o.vault_tree === 'object' && o.vault_tree !== null &&
    Array.isArray(o.vault_pages_available)
  );
}
