import { stalenessOf } from '../lib/staleness.js';

interface Props {
  generatedAt: string;
  now: Date;
  schemaMatches: boolean;
}

export function StalenessBanner({ generatedAt, now, schemaMatches }: Props) {
  if (!schemaMatches) {
    return (
      <div role="alert" class="banner schema-mismatch">
        Cockpit UI is out of date; please reload.
      </div>
    );
  }
  const { level, ageMin } = stalenessOf(generatedAt, now);
  if (level === 'fresh') return null;
  const msg =
    level === 'stale-warn'
      ? `Snapshot ${ageMin} min old — cockpit may be behind.`
      : `Snapshot ${ageMin} min old — publisher may be stalled.`;
  return (
    <div role="alert" class={`banner ${level}`}>
      {msg}
    </div>
  );
}
