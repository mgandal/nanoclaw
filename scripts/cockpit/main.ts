import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';

import { buildSnapshot } from './build-snapshot.js';
import { loadPreviousSnapshot, computeChangedBundle } from './delta.js';
import { scanVault } from './vault-scan.js';
import { makeR2Client, uploadObject } from './r2.js';
import {
  VAULT_PATH, R2_ENDPOINT, R2_BUCKET, R2_TOKEN,
  SNAPSHOT_PATH, LAST_SNAPSHOT_PATH, PROJECT_ROOT,
} from './config.js';

interface SplitToken { accessKeyId: string; secretAccessKey: string }

function parseR2Token(token: string): SplitToken {
  const parts = token.split(':');
  if (parts.length !== 2) {
    throw new Error('COCKPIT_R2_TOKEN must be formatted as "accessKeyId:secretAccessKey"');
  }
  return { accessKeyId: parts[0], secretAccessKey: parts[1] };
}

function checkPreconditions(): void {
  if (!fs.existsSync(VAULT_PATH)) {
    throw new Error(`Vault path not found at ${VAULT_PATH}; set COCKPIT_VAULT_PATH or attach drive`);
  }
  const wikiProbe = path.join(VAULT_PATH, '99-wiki');
  if (fs.existsSync(wikiProbe)) {
    try {
      fs.readdirSync(wikiProbe);
    } catch (err) {
      throw new Error(
        `Cannot read ${wikiProbe} (likely FDA issue). Grant Full Disk Access to /opt/homebrew/bin/bun.`,
        { cause: err },
      );
    }
  }
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_TOKEN) {
    throw new Error('Missing R2 config: set COCKPIT_R2_ENDPOINT, COCKPIT_R2_BUCKET, COCKPIT_R2_TOKEN');
  }
  const cockpitDir = path.join(PROJECT_ROOT, 'data', 'cockpit');
  fs.mkdirSync(cockpitDir, { recursive: true });
}

async function run(): Promise<void> {
  checkPreconditions();

  const now = new Date();
  const dbPath = path.join(PROJECT_ROOT, 'store', 'messages.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const previous = loadPreviousSnapshot(LAST_SNAPSHOT_PATH);
    const snapshot = buildSnapshot({
      db,
      vaultPath: VAULT_PATH,
      agentsDir: path.join(PROJECT_ROOT, 'data', 'agents'),
      groupsDir: path.join(PROJECT_ROOT, 'groups'),
      currentMdPath: path.join(PROJECT_ROOT, 'groups', 'global', 'state', 'current.md'),
      papersLogPath: path.join(PROJECT_ROOT, 'data', 'cockpit', 'papers-evaluated.jsonl'),
      emailsStatePath: path.join(PROJECT_ROOT, 'scripts', 'sync', 'gmail-sync-state.json'),
      blogsPath: path.join(PROJECT_ROOT, 'data', 'cockpit', 'blogs.json'),
      previousSnapshot: previous,
      now,
    });

    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));

    const { accessKeyId, secretAccessKey } = parseR2Token(R2_TOKEN);
    const client = makeR2Client(R2_ENDPOINT, accessKeyId, secretAccessKey);

    await uploadObject(client, R2_BUCKET, 'snapshot.json', JSON.stringify(snapshot), 'application/json');

    const histKey = `snapshot-${histStamp(now)}.json`;
    await uploadObject(client, R2_BUCKET, histKey, JSON.stringify(snapshot), 'application/json');

    await uploadObject(client, R2_BUCKET, 'heartbeat.txt', now.toISOString(), 'text/plain');

    const vault = scanVault(VAULT_PATH, now);
    const changed = computeChangedBundle(vault.bundle, previous, now);
    for (const entry of changed) {
      const body = fs.readFileSync(entry.absPath);
      await uploadObject(client, R2_BUCKET, `pages/${entry.slug}.md`, body, 'text/markdown');
    }

    fs.copyFileSync(SNAPSHOT_PATH, LAST_SNAPSHOT_PATH);

    console.log(`cockpit: ok, ${changed.length} pages uploaded, heartbeat ${now.toISOString()}`);
  } finally {
    db.close();
  }
}

function histStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

run().catch(err => {
  console.error('cockpit: FAILED', err);
  process.exit(1);
});
