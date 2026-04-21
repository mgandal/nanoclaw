import type { IngestionSnapshot } from '../types.js';

interface Props {
  ingestion: IngestionSnapshot;
}

export function IngestionPanel({ ingestion }: Props) {
  return (
    <section class="ingestion-panel">
      <h2>Ingestion (24h)</h2>
      <dl>
        <div class="counter">
          <dt>emails</dt>
          <dd>{ingestion.emails.count_24h}</dd>
        </div>
        <div class="counter">
          <dt>papers</dt>
          <dd>{ingestion.papers.count_24h}</dd>
        </div>
        <div class="counter">
          <dt>vault edits</dt>
          <dd>{ingestion.vault.count_24h}</dd>
        </div>
      </dl>
    </section>
  );
}
