import { describe, it, expect } from 'vitest';
import { sortTasks } from './cron-sort.js';
import type { TaskSnapshot } from '../types.js';

function makeTask(partial: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: 't',
    group: 'g',
    name: 'task',
    schedule_raw: '0 * * * *',
    schedule_human: 'every hour',
    last_run: null,
    last_status: null,
    last_result_excerpt: null,
    next_run: null,
    success_7d: [0, 0],
    consecutive_failures: 0,
    ...partial,
  };
}

describe('sortTasks', () => {
  it('puts tasks with consecutive_failures first, highest first', () => {
    const sorted = sortTasks([
      makeTask({ id: 'ok', consecutive_failures: 0 }),
      makeTask({ id: 'cf3', consecutive_failures: 3 }),
      makeTask({ id: 'cf1', consecutive_failures: 1 }),
    ]);
    expect(sorted.map(t => t.id)).toEqual(['cf3', 'cf1', 'ok']);
  });

  it('after consecutive_failures, tasks with last_status=error come before skipped come before others', () => {
    const sorted = sortTasks([
      makeTask({ id: 'success', last_status: 'success' }),
      makeTask({ id: 'skipped', last_status: 'skipped' }),
      makeTask({ id: 'error', last_status: 'error' }),
      makeTask({ id: 'null', last_status: null }),
    ]);
    expect(sorted.map(t => t.id)).toEqual(['error', 'skipped', 'success', 'null']);
  });

  it('after status, sorts by next_run ascending with nulls last', () => {
    const sorted = sortTasks([
      makeTask({ id: 'nullrun', next_run: null }),
      makeTask({ id: 'later', next_run: '2026-04-21T14:00:00Z' }),
      makeTask({ id: 'sooner', next_run: '2026-04-21T12:00:00Z' }),
    ]);
    expect(sorted.map(t => t.id)).toEqual(['sooner', 'later', 'nullrun']);
  });

  it('respects all four rules in combination', () => {
    const sorted = sortTasks([
      makeTask({ id: 'healthy-soon', next_run: '2026-04-21T12:00:00Z' }),
      makeTask({ id: 'err-later', last_status: 'error', next_run: '2026-04-21T18:00:00Z' }),
      makeTask({ id: 'cf2', consecutive_failures: 2, last_status: 'error' }),
      makeTask({ id: 'skipped-now', last_status: 'skipped', next_run: '2026-04-21T11:00:00Z' }),
    ]);
    expect(sorted.map(t => t.id)).toEqual(['cf2', 'err-later', 'skipped-now', 'healthy-soon']);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeTask({ id: 'a', consecutive_failures: 0 }),
      makeTask({ id: 'b', consecutive_failures: 5 }),
    ];
    const snapshot = input.map(t => t.id);
    sortTasks(input);
    expect(input.map(t => t.id)).toEqual(snapshot);
  });
});
