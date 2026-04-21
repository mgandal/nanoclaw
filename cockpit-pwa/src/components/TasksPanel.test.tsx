import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { TasksPanel } from './TasksPanel.js';
import type { TaskSnapshot } from '../types.js';

function task(partial: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: 't', group: 'g', name: 'task',
    schedule_raw: '0 * * * *', schedule_human: 'every hour',
    last_run: null, last_status: null, last_result_excerpt: null,
    next_run: null, success_7d: [0, 0], consecutive_failures: 0,
    ...partial,
  };
}

describe('TasksPanel', () => {
  it('renders each task row with its name', () => {
    const tasks = [task({ id: 'a', name: 'Morning brief' }), task({ id: 'b', name: 'Sync' })];
    render(<TasksPanel tasks={tasks} />);
    expect(screen.getByText('Morning brief')).toBeTruthy();
    expect(screen.getByText('Sync')).toBeTruthy();
  });

  it('sorts via the cron-sort rules: consecutive failures first', () => {
    const tasks = [
      task({ id: 'ok', name: 'Healthy' }),
      task({ id: 'fail', name: 'Failing', consecutive_failures: 3, last_status: 'error' }),
    ];
    render(<TasksPanel tasks={tasks} />);
    const rows = Array.from(document.querySelectorAll('.task-row'));
    expect(rows[0].textContent).toContain('Failing');
    expect(rows[1].textContent).toContain('Healthy');
  });

  it('adds a red-border class + failure chip when consecutive_failures >= 2', () => {
    const tasks = [task({ id: 'x', name: 'Broken', consecutive_failures: 4, last_status: 'error' })];
    render(<TasksPanel tasks={tasks} />);
    const row = document.querySelector('.task-row');
    expect(row?.className).toContain('alert');
    expect(row?.textContent).toMatch(/4 failures/i);
  });

  it('renders nothing when tasks is empty', () => {
    const { container } = render(<TasksPanel tasks={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
