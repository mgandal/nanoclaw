import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { queryKg } from './kg.js';

let dbPath: string;

function seedMiniGraph(db: Database): void {
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      type TEXT NOT NULL,
      metadata TEXT,
      source_doc TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE aliases (
      alias TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (alias, entity_type, entity_id)
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      evidence TEXT,
      source_doc TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_by TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL
    );
  `);

  const ins = db.prepare(
    "INSERT INTO entities (id, canonical_name, type, metadata, source_doc, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?, ?, datetime('now'), datetime('now'))",
  );
  const al = db.prepare("INSERT INTO aliases VALUES (?, ?, ?, 'test')");
  const ed = db.prepare(
    "INSERT INTO edges (id, source_id, target_id, relation, evidence, source_doc, confidence, created_by, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, 1.0, 'test', ?, datetime('now'))",
  );

  ins.run('e-rachel', 'Rachel Smith', 'person', 'contacts/rachel.md', 1.0, 'main');
  ins.run('e-braingo', 'BrainGO', 'project', 'state/projects.md', 1.0, 'main');
  ins.run('e-apa', 'APA', 'project', 'state/projects.md', 1.0, 'main');
  ins.run('e-grant', 'R01-MH137578', 'grant', 'state/grants.md', 1.0, 'main');
  ins.run(
    'e-paper',
    'Smith 2026 (Nature)',
    'paper',
    'wiki/papers/smith.md',
    1.0,
    'main',
  );
  ins.run('e-miao', 'Miao Tang', 'person', 'contacts/miao.md', 0.7, 'main');

  al.run('Rachel Smith', 'person', 'e-rachel');
  al.run('Smith, Rachel', 'person', 'e-rachel');
  al.run('R. Smith', 'person', 'e-rachel');
  al.run('BrainGO', 'project', 'e-braingo');
  al.run('APA', 'project', 'e-apa');
  al.run('R01-MH137578', 'grant', 'e-grant');
  al.run('Miao Tang', 'person', 'e-miao');

  ed.run(
    'ed-1',
    'e-rachel',
    'e-braingo',
    'member_of',
    'projects[]',
    'contacts/rachel.md',
    'main',
  );
  ed.run(
    'ed-2',
    'e-rachel',
    'e-apa',
    'member_of',
    'projects[]',
    'contacts/rachel.md',
    'main',
  );
  ed.run(
    'ed-3',
    'e-rachel',
    'e-paper',
    'authored',
    'first_author',
    'wiki/papers/smith.md',
    'main',
  );
  ed.run(
    'ed-4',
    'e-grant',
    'e-apa',
    'funds_project',
    'grant line',
    'state/projects.md',
    'main',
  );
  ed.run(
    'ed-5',
    'e-miao',
    'e-apa',
    'member_of',
    'projects[]',
    'contacts/miao.md',
    'main',
  );
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
  dbPath = path.join(tmp, 'kg.db');
  const db = new Database(dbPath);
  try {
    seedMiniGraph(db);
  } finally {
    db.close();
  }
});

describe('queryKg', () => {
  it('returns matched entities and their 1-hop neighbors by default', () => {
    const result = queryKg(dbPath, { query: 'Rachel Smith' });
    expect(result.success).toBe(true);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].canonical_name).toBe('Rachel Smith');
    const names = new Set(result.neighbors.map((n) => n.canonical_name));
    expect(names.has('BrainGO')).toBe(true);
    expect(names.has('APA')).toBe(true);
    expect(names.has('Smith 2026 (Nature)')).toBe(true);
  });

  it('matches by alias, not just canonical name', () => {
    const result = queryKg(dbPath, { query: 'Smith, Rachel' });
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].canonical_name).toBe('Rachel Smith');
  });

  it('filters matched by entity_type', () => {
    const result = queryKg(dbPath, {
      query: 'Rachel',
      entity_type: 'project',
    });
    expect(result.matched).toHaveLength(0);
  });

  it('hops=0 returns matched only, no neighbors', () => {
    const result = queryKg(dbPath, { query: 'Rachel Smith', hops: 0 });
    expect(result.matched).toHaveLength(1);
    expect(result.neighbors).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('hops=2 reaches 2-hop neighbors', () => {
    const result = queryKg(dbPath, { query: 'Rachel Smith', hops: 2 });
    const names = new Set(result.neighbors.map((n) => n.canonical_name));
    expect(names.has('R01-MH137578')).toBe(true);
    expect(names.has('Miao Tang')).toBe(true);
  });

  it('caps hops at 3 (defensive)', () => {
    const result = queryKg(dbPath, { query: 'Rachel Smith', hops: 99 });
    expect(result.success).toBe(true);
  });

  it('filters neighbors by relation_type', () => {
    const result = queryKg(dbPath, {
      query: 'Rachel Smith',
      relation_type: 'authored',
    });
    const relations = new Set(result.edges.map((e) => e.relation));
    expect(relations).toEqual(new Set(['authored']));
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0].canonical_name).toBe('Smith 2026 (Nature)');
  });

  it('returns empty on unknown query', () => {
    const result = queryKg(dbPath, { query: 'Nobody' });
    expect(result.success).toBe(true);
    expect(result.matched).toEqual([]);
    expect(result.neighbors).toEqual([]);
  });

  it('respects match limit', () => {
    const result = queryKg(dbPath, { query: 'Smith', limit: 1 });
    expect(result.matched.length).toBeLessThanOrEqual(1);
  });

  it('traversal is bidirectional — reverse edges followed', () => {
    const result = queryKg(dbPath, {
      query: 'R01-MH137578',
      hops: 2,
    });
    const names = new Set(result.neighbors.map((n) => n.canonical_name));
    expect(names.has('APA')).toBe(true);
    expect(names.has('Rachel Smith')).toBe(true);
    expect(names.has('Miao Tang')).toBe(true);
  });

  it('fails gracefully when DB does not exist', () => {
    const result = queryKg('/nonexistent/kg.db', { query: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('entity confidence preserved in output', () => {
    const result = queryKg(dbPath, { query: 'Miao Tang' });
    expect(result.matched[0].confidence).toBe(0.7);
  });

  it('main caller sees main + public + any group entities', () => {
    const db = new Database(dbPath);
    try {
      const ins = db.prepare(
        "INSERT INTO entities (id, canonical_name, type, metadata, source_doc, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, 1.0, ?, datetime('now'), datetime('now'))",
      );
      const al = db.prepare("INSERT INTO aliases VALUES (?, ?, ?, 'test')");
      ins.run('e-mo-main', 'MainOnly', 'topic', 'state/a.md', 'main');
      ins.run('e-mo-pub', 'MainOnly', 'topic', 'state/b.md', 'public');
      ins.run('e-mo-lab', 'MainOnly', 'topic', 'state/c.md', 'telegram_lab-claw');
      al.run('MainOnly', 'topic', 'e-mo-main');
      al.run('MainOnly', 'topic', 'e-mo-pub');
      al.run('MainOnly', 'topic', 'e-mo-lab');
    } finally {
      db.close();
    }
    const result = queryKg(dbPath, {
      query: 'MainOnly',
      callerGroup: 'telegram_claire',
      callerIsMain: true,
    });
    const ids = new Set(result.matched.map((m) => m.id));
    expect(ids.has('e-mo-main')).toBe(true);
    expect(ids.has('e-mo-pub')).toBe(true);
    expect(ids.has('e-mo-lab')).toBe(true);
  });

  it('non-main caller sees only public + own-group entities (no main)', () => {
    const db = new Database(dbPath);
    try {
      const ins = db.prepare(
        "INSERT INTO entities (id, canonical_name, type, metadata, source_doc, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, 1.0, ?, datetime('now'), datetime('now'))",
      );
      const al = db.prepare("INSERT INTO aliases VALUES (?, ?, ?, 'test')");
      ins.run('e-sh-main', 'Shared', 'topic', 'state/a.md', 'main');
      ins.run('e-sh-pub', 'Shared', 'topic', 'state/b.md', 'public');
      ins.run('e-sh-lab', 'Shared', 'topic', 'state/c.md', 'telegram_lab-claw');
      ins.run('e-sh-code', 'Shared', 'topic', 'state/d.md', 'telegram_code-claw');
      al.run('Shared', 'topic', 'e-sh-main');
      al.run('Shared', 'topic', 'e-sh-pub');
      al.run('Shared', 'topic', 'e-sh-lab');
      al.run('Shared', 'topic', 'e-sh-code');
    } finally {
      db.close();
    }
    const result = queryKg(dbPath, {
      query: 'Shared',
      callerGroup: 'telegram_lab-claw',
      callerIsMain: false,
    });
    const ids = new Set(result.matched.map((m) => m.id));
    expect(ids.has('e-sh-pub')).toBe(true);
    expect(ids.has('e-sh-lab')).toBe(true);
    expect(ids.has('e-sh-main')).toBe(false);
    expect(ids.has('e-sh-code')).toBe(false);
  });

  it('neighbor traversal respects visibility', () => {
    const db = new Database(dbPath);
    try {
      const ins = db.prepare(
        "INSERT INTO entities (id, canonical_name, type, metadata, source_doc, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, 1.0, ?, datetime('now'), datetime('now'))",
      );
      const al = db.prepare("INSERT INTO aliases VALUES (?, ?, ?, 'test')");
      const ed = db.prepare(
        "INSERT INTO edges (id, source_id, target_id, relation, evidence, source_doc, confidence, created_by, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, 1.0, 'test', ?, datetime('now'))",
      );
      ins.run('e-seed', 'seed', 'topic', 'state/seed.md', 'public');
      ins.run('e-reach', 'reachable', 'topic', 'state/reach.md', 'public');
      ins.run('e-hidden', 'hidden', 'topic', 'state/hidden.md', 'main');
      al.run('seed', 'topic', 'e-seed');
      al.run('reachable', 'topic', 'e-reach');
      al.run('hidden', 'topic', 'e-hidden');
      ed.run(
        'ed-pub',
        'e-seed',
        'e-reach',
        'relates_to',
        'pub-ev',
        'state/seed.md',
        'public',
      );
      ed.run(
        'ed-main',
        'e-seed',
        'e-hidden',
        'relates_to',
        'main-ev',
        'state/seed.md',
        'main',
      );
    } finally {
      db.close();
    }
    const result = queryKg(dbPath, {
      query: 'seed',
      hops: 1,
      callerGroup: 'telegram_lab-claw',
      callerIsMain: false,
    });
    const neighborNames = new Set(
      result.neighbors.map((n) => n.canonical_name),
    );
    expect(neighborNames.has('reachable')).toBe(true);
    expect(neighborNames.has('hidden')).toBe(false);
    const edgeKeys = new Set(
      result.edges.map((e) => `${e.source_id}->${e.target_id}`),
    );
    expect(edgeKeys.has('e-seed->e-reach')).toBe(true);
    expect(edgeKeys.has('e-seed->e-hidden')).toBe(false);
  });
});
