const SEPARATOR = ':';
const FS_SEPARATOR = '--';

export function compoundKey(groupFolder: string, agentName: string): string {
  return `${groupFolder}${SEPARATOR}${agentName}`;
}

export function parseCompoundKey(key: string): {
  group: string;
  agent: string | null;
} {
  const idx = key.indexOf(SEPARATOR);
  if (idx === -1) return { group: key, agent: null };
  return { group: key.slice(0, idx), agent: key.slice(idx + 1) };
}

export function isCompoundKey(key: string): boolean {
  return key.includes(SEPARATOR);
}

export function compoundKeyToFsPath(key: string): string {
  return key.replace(SEPARATOR, FS_SEPARATOR);
}

export function fsPathToCompoundKey(fsPath: string): string {
  const idx = fsPath.lastIndexOf(FS_SEPARATOR);
  if (idx === -1) return fsPath;
  const group = fsPath.slice(0, idx);
  const agent = fsPath.slice(idx + FS_SEPARATOR.length);
  if (!group || !agent) return fsPath;
  return `${group}${SEPARATOR}${agent}`;
}
