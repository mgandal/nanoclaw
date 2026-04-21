import type { IngestionVault } from '../types.js';
import { pathToSlug } from '../lib/slug.js';

interface Props {
  vault: IngestionVault;
}

export function VaultFeed({ vault }: Props) {
  if (vault.recent.length === 0) return null;
  return (
    <section class="vault-feed">
      <h2>Recent vault edits</h2>
      <ul>
        {vault.recent.map(r => (
          <li key={r.path} class={`kind-${r.kind}`}>
            <a href={`#/vault/${pathToSlug(r.path)}`}>{r.title}</a>
            <span class="path"> — {r.path}</span>
          </li>
        ))}
      </ul>
      <a class="browse-link" href="#/vault">Browse vault →</a>
    </section>
  );
}
