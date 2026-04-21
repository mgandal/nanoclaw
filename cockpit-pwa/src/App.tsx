import { useEffect, useState } from 'preact/hooks';
import { fetchSnapshot } from './lib/snapshot-fetch.js';
import { checkSchema } from './lib/schema-guard.js';
import { SCHEMA_VERSION, type Snapshot } from './types.js';
import { StalenessBanner } from './components/StalenessBanner.js';
import { PrioritiesStrip } from './components/PrioritiesStrip.js';
import { GroupsPanel } from './components/GroupsPanel.js';
import { TasksPanel } from './components/TasksPanel.js';
import { IngestionPanel } from './components/IngestionPanel.js';
import { BlogsPanel } from './components/BlogsPanel.js';
import { WatchlistsPanel } from './components/WatchlistsPanel.js';
import { VaultFeed } from './components/VaultFeed.js';
import { VaultTree } from './components/VaultTree.js';
import { VaultPage } from './components/VaultPage.js';

type Route =
  | { name: 'home' }
  | { name: 'vault' }
  | { name: 'vault-page'; slug: string };

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#/, '');
  if (clean === '/vault') return { name: 'vault' };
  const m = clean.match(/^\/vault\/(.+)$/);
  if (m) return { name: 'vault-page', slug: m[1] };
  return { name: 'home' };
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parseHash(window.location.hash));

  useEffect(() => {
    fetchSnapshot(window.location.origin)
      .then(setSnap)
      .catch(e => setErr(String(e)));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (err) return <p class="load-error">Error loading snapshot: {err}</p>;
  if (!snap) return <p class="loading">Loading snapshot…</p>;

  const schema = checkSchema(snap, SCHEMA_VERSION);
  const now = new Date();

  return (
    <main>
      <StalenessBanner
        generatedAt={snap.generated_at}
        now={now}
        schemaMatches={schema.match}
      />
      {route.name === 'home' && (
        <>
          <PrioritiesStrip priorities={snap.priorities} />
          <GroupsPanel groups={snap.groups} />
          <TasksPanel tasks={snap.tasks} />
          <IngestionPanel ingestion={snap.ingestion} />
          <BlogsPanel blogs={snap.blogs} />
          <WatchlistsPanel watchlists={snap.watchlists} />
          <VaultFeed vault={snap.ingestion.vault} />
        </>
      )}
      {route.name === 'vault' && (
        <VaultTree tree={snap.vault_tree} available={snap.vault_pages_available} />
      )}
      {route.name === 'vault-page' && (
        <VaultPage slug={route.slug} tree={snap.vault_tree} origin={window.location.origin} />
      )}
    </main>
  );
}
