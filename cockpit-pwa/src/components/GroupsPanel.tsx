import type { GroupSnapshot } from '../types.js';

interface Props {
  groups: GroupSnapshot[];
}

export function GroupsPanel({ groups }: Props) {
  if (groups.length === 0) return null;
  return (
    <section class="groups-panel">
      <h2>Groups</h2>
      <ul>
        {groups.map(g => (
          <li key={g.folder} class="group-row">
            <span class="name">{g.display_name}</span>
            <span class="messages">{g.messages_24h}</span>
            <span class="last-active">{g.last_active_at ?? '—'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
