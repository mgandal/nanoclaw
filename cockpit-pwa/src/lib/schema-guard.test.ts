import { describe, it, expect } from 'vitest';
import { checkSchema } from './schema-guard.js';
import type { Snapshot } from '../types.js';

const baseSnap = (version: number): Snapshot => ({
  generated_at: '2026-04-21T12:00:00Z',
  schema_version: version,
  groups: [],
  tasks: [],
  ingestion: {
    emails: { count_24h: 0, last_at: null, recent: [] },
    papers: { count_24h: 0, last_at: null, recent: [] },
    vault: { count_24h: 0, last_at: null, recent: [] },
  },
  watchlists: [],
  blogs: null,
  priorities: [],
  vault_tree: { name: 'vault', path: '', kind: 'dir', children: [] },
  vault_pages_available: [],
});

describe('checkSchema', () => {
  it('returns match=true when snapshot.schema_version equals expected', () => {
    const r = checkSchema(baseSnap(1), 1);
    expect(r.match).toBe(true);
  });

  it('returns match=false with got/expected when versions differ', () => {
    const r = checkSchema(baseSnap(2), 1);
    expect(r.match).toBe(false);
    if (!r.match) {
      expect(r.got).toBe(2);
      expect(r.expected).toBe(1);
    }
  });
});
