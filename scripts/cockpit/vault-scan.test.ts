// scripts/cockpit/vault-scan.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanVault } from './vault-scan.js';

let tmpVault: string;

function writeFile(rel: string, body: string, mtime?: Date) {
  const abs = path.join(tmpVault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  if (mtime) fs.utimesSync(abs, mtime, mtime);
}

beforeEach(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
});

afterEach(() => {
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

describe('scanVault', () => {
  it('includes only allowlisted roots', () => {
    writeFile('99-wiki/tools/polars-bio.md', '# polars-bio');
    writeFile('30-lab/secret.md', '# secret');
    writeFile('_media/image.png', 'bytes');

    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);

    const names = result.tree.children?.map(c => c.name) ?? [];
    expect(names).toContain('99-wiki');
    expect(names).not.toContain('30-lab');
    expect(names).not.toContain('_media');
  });

  it('includes all 99-wiki files regardless of mtime (ALWAYS mode)', () => {
    const oldMtime = new Date('2024-01-01T00:00:00Z');
    writeFile('99-wiki/tools/old.md', '# old', oldMtime);
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);

    expect(result.bundle.map(b => b.slug)).toContain('99-wiki%2Ftools%2Fold');
  });

  it('filters RECENT-mode folders by mtime', () => {
    const oldMtime = new Date('2026-04-10T00:00:00Z');
    const freshMtime = new Date('2026-04-18T00:00:00Z');
    writeFile('10-daily/journal.md', 'body', oldMtime);
    writeFile('10-daily/fresh.md', 'body', freshMtime);
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);

    const slugs = result.bundle.map(b => b.slug);
    expect(slugs).toContain('10-daily%2Ffresh');
    expect(slugs).not.toContain('10-daily%2Fjournal');
  });

  it('excludes 10-daily/meetings per HARD_EXCLUDES', () => {
    writeFile('10-daily/meetings/sync.md', '# meeting notes');
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);
    expect(result.bundle.every(b => !b.slug.includes('meetings'))).toBe(true);
  });

  it('returns recent[] sorted by edited_at descending, capped at 20', () => {
    const base = new Date('2026-04-19T12:00:00Z').getTime();
    for (let i = 0; i < 25; i++) {
      const d = new Date(base - i * 24 * 3600 * 1000);
      writeFile(`99-wiki/tools/tool-${i}.md`, `# tool ${i}`, d);
    }
    const now = new Date('2026-04-19T13:00:00Z');
    const result = scanVault(tmpVault, now);
    expect(result.recent).toHaveLength(20);
    expect(result.recent[0].title).toBe('tool 0');
  });

  it('parses frontmatter title if present', () => {
    writeFile('99-wiki/papers/smith.md', '---\ntitle: Custom Title\n---\n# Heading');
    const now = new Date('2026-04-19T12:00:00Z');
    const result = scanVault(tmpVault, now);
    const smith = result.recent.find(r => r.path.includes('smith'));
    expect(smith?.title).toBe('Custom Title');
  });
});
