import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import type { VaultNode, VaultKind } from './types.js';
import {
  VAULT_ALLOWLIST,
  VAULT_HARD_EXCLUDES,
  RECENT_WINDOW_DAYS,
  RECENT_ARRAY_CAP,
} from './config.js';

const MS_PER_DAY = 24 * 3600 * 1000;

export interface VaultBundleEntry {
  slug: string;
  absPath: string;
  relPath: string;
}

export interface VaultScanResult {
  tree: VaultNode;
  recent: Array<{ path: string; title: string; at: string; kind: VaultKind }>;
  bundle: VaultBundleEntry[];
  count_24h: number;
  last_at: string | null;
}

interface FileEntry { rel: string; abs: string; mtime: Date }

export function scanVault(vaultRoot: string, now: Date): VaultScanResult {
  if (!fs.existsSync(vaultRoot)) {
    return { tree: { name: 'vault', path: '', kind: 'dir', children: [] }, recent: [], bundle: [], count_24h: 0, last_at: null };
  }

  const allEntries: FileEntry[] = [];
  for (const entry of VAULT_ALLOWLIST) {
    const rootAbs = path.join(vaultRoot, entry.root);
    if (!fs.existsSync(rootAbs)) continue;
    const files = collectFiles(rootAbs, vaultRoot);
    for (const f of files) {
      if (isHardExcluded(f.rel)) continue;
      allEntries.push(f);
    }
  }

  const bundle: VaultBundleEntry[] = [];
  const recentCutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * MS_PER_DAY);
  for (const f of allEntries) {
    const mode = getAllowlistMode(f.rel);
    if (mode === 'ALWAYS' || f.mtime > recentCutoff) {
      bundle.push({ slug: pathToSlug(f.rel), absPath: f.abs, relPath: f.rel });
    }
  }

  const sorted = [...allEntries].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const recent = sorted.slice(0, RECENT_ARRAY_CAP).map(f => ({
    path: f.rel,
    title: extractTitle(f.abs, f.rel),
    at: f.mtime.toISOString(),
    kind: inferKind(f.rel),
  }));

  const cutoff24h = new Date(now.getTime() - MS_PER_DAY);
  const count_24h = allEntries.filter(f => f.mtime > cutoff24h).length;
  const last_at = sorted[0]?.mtime.toISOString() ?? null;

  return { tree: buildTree(vaultRoot, allEntries), recent, bundle, count_24h, last_at };
}

function collectFiles(rootAbs: string, vaultRoot: string): FileEntry[] {
  const result: FileEntry[] = [];
  const entries = fs.readdirSync(rootAbs, { withFileTypes: true, recursive: true }) as unknown as Array<fs.Dirent & { parentPath?: string; path?: string }>;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const dir = (e.parentPath ?? e.path ?? rootAbs) as string;
    const abs = path.join(dir, e.name);
    const rel = path.relative(vaultRoot, abs);
    const stat = fs.statSync(abs);
    result.push({ rel, abs, mtime: stat.mtime });
  }
  return result;
}

function isHardExcluded(rel: string): boolean {
  return VAULT_HARD_EXCLUDES.some(excl => rel === excl || rel.startsWith(excl + path.sep));
}

function getAllowlistMode(rel: string): 'ALWAYS' | 'RECENT' {
  for (const entry of VAULT_ALLOWLIST) {
    if (rel === entry.root || rel.startsWith(entry.root + path.sep)) return entry.mode;
  }
  return 'RECENT';
}

function pathToSlug(rel: string): string {
  const noExt = rel.replace(/\.md$/, '');
  return encodeURIComponent(noExt);
}

function extractTitle(abs: string, rel: string): string {
  try {
    const raw = fs.readFileSync(abs, 'utf-8');
    const parsed = matter(raw);
    if (typeof parsed.data.title === 'string' && parsed.data.title.trim()) {
      return parsed.data.title.trim();
    }
    const h1Match = parsed.content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();
  } catch {
    // ignore
  }
  return path.basename(rel, '.md').replace(/-/g, ' ');
}

function inferKind(rel: string): VaultKind {
  if (rel.includes('99-wiki/papers')) return 'paper';
  if (rel.includes('99-wiki/syntheses')) return 'synthesis';
  if (rel.includes('99-wiki/tools')) return 'tool';
  if (rel.startsWith('99-wiki')) return 'wiki';
  if (rel.startsWith('00-inbox')) return 'inbox';
  if (rel.startsWith('10-daily')) return 'daily';
  return 'other';
}

function buildTree(vaultRoot: string, entries: FileEntry[]): VaultNode {
  const root: VaultNode = { name: path.basename(vaultRoot), path: '', kind: 'dir', children: [] };
  for (const e of entries) {
    insertPath(root, e.rel.split(path.sep), e.mtime.toISOString());
  }
  return root;
}

function insertPath(node: VaultNode, parts: string[], mtime: string): void {
  if (parts.length === 0) return;
  const [head, ...rest] = parts;
  node.children ??= [];
  let child = node.children.find(c => c.name === head);
  if (!child) {
    const isFile = rest.length === 0;
    child = isFile
      ? { name: head, path: joinPath(node.path, head), kind: 'file', edited_at: mtime }
      : { name: head, path: joinPath(node.path, head), kind: 'dir', children: [] };
    node.children.push(child);
  }
  if (rest.length > 0) insertPath(child, rest, mtime);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}
