export type StalenessLevel = 'fresh' | 'stale-warn' | 'stale-crit';

export interface Staleness {
  level: StalenessLevel;
  ageMin: number;
}

const WARN_MIN = 60;
const CRIT_MIN = 180;

export function stalenessOf(generatedAt: string, now: Date): Staleness {
  const genMs = new Date(generatedAt).getTime();
  const nowMs = now.getTime();
  const ageMin = Math.max(0, Math.floor((nowMs - genMs) / 60_000));

  if (ageMin > CRIT_MIN) return { level: 'stale-crit', ageMin };
  if (ageMin > WARN_MIN) return { level: 'stale-warn', ageMin };
  return { level: 'fresh', ageMin };
}
