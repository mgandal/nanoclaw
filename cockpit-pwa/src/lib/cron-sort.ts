import type { TaskSnapshot } from '../types.js';

/**
 * Sort tasks per spec §4:
 *   1. consecutive_failures > 0, descending
 *   2. last_status === 'error' first
 *   3. last_status === 'skipped' next
 *   4. next_run ascending, nulls last
 *
 * Returns a new array; does not mutate input.
 */
export function sortTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  const copy = [...tasks];
  copy.sort((a, b) => {
    // (1) consecutive_failures desc
    if (a.consecutive_failures !== b.consecutive_failures) {
      return b.consecutive_failures - a.consecutive_failures;
    }
    // (2, 3) status priority: error < skipped < success/null
    const rank = (s: TaskSnapshot['last_status']): number => {
      if (s === 'error') return 0;
      if (s === 'skipped') return 1;
      return 2;
    };
    const aRank = rank(a.last_status);
    const bRank = rank(b.last_status);
    if (aRank !== bRank) return aRank - bRank;

    // (4) next_run asc, nulls last
    if (a.next_run === null && b.next_run === null) return 0;
    if (a.next_run === null) return 1;
    if (b.next_run === null) return -1;
    return a.next_run.localeCompare(b.next_run);
  });
  return copy;
}
