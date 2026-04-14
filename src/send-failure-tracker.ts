import { logger } from './logger.js';

const STRUCTURAL_CODES = new Set([401, 403]);
const STRUCTURAL_MESSAGES = [
  'chat not found',
  'bot was blocked by the user',
  'bot was kicked',
];

const THRESHOLD = 3;
const WINDOW_MS = 10 * 60 * 1000;

interface PerGroupEntry {
  count: number;
  firstSeen: number;
}

interface GlobalEntry {
  jids: Set<string>;
  firstSeen: number;
}

export interface FailureAlert {
  type: 'per-group' | 'global-outage';
  jid?: string;
  count: number;
  windowMinutes: number;
}

const perGroup = new Map<string, PerGroupEntry>();
let globalTracker: GlobalEntry = { jids: new Set(), firstSeen: 0 };

export function classifySendError(
  errorCode: number,
  description: string,
): 'structural' | 'transient' {
  if (STRUCTURAL_CODES.has(errorCode)) return 'structural';
  if (
    errorCode === 400 &&
    STRUCTURAL_MESSAGES.some((m) => description.toLowerCase().includes(m))
  ) {
    return 'structural';
  }
  return 'transient';
}

export function trackTransientFailure(jid: string): FailureAlert | null {
  const now = Date.now();

  const entry = perGroup.get(jid);
  if (entry && now - entry.firstSeen > WINDOW_MS) {
    perGroup.delete(jid);
  }

  const current = perGroup.get(jid) ?? { count: 0, firstSeen: now };
  current.count++;
  perGroup.set(jid, current);

  if (now - globalTracker.firstSeen > WINDOW_MS) {
    globalTracker = { jids: new Set(), firstSeen: now };
  }
  globalTracker.jids.add(jid);

  if (globalTracker.jids.size >= THRESHOLD) {
    const alert: FailureAlert = {
      type: 'global-outage',
      count: globalTracker.jids.size,
      windowMinutes: Math.round((now - globalTracker.firstSeen) / 60_000),
    };
    globalTracker = { jids: new Set(), firstSeen: now };
    logger.warn({ alert }, 'Global Telegram outage detected');
    return alert;
  }

  if (current.count >= THRESHOLD) {
    const alert: FailureAlert = {
      type: 'per-group',
      jid,
      count: current.count,
      windowMinutes: Math.round((now - current.firstSeen) / 60_000),
    };
    perGroup.delete(jid);
    return alert;
  }

  return null;
}

export function resetTrackers(): void {
  perGroup.clear();
  globalTracker = { jids: new Set(), firstSeen: 0 };
}
