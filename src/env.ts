import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

let envCache: Record<string, string> | null = null;
let envMtimeMs = 0;

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * The full file is cached and invalidated by mtime, so repeated calls
 * with different key sets are cheap.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');

  // Check if we need to re-read
  let currentMtime = 0;
  try {
    currentMtime = fs.statSync(envFile).mtimeMs;
  } catch {
    logger.debug('.env file not found, using defaults');
    return {};
  }

  if (!envCache || currentMtime !== envMtimeMs) {
    let content: string;
    try {
      content = fs.readFileSync(envFile, 'utf-8');
    } catch {
      logger.debug('.env file not readable, using defaults');
      return {};
    }
    envCache = {};
    envMtimeMs = currentMtime;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) envCache[key] = value;
    }
  }

  // Filter to requested keys
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (envCache[key]) result[key] = envCache[key];
  }
  return result;
}
