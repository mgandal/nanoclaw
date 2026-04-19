// scripts/cockpit/delta.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadPreviousSnapshot, computeChangedBundle } from './delta.js';
import type { Snapshot } from './types.js';
import type { VaultBundleEntry } from './vault-scan.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `last-${Date.now()}.json`);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe('loadPreviousSnapshot', () => {
  it('returns null when file missing', () => {
    expect(loadPreviousSnapshot('/nope.json')).toBeNull();
  });

  it('returns parsed snapshot when valid', () => {
    const snap = { generated_at: '2026-04-19T10:00:00Z', schema_version: 1 } as Snapshot;
    fs.writeFileSync(tmpFile, JSON.stringify(snap));
    expect(loadPreviousSnapshot(tmpFile)?.generated_at).toBe('2026-04-19T10:00:00Z');
  });

  it('returns null for malformed JSON', () => {
    fs.writeFileSync(tmpFile, 'garbage');
    expect(loadPreviousSnapshot(tmpFile)).toBeNull();
  });
});

describe('computeChangedBundle', () => {
  const bundleEntry = (slug: string, absPath: string, relPath: string): VaultBundleEntry => ({ slug, absPath, relPath });

  it('returns all entries when no previous snapshot', () => {
    const full = [bundleEntry('a', '/x/a.md', 'a.md'), bundleEntry('b', '/x/b.md', 'b.md')];
    expect(computeChangedBundle(full, null, new Date())).toEqual(full);
  });

  it('returns only entries with mtime newer than last generated_at', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-'));
    const oldFile = path.join(tmpDir, 'old.md');
    const newFile = path.join(tmpDir, 'new.md');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');
    fs.utimesSync(oldFile, new Date('2026-04-18T10:00:00Z'), new Date('2026-04-18T10:00:00Z'));
    fs.utimesSync(newFile, new Date('2026-04-19T12:00:00Z'), new Date('2026-04-19T12:00:00Z'));

    const full = [
      bundleEntry('old', oldFile, 'old.md'),
      bundleEntry('new', newFile, 'new.md'),
    ];
    const prev = { generated_at: '2026-04-19T00:00:00Z', schema_version: 1 } as Snapshot;
    const changed = computeChangedBundle(full, prev, new Date());
    expect(changed.map(e => e.slug)).toEqual(['new']);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
