// scripts/cockpit/papers-log.ts
import fs from 'fs';
import type { IngestionPapers } from './types.js';
import { RECENT_ARRAY_CAP } from './config.js';

interface RawEntry {
  evaluated_at: string;
  title: string;
  authors: string;
  verdict?: 'ADOPT' | 'STEAL' | 'SKIP';
  url?: string;
}

export function readPapersLog(jsonlPath: string, now: Date): IngestionPapers {
  if (!fs.existsSync(jsonlPath)) {
    return { count_24h: 0, last_at: null, recent: [] };
  }
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const entries: RawEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<RawEntry>;
      if (typeof obj.evaluated_at !== 'string' || typeof obj.title !== 'string' || typeof obj.authors !== 'string') continue;
      entries.push(obj as RawEntry);
    } catch {
      // malformed line — skip
    }
  }
  entries.sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at));
  const recent = entries.slice(0, RECENT_ARRAY_CAP).map(e => ({
    title: e.title,
    authors: e.authors,
    at: e.evaluated_at,
    ...(e.verdict ? { verdict: e.verdict } : {}),
    ...(e.url ? { url: e.url } : {}),
  }));
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
  const count_24h = entries.filter(e => new Date(e.evaluated_at) > cutoff).length;
  const last_at = entries[0]?.evaluated_at ?? null;
  return { count_24h, last_at, recent };
}
