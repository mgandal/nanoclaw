import path from 'path';

export const VAULT_PATH = process.env.COCKPIT_VAULT_PATH ?? '/Volumes/sandisk4TB/marvin-vault';

export const R2_ENDPOINT = process.env.COCKPIT_R2_ENDPOINT ?? '';
export const R2_BUCKET = process.env.COCKPIT_R2_BUCKET ?? '';
export const R2_TOKEN = process.env.COCKPIT_R2_TOKEN ?? '';

// Project root detection: script lives at scripts/cockpit/<file>.ts.
// import.meta.dirname is the ES2024 / Node 20.11+ / Bun standard
// (import.meta.dir is Bun-only and undefined under vitest's transform).
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

export const SNAPSHOT_PATH = '/tmp/nanoclaw-snapshot.json';
export const LAST_SNAPSHOT_PATH = '/tmp/nanoclaw-last-snapshot.json';

// Allowlist for the vault scanner. Dirs not in this list are invisible to the builder.
// 'ALWAYS' = bundle every file regardless of mtime.
// 'RECENT' = bundle only files with mtime in the last 7 days.
export interface AllowlistEntry { root: string; mode: 'ALWAYS' | 'RECENT' }

export const VAULT_ALLOWLIST: AllowlistEntry[] = [
  { root: '99-wiki',     mode: 'ALWAYS' },
  { root: '80-resources', mode: 'ALWAYS' },
  { root: '00-inbox',    mode: 'RECENT' },
  { root: '70-areas',    mode: 'RECENT' },
  { root: '10-daily',    mode: 'RECENT' },  // vault-scan excludes 10-daily/meetings/
];

// Paths relative to VAULT_PATH that are ALWAYS excluded regardless of allowlist.
export const VAULT_HARD_EXCLUDES: string[] = [
  '10-daily/meetings',
];

export const RECENT_WINDOW_DAYS = 7;

// Cap all recent[] arrays to prevent unbounded snapshot size.
export const RECENT_ARRAY_CAP = 20;
