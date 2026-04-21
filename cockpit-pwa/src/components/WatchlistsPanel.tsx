import { useState } from 'preact/hooks';
import type { WatchlistGroup } from '../types.js';

interface Props {
  watchlists: WatchlistGroup[];
}

export function WatchlistsPanel({ watchlists }: Props) {
  const [filter, setFilter] = useState<string>('__all__');
  if (watchlists.length === 0) return null;

  const scopes = watchlists.map(w => w.scope_name);
  const visible = filter === '__all__' ? watchlists : watchlists.filter(w => w.scope_name === filter);

  return (
    <section class="watchlists-panel">
      <h2>Watchlists</h2>
      <div class="chips">
        <button
          class={`chip${filter === '__all__' ? ' active' : ''}`}
          onClick={() => setFilter('__all__')}
        >
          All
        </button>
        {scopes.map(s => (
          <button
            key={s}
            class={`chip${filter === s ? ' active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {visible.map(w => (
        <div key={`${w.scope}:${w.scope_name}`} class="watchlist-group">
          <h3>{w.scope_name}</h3>
          <ul>
            {w.items.map((item, i) => (
              <li key={i}>
                {item.url ? (
                  <a href={item.url} rel="noopener noreferrer" target="_blank">{item.title}</a>
                ) : (
                  <span>{item.title}</span>
                )}
                {item.note && <span class="note"> — {item.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
