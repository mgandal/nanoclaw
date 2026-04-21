import fs from 'fs';
import type { IngestionEmails } from './types.js';

interface State {
  last_epoch?: number;
  synced_ids?: string[];
}

export function readEmailsState(jsonPath: string, _now: Date): IngestionEmails {
  if (!fs.existsSync(jsonPath)) {
    return { count_24h: 0, last_at: null, recent: [] };
  }
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const state = JSON.parse(raw) as State;
    const last_at = state.last_epoch ? new Date(state.last_epoch * 1000).toISOString() : null;
    const count_24h = state.synced_ids?.length ?? 0;
    // Per-email subject/from data is not currently stored in state; future improvement.
    return { count_24h, last_at, recent: [] };
  } catch {
    return { count_24h: 0, last_at: null, recent: [] };
  }
}
