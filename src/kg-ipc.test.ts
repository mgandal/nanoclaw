import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { handleKgIpc } from './kg-ipc.js';

let tmpDir: string;
let dataDir: string;
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
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO entities VALUES (?, ?, ?, '{}', ?, 1.0, datetime('now'), datetime('now'))",
  ).run('e1', 'Rachel Smith', 'person', 'rachel.md');
  db.prepare("INSERT INTO aliases VALUES (?, ?, ?, 'test')").run(
    'Rachel Smith',
    'person',
    'e1',
  );
}

function readResult(groupFolder: string, requestId: string): unknown {
  const p = path.join(
    dataDir,
    'ipc',
    groupFolder,
    'kg_results',
    `${requestId}.json`,
  );
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-ipc-test-'));
  dataDir = path.join(tmpDir, 'data');
  dbPath = path.join(tmpDir, 'kg.db');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbPath);
  try {
    seedMiniGraph(db);
  } finally {
    db.close();
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleKgIpc', () => {
  it('returns false for non-kg_query types', async () => {
    const r = await handleKgIpc(
      { type: 'something_else' },
      'telegram_main',
      true,
      dataDir,
      dbPath,
    );
    expect(r).toBe(false);
  });

  it('rejects invalid requestId', async () => {
    const r = await handleKgIpc(
      { type: 'kg_query', requestId: '../evil', query: 'x' },
      'telegram_main',
      true,
      dataDir,
      dbPath,
    );
    expect(r).toBe(true);
    const resultsDir = path.join(dataDir, 'ipc', 'telegram_main', 'kg_results');
    const files = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir) : [];
    expect(files).toEqual([]);
  });

  it('writes success result for valid query', async () => {
    const r = await handleKgIpc(
      {
        type: 'kg_query',
        requestId: 'req-1',
        query: 'Rachel Smith',
      },
      'telegram_main',
      true,
      dataDir,
      dbPath,
    );
    expect(r).toBe(true);
    const result = readResult('telegram_main', 'req-1') as any;
    expect(result.success).toBe(true);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].canonical_name).toBe('Rachel Smith');
  });

  it('writes error result when query missing', async () => {
    const r = await handleKgIpc(
      { type: 'kg_query', requestId: 'req-2' },
      'telegram_main',
      true,
      dataDir,
      dbPath,
    );
    expect(r).toBe(true);
    const result = readResult('telegram_main', 'req-2') as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing required field/);
  });

  it('writes error result when DB is missing', async () => {
    const r = await handleKgIpc(
      {
        type: 'kg_query',
        requestId: 'req-3',
        query: 'Rachel',
      },
      'telegram_main',
      true,
      dataDir,
      '/nonexistent/kg.db',
    );
    expect(r).toBe(true);
    const result = readResult('telegram_main', 'req-3') as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('scopes result file by source group', async () => {
    await handleKgIpc(
      {
        type: 'kg_query',
        requestId: 'r-a',
        query: 'Rachel Smith',
      },
      'telegram_science-claw',
      false,
      dataDir,
      dbPath,
    );
    const p = path.join(
      dataDir,
      'ipc',
      'telegram_science-claw',
      'kg_results',
      'r-a.json',
    );
    expect(fs.existsSync(p)).toBe(true);
  });
});
