import type { VaultNode } from '../types.js';
import { pathToSlug } from './slug.js';

/**
 * Resolve an Obsidian-style wikilink target to a vault slug, or null if
 * no file with the target basename exists in the vault tree.
 *
 * Match rule (spec §5): target compares case-sensitively against file
 * basename (.md stripped). Directories are ignored. First match wins —
 * vault is expected to have unique basenames inside the allowlisted roots.
 * A `.md` suffix on the target is tolerated and stripped before comparison.
 */
export function resolveWikilink(target: string, tree: VaultNode): string | null {
  const needle = target.replace(/\.md$/, '');
  const match = findFile(tree, needle);
  return match ? pathToSlug(match) : null;
}

function findFile(node: VaultNode, needle: string): string | null {
  if (node.kind === 'file') {
    const base = node.name.replace(/\.md$/, '');
    return base === needle ? node.path : null;
  }
  for (const child of node.children ?? []) {
    const hit = findFile(child, needle);
    if (hit !== null) return hit;
  }
  return null;
}
