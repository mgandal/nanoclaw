import fs from 'fs';
import type { Snapshot } from './types.js';
import type { VaultBundleEntry } from './vault-scan.js';

export function loadPreviousSnapshot(jsonPath: string): Snapshot | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

export function computeChangedBundle(
  fullBundle: VaultBundleEntry[],
  previous: Snapshot | null,
  _now: Date,
): VaultBundleEntry[] {
  if (!previous) return fullBundle;
  const prevMs = new Date(previous.generated_at).getTime();
  return fullBundle.filter(e => {
    try {
      return fs.statSync(e.absPath).mtime.getTime() > prevMs;
    } catch {
      return true;
    }
  });
}
