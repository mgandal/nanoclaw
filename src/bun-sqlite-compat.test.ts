/**
 * Bun SQLite Compatibility Tests
 *
 * These tests verify that bun:sqlite behaves correctly for every
 * DB pattern used in NanoClaw's db.ts. They exist as guardrails
 * against bun:sqlite behavior changes in future Bun upgrades.
 */
import { Database } from 'bun:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('bun:sqlite compatibility', () => {
  describe('basic operations', () => {
    it('handles multi-statement SQL via run()', () => {
      // NanoClaw's createSchema() passes a big multi-statement string
      db.run(`
        CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE test2 (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT);
        CREATE INDEX idx_ref ON test2(ref);
      `);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain('test');
      expect(tables.map((t) => t.name)).toContain('test2');
    });

    it('PRAGMA statements work via run()', () => {
      // NanoClaw replaced db.pragma() with db.exec('PRAGMA ...')
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA busy_timeout = 5000');
      db.run('PRAGMA foreign_keys = ON');

      const fk = db.prepare('PRAGMA foreign_keys').get() as {
        foreign_keys: number;
      };
      expect(fk.foreign_keys).toBe(1);
    });
  });

  describe('prepare/run/get/all with parameters', () => {
    beforeEach(() => {
      db.run(`
        CREATE TABLE messages (
          id TEXT, chat_jid TEXT, content TEXT, timestamp TEXT,
          is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
          PRIMARY KEY (id, chat_jid)
        );
      `);
    });

    it('run() with positional params', () => {
      db.prepare(
        'INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('msg1', 'chat1', 'hello', '2024-01-01T00:00:00Z', 0, 0);

      const row = db
        .prepare('SELECT * FROM messages WHERE id = ?')
        .get('msg1') as {
        content: string;
      };
      expect(row.content).toBe('hello');
    });

    it('run() with spread array', () => {
      // NanoClaw: updateTask() builds values array and spreads it
      const values: (string | number | null)[] = ['updated', 'msg1'];
      db.prepare(
        'INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?)',
      ).run('msg1', 'chat1', 'original', '2024-01-01', 0);

      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(...values);

      const row = db
        .prepare('SELECT content FROM messages WHERE id = ?')
        .get('msg1') as {
        content: string;
      };
      expect(row.content).toBe('updated');
    });

    it('all() with spread params including array expansion', () => {
      // NanoClaw: getNewMessages() uses .all(lastSeq, ...jids, botPrefix, limit)
      db.prepare(
        'INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?)',
      ).run('m1', 'chat1', 'hi', '2024-01-01', 0);
      db.prepare(
        'INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?)',
      ).run('m2', 'chat2', 'bye', '2024-01-02', 0);

      const jids = ['chat1', 'chat2'];
      const placeholders = jids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT * FROM messages WHERE chat_jid IN (${placeholders})`)
        .all(...jids) as { id: string }[];
      expect(rows.length).toBe(2);
    });

    it('get() returns null (not undefined) when no row matches', () => {
      // CRITICAL: bun:sqlite returns null, better-sqlite3 returned undefined
      const result = db
        .prepare('SELECT * FROM messages WHERE id = ?')
        .get('nonexistent');
      expect(result).toBeNull();
    });

    it('all() returns empty array when no rows match', () => {
      const result = db
        .prepare('SELECT * FROM messages WHERE id = ?')
        .all('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('null normalization pattern', () => {
    it('?? undefined converts null to undefined', () => {
      // NanoClaw's getTaskById() uses this pattern
      db.run('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT)');
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('nope');
      const normalized = row ?? undefined;
      expect(normalized).toBeUndefined();
    });

    it('optional chaining on null row works', () => {
      // NanoClaw's getRouterState() uses row?.value
      db.run('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
      const row = db
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get('missing') as {
        value: string;
      } | null;
      expect(row?.value).toBeUndefined();
    });

    it('!row catches both null and undefined', () => {
      // NanoClaw's getRegisteredGroup() uses if (!row) return undefined
      db.run('CREATE TABLE groups (jid TEXT PRIMARY KEY)');
      const row = db
        .prepare('SELECT * FROM groups WHERE jid = ?')
        .get('missing');
      expect(!row).toBe(true);
    });
  });

  describe('transactions', () => {
    it('transaction() returns a callable wrapper function', () => {
      // NanoClaw: migrateJsonState() uses const fn = db.transaction(() => {}); fn();
      db.run('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');

      const insertBatch = db.transaction(
        (items: { key: string; value: string }[]) => {
          for (const item of items) {
            db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(
              item.key,
              item.value,
            );
          }
        },
      );

      insertBatch([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ]);

      const count = db.prepare('SELECT COUNT(*) as c FROM kv').get() as {
        c: number;
      };
      expect(count.c).toBe(2);
    });

    it('transaction rolls back on error', () => {
      db.run('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');

      const badInsert = db.transaction(() => {
        db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('a', '1');
        throw new Error('rollback me');
      });

      try {
        badInsert();
      } catch {
        // expected
      }

      const count = db.prepare('SELECT COUNT(*) as c FROM kv').get() as {
        c: number;
      };
      expect(count.c).toBe(0);
    });
  });

  describe('error handling', () => {
    it('throws on duplicate ALTER TABLE column (idempotent migration pattern)', () => {
      // NanoClaw's addColumn() relies on catching this error
      db.run('CREATE TABLE test (id TEXT PRIMARY KEY)');
      db.run('ALTER TABLE test ADD COLUMN name TEXT');

      expect(() => {
        db.run('ALTER TABLE test ADD COLUMN name TEXT');
      }).toThrow();
    });
  });

  describe('INSERT OR REPLACE / ON CONFLICT', () => {
    it('INSERT OR REPLACE works', () => {
      // NanoClaw: setSession(), setRouterState()
      db.run('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
        'k',
        'v1',
      );
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
        'k',
        'v2',
      );

      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('k') as {
        value: string;
      };
      expect(row.value).toBe('v2');
    });

    it('ON CONFLICT DO UPDATE works', () => {
      // NanoClaw: storeChatMetadata()
      db.run('CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, ts TEXT)');
      db.prepare(
        `INSERT INTO chats (jid, name, ts) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
      ).run('j1', 'name1', '2024-01-01');
      db.prepare(
        `INSERT INTO chats (jid, name, ts) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
      ).run('j1', 'name2', '2024-01-02');

      const row = db
        .prepare('SELECT name FROM chats WHERE jid = ?')
        .get('j1') as {
        name: string;
      };
      expect(row.name).toBe('name2');
    });
  });

  describe('rowid and AUTOINCREMENT', () => {
    it('rowid is accessible in queries', () => {
      // NanoClaw: getNewMessages() uses rowid as monotonic sequence
      db.run('CREATE TABLE msgs (content TEXT)');
      db.prepare('INSERT INTO msgs (content) VALUES (?)').run('first');
      db.prepare('INSERT INTO msgs (content) VALUES (?)').run('second');

      const rows = db
        .prepare('SELECT rowid, content FROM msgs ORDER BY rowid')
        .all() as { rowid: number; content: string }[];
      expect(rows.length).toBe(2);
      expect(rows[0].rowid).toBe(1);
      expect(rows[1].rowid).toBe(2);
    });

    it('AUTOINCREMENT works', () => {
      // NanoClaw: task_run_logs table
      db.run(
        'CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT)',
      );
      db.prepare('INSERT INTO logs (msg) VALUES (?)').run('a');
      db.prepare('INSERT INTO logs (msg) VALUES (?)').run('b');

      const rows = db.prepare('SELECT id, msg FROM logs ORDER BY id').all() as {
        id: number;
        msg: string;
      }[];
      expect(rows[0].id).toBe(1);
      expect(rows[1].id).toBe(2);
    });
  });
});
