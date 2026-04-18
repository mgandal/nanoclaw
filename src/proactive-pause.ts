import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface PauseState {
  pausedUntil: string | null;
  setBy: string;
  setAt: string;
}

const CACHE_TTL_MS = 5000;
let cache: { value: PauseState | 'corrupt' | null; readAt: number } | null =
  null;

export function clearPauseCache(): void {
  cache = null;
}

export function readPause(pauseFile: string): PauseState | null {
  if (cache && Date.now() - cache.readAt < CACHE_TTL_MS) {
    if (cache.value === 'corrupt') {
      return { pausedUntil: null, setBy: 'corrupt', setAt: '' };
    }
    return cache.value;
  }
  try {
    if (!fs.existsSync(pauseFile)) {
      cache = { value: null, readAt: Date.now() };
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(pauseFile, 'utf-8'),
    ) as PauseState;
    cache = { value: parsed, readAt: Date.now() };
    return parsed;
  } catch (err) {
    logger.error({ err, pauseFile }, 'pause file unreadable — fail closed');
    cache = { value: 'corrupt', readAt: Date.now() };
    return { pausedUntil: null, setBy: 'corrupt', setAt: '' };
  }
}

export function writePause(
  pauseFile: string,
  pausedUntil: string | null,
): void {
  fs.mkdirSync(path.dirname(pauseFile), { recursive: true });
  const state: PauseState = {
    pausedUntil,
    setBy: 'user',
    setAt: new Date().toISOString(),
  };
  const tmp = pauseFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, pauseFile);
  clearPauseCache();
}

export function isPaused(pauseFile: string): boolean {
  const s = readPause(pauseFile);
  if (!s) return false;
  if (s.setBy === 'corrupt') return true;
  if (s.pausedUntil === null) return true;
  return new Date(s.pausedUntil).getTime() > Date.now();
}
