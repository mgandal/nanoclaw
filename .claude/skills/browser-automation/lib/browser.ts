/**
 * Browser Automation - Shared utilities
 */

import { chromium, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export { config };

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

export function cleanupLockFiles(): void {
  for (const lockFile of [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
  ]) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
}

export async function getBrowserContext(): Promise<BrowserContext> {
  cleanupLockFiles();

  const context = await chromium.launchPersistentContext(
    config.browserDataDir,
    {
      executablePath: config.chromePath,
      headless: false,
      viewport: config.viewport,
      args: config.chromeArgs,
      ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
    },
  );

  return context;
}

export async function runScript<T>(
  handler: (input: T) => Promise<ScriptResult>,
): Promise<void> {
  try {
    const input = await readInput<T>();
    const result = await handler(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
}
