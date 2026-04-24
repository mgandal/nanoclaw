import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, _closeDatabase } from './db.js';
import { addTask, closeTask, listTasks } from './tasks.js';

describe('tasks table operations', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  afterEach(() => {
    _closeDatabase();
  });

  describe('addTask', () => {
    it('inserts a minimal task and returns id', () => {
      const r = addTask({ title: 'Write plan' });
      expect(r.success).toBe(true);
      expect(r.id).toBeGreaterThan(0);
    });

    it('defaults owner to mike and lowercases owner input', () => {
      addTask({ title: 'X', owner: 'Liqing' });
      const rows = listTasks({});
      expect(rows[0].owner).toBe('liqing');

      addTask({ title: 'Y' });
      const all = listTasks({});
      const y = all.find((r) => r.title === 'Y')!;
      expect(y.owner).toBe('mike');
    });

    it('rejects duplicate open title case-insensitively', () => {
      const first = addTask({ title: 'Call Joe' });
      const second = addTask({ title: 'CALL JOE' });
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/duplicate/);
      expect(second.duplicate_of).toBe(first.id);
    });

    it('force=true still rejected by schema-level unique index', () => {
      // The partial unique index on lower(title) WHERE status='open' is the
      // hard guarantee; force bypasses the explicit SELECT check but the
      // schema still prevents two open rows with the same title. This is
      // stricter than v1 intended but matches the actual goal (no accidental
      // duplicates). Use archive+re-add semantics instead.
      const first = addTask({ title: 'Call Joe' });
      expect(first.success).toBe(true);
      const second = addTask({ title: 'Call Joe', force: true });
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/duplicate/);
      expect(second.duplicate_of).toBe(first.id);
    });

    it('allows same title after first was closed', () => {
      const first = addTask({ title: 'Call Joe' });
      closeTask({
        id: first.id,
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      const second = addTask({ title: 'Call Joe' });
      expect(second.success).toBe(true);
    });

    it('rejects invalid priority', () => {
      const r = addTask({ title: 'X', priority: 9 });
      expect(r.success).toBe(false);
    });

    it('rejects unknown source', () => {
      const r = addTask({ title: 'X', source: 'invented' });
      expect(r.success).toBe(false);
    });

    it('accepts migration-* source', () => {
      const r = addTask({
        title: 'X',
        source: 'migration-2026-04-23',
        source_ref: 'todo.md:1',
      });
      expect(r.success).toBe(true);
    });
  });

  describe('listTasks', () => {
    beforeEach(() => {
      addTask({ title: 'Overdue urgent', priority: 4, due_date: '2025-01-01' });
      addTask({ title: 'Normal mid', priority: 3 });
      addTask({ title: 'Low reading', priority: 1 });
      addTask({
        title: 'Low group-specific',
        priority: 2,
        group_folder: 'telegram_lab-claw',
      });
    });

    it('returns only open tasks by default', () => {
      const rows = listTasks({});
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.status === 'open')).toBe(true);
    });

    it('orders overdue before upcoming, then by priority desc', () => {
      const rows = listTasks({});
      expect(rows[0].title).toBe('Overdue urgent');
    });

    it('filters by group_folder', () => {
      const rows = listTasks({ group_folder: 'telegram_lab-claw' });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Low group-specific');
    });

    it('filters by due_before', () => {
      const rows = listTasks({ due_before: '2025-06-01' });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Overdue urgent');
    });

    it('returns done tasks when status=done', () => {
      const all = listTasks({});
      closeTask({
        id: all[0].id,
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(listTasks({ status: 'done' })).toHaveLength(1);
      expect(listTasks({})).toHaveLength(3);
    });
  });

  describe('closeTask', () => {
    it('closes as done with completed_at', () => {
      const added = addTask({ title: 'Finish draft' });
      const r = closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(r.success).toBe(true);
      expect(r.status).toBe('done');
      expect(r.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('closes as archived (separate outcome)', () => {
      const added = addTask({ title: 'Scope review' });
      const r = closeTask({
        id: added.id,
        outcome: 'archived',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(r.success).toBe(true);
      expect(r.status).toBe('archived');
    });

    it('resolves by title_match substring', () => {
      addTask({ title: 'Reply to Joe Buxbaum' });
      const r = closeTask({
        title_match: 'joe buxbaum',
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(r.success).toBe(true);
    });

    it('returns candidates when title_match is ambiguous', () => {
      addTask({ title: 'Email Lucy — paper draft' });
      addTask({ title: 'Email Lucy — cover letter' });
      const r = closeTask({
        title_match: 'email lucy',
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/ambiguous/);
      expect(r.candidates).toHaveLength(2);
    });

    it('reports no match when title_match has no hit', () => {
      const r = closeTask({
        title_match: 'nope',
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/no open task/);
    });

    it('denies close when caller is not creator group and not main', () => {
      const added = addTask({
        title: 'Group-scoped task',
        group_folder: 'telegram_lab-claw',
      });
      const r = closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_code-claw',
        callerIsMain: false,
      });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not authorized/);
    });

    it('allows main to close any group task', () => {
      const added = addTask({
        title: 'Group-scoped task',
        group_folder: 'telegram_lab-claw',
      });
      const r = closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(r.success).toBe(true);
    });

    it('allows creator group to close its own task', () => {
      const added = addTask({
        title: 'Group-scoped task',
        group_folder: 'telegram_lab-claw',
      });
      const r = closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_lab-claw',
        callerIsMain: false,
      });
      expect(r.success).toBe(true);
    });

    it('allows any group to close a global (group_folder NULL) task', () => {
      const added = addTask({ title: 'Global task' });
      const r = closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_lab-claw',
        callerIsMain: false,
      });
      expect(r.success).toBe(true);
    });

    it('returns race error on double-close attempt', () => {
      const added = addTask({ title: 'Race' });
      closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      const second = closeTask({
        id: added.id,
        outcome: 'done',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/no open task/);
    });

    it('appends reason to context', () => {
      const added = addTask({ title: 'With context', context: 'initial note' });
      closeTask({
        id: added.id,
        outcome: 'archived',
        reason: 'superseded',
        callerGroup: 'telegram_claire',
        callerIsMain: true,
      });
      const rows = listTasks({ status: 'archived' });
      expect(rows[0].context).toMatch(/initial note/);
      expect(rows[0].context).toMatch(/\[closed: superseded\]/);
    });
  });
});
