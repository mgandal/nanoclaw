import type { VaultNode } from '../types.js';
import { pathToSlug, isAvailable } from '../lib/slug.js';

interface Props {
  tree: VaultNode;
  available: string[];
}

export function VaultTree({ tree, available }: Props) {
  return <ul class="vault-tree">{renderChildren(tree, available)}</ul>;
}

function renderChildren(node: VaultNode, available: string[]) {
  if (!node.children) return null;
  return node.children.map(child => renderNode(child, available));
}

function renderNode(node: VaultNode, available: string[]) {
  if (node.kind === 'dir') {
    return (
      <li key={node.path}>
        <strong>{node.name}</strong>
        <ul>{renderChildren(node, available)}</ul>
      </li>
    );
  }
  const slug = pathToSlug(node.path);
  if (isAvailable(node.path, available)) {
    return (
      <li key={node.path}>
        <a href={`#/vault/${slug}`}>{node.name}</a>
      </li>
    );
  }
  return (
    <li key={node.path}>
      <span class="dimmed" title="Full text not in current snapshot (outside recent window).">
        {node.name}
      </span>
    </li>
  );
}
