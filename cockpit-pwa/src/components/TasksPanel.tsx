import type { TaskSnapshot } from '../types.js';
import { sortTasks } from '../lib/cron-sort.js';

interface Props {
  tasks: TaskSnapshot[];
}

export function TasksPanel({ tasks }: Props) {
  if (tasks.length === 0) return null;
  const sorted = sortTasks(tasks);
  return (
    <section class="tasks-panel">
      <h2>Scheduled tasks</h2>
      <ul>
        {sorted.map(t => {
          const alert = t.consecutive_failures >= 2;
          return (
            <li key={t.id} class={`task-row${alert ? ' alert' : ''}`}>
              <span class="name">{t.name}</span>
              <span class="schedule">{t.schedule_human}</span>
              <span class="status">{t.last_status ?? '—'}</span>
              {alert && <span class="chip">⚠ {t.consecutive_failures} failures</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
