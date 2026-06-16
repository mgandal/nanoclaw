import path from 'path';

import { AGENTS_DIR, GROUPS_DIR } from '../config.js';
import { parseCompoundKey, fsPathToCompoundKey } from '../compound-key.js';
import { RegisteredGroup } from '../types.js';

/**
 * Validate an agent name from untrusted IPC input.
 *
 * Per B5 of the 2026-04-18 hardening audit: `schedule_task` used to accept
 * `agent_name` unchecked, then `container-runner.ts` joined it to AGENTS_DIR
 * and mounted the result as `/workspace/agent`. A name containing `..` could
 * resolve outside AGENTS_DIR, exposing data from other groups.
 *
 * Valid: alphanumeric + underscore + hyphen, 1-64 chars, no leading special.
 * Must resolve to a direct child of AGENTS_DIR.
 */
export function isValidAgentName(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return false;
  const resolved = path.resolve(AGENTS_DIR, name);
  const parent = path.resolve(AGENTS_DIR);
  return path.dirname(resolved) === parent;
}

// --- B2/B4: send_file credential blocklist ---

const CREDENTIAL_FILENAME_PATTERNS = [
  /^credentials\.json$/i,
  /^token\.json$/i,
  /^gmail-token\.json$/i,
  /^paperclip-.*\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /^oauth.*$/i,
  /^\.env$/i,
  /^id_rsa$|^id_ed25519$|^id_ecdsa$/,
];

const CREDENTIAL_CONTENT_PATTERNS = [
  /refresh_token/i,
  /client_secret/i,
  /private_key/i,
  /-----BEGIN .* PRIVATE KEY-----/,
  /xoxb-[A-Za-z0-9-]{10,}/, // slack bot token
  /ghp_[A-Za-z0-9]{20,}/, // github PAT
];

/**
 * Reject files that look like credentials. Called from the send_file IPC
 * path for non-main groups. Main-group bypasses — operator tooling
 * legitimately forwards tokens or pem files on occasion.
 *
 * Two-layer: filename pattern (fast, catches unrenamed credential files)
 * + content pattern sample (catches the "renamed to x.json" bypass).
 * The content read is capped at 64KB to avoid DoS on large files.
 */
export function isFileCredentialLike(
  filePath: string,
  contentSample: Buffer,
): boolean {
  const name = path.basename(filePath);
  if (CREDENTIAL_FILENAME_PATTERNS.some((re) => re.test(name))) return true;
  const sampleStr = contentSample.toString(
    'utf-8',
    0,
    Math.min(contentSample.length, 65536),
  );
  return CREDENTIAL_CONTENT_PATTERNS.some((re) => re.test(sampleStr));
}

// C2: send_file extension allowlist for non-main groups. Default-deny by
// extension. Main bypasses (operator tooling legitimately forwards arbitrary
// files). The list covers formats agents typically produce (reports, images,
// structured data, media) while excluding archive formats, raw data stores,
// and executables that are exfil-shaped.
const SEND_FILE_ALLOWED_EXTS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.docx',
  '.xlsx',
  '.pptx',
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
  '.mov',
  '.webm',
  '.zip',
]);

/**
 * Whitelist check for send_file from non-main groups. Main-group bypasses.
 * Returns true if the extension is permitted; false for dotfiles,
 * extensionless files, and anything outside the allowlist.
 */
export function isSendFileExtensionAllowed(filePath: string): boolean {
  const name = path.basename(filePath);
  if (name.startsWith('.')) return false;
  const ext = path.extname(name).toLowerCase();
  if (!ext) return false;
  return SEND_FILE_ALLOWED_EXTS.has(ext);
}

/**
 * Resolve a container file path to the host filesystem.
 * Only resolves known mount prefixes — returns null for unknown paths.
 */
export function resolveContainerFilePathToHost(
  containerFilePath: string,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  if (containerFilePath.includes('..')) return null;

  const projectRoot = path.resolve(GROUPS_DIR, '..');

  // /workspace/group/... → groups/{sourceGroup}/...
  if (containerFilePath.startsWith('/workspace/group/')) {
    const rel = containerFilePath.slice('/workspace/group/'.length);
    return path.join(GROUPS_DIR, sourceGroup, rel);
  }

  // /workspace/project/... → project root/...
  if (containerFilePath.startsWith('/workspace/project/')) {
    const rel = containerFilePath.slice('/workspace/project/'.length);
    return path.join(projectRoot, rel);
  }

  // /workspace/extra/{name}/... → resolve from group's containerConfig
  if (containerFilePath.startsWith('/workspace/extra/')) {
    const rest = containerFilePath.slice('/workspace/extra/'.length);
    const slashIdx = rest.indexOf('/');
    const mountName = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const rel = slashIdx >= 0 ? rest.slice(slashIdx + 1) : '';

    // Find the group's container config to resolve the mount
    for (const group of Object.values(registeredGroups)) {
      if (group.folder !== sourceGroup) continue;
      const mounts = group.containerConfig?.additionalMounts;
      if (!mounts) break;
      for (const m of mounts) {
        if (m.containerPath === mountName) {
          return path.join(m.hostPath, rel);
        }
      }
      break;
    }
  }

  // /workspace/agent/... → data/agents/{agentName}/...
  if (containerFilePath.startsWith('/workspace/agent/')) {
    const { agent } = parseCompoundKey(fsPathToCompoundKey(sourceGroup));
    if (!agent) return null;
    const rel = containerFilePath.slice('/workspace/agent/'.length);
    if (rel.includes('..')) return null;
    return path.join(AGENTS_DIR, agent, rel);
  }

  return null;
}
