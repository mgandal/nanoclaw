import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  PROACTIVE_ENABLED,
  PROACTIVE_GOVERNOR,
  PROACTIVE_PAUSE_PATH,
  QUIET_DAYS_OFF,
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import { parseCompoundKey, fsPathToCompoundKey } from './compound-key.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { loadAgentTrust } from './agent-registry.js';
import { checkTrustAndStage } from './trust-enforcement.js';
import { firePostHocNotify } from './trust-notify.js';
import { buildContext, dispatchIpcAction } from './ipc/handler.js';
import { registerBuiltinHandlers } from './ipc/handlers/index.js';
import { logger } from './logger.js';
import { decide as governorDecide } from './outbound-governor.js';
import {
  clearDispatch,
  markDelivered,
  markDispatched,
} from './proactive-log.js';
import { isPaused, writePause } from './proactive-pause.js';
import { isInQuietHours, nextQuietEnd } from './quiet-hours.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendWebAppButton?: (jid: string, label: string, url: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  messageBus?: import('./message-bus.js').MessageBus;
}

let ipcWatcherRunning = false;

/**
 * FD-pressure diagnostic. Called from any catch that sees EMFILE or ENFILE.
 * Captures process FD count + open-handle counts (timers, sockets, etc.) so
 * a post-mortem can distinguish a process leak from a system-wide overflow.
 *
 * Best-effort — never throws (the caller is already in error-handling).
 */
export function logFdPressureDiagnostic(
  context: Record<string, unknown>,
  err: unknown,
): void {
  // Pull active handle counts via the undocumented but stable Node APIs.
  // These are cheap and tell us whether the leak is in this process.
  let activeHandles = -1;
  let activeRequests = -1;
  try {
    activeHandles = (process as any)._getActiveHandles?.()?.length ?? -1;
    activeRequests = (process as any)._getActiveRequests?.()?.length ?? -1;
  } catch {
    // ignore
  }

  // Try to count this process's open FDs. On Linux read /proc/self/fd.
  // On macOS fall back to lsof via spawnSync (no shell, fixed args).
  let processFdCount: number | string = 'unknown';
  try {
    processFdCount = fs.readdirSync('/proc/self/fd').length;
  } catch {
    try {
      const result = spawnSync('lsof', ['-p', String(process.pid)], {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result.stdout) {
        processFdCount = result.stdout.split('\n').filter(Boolean).length;
      }
    } catch {
      // give up
    }
  }

  logger.error(
    {
      ...context,
      err,
      diagnostic: {
        activeHandles,
        activeRequests,
        processFdCount,
        pid: process.pid,
        rss: process.memoryUsage?.().rss,
      },
    },
    'FD-pressure diagnostic (EMFILE/ENFILE)',
  );
}

/**
 * Scan the IPC base directory for per-group subfolders. Returns the list
 * of directory names (excluding `errors/`).
 *
 * Hardened against FD exhaustion:
 *   - Uses fs.opendirSync so the Dir handle is held in a try/finally
 *     and explicitly closed even on throw. (readdirSync doesn't leak
 *     directly, but the older codepath called statSync inside the
 *     filter; this is a single syscall per entry via Dirent.)
 *   - On EMFILE/ENFILE, fires `logFdPressureDiagnostic` then re-throws.
 *   - Uses Dirent.isDirectory() — saves one stat() syscall per entry.
 *
 * Exported for unit testing.
 */
export function scanIpcGroupFolders(ipcBaseDir: string): string[] {
  const out: string[] = [];
  let dir: fs.Dir | null = null;
  try {
    dir = fs.opendirSync(ipcBaseDir);
    let entry: fs.Dirent | null;
    while ((entry = dir.readSync()) !== null) {
      if (entry.name === 'errors') continue;
      if (entry.isDirectory()) out.push(entry.name);
    }
    return out;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EMFILE' || code === 'ENFILE') {
      logFdPressureDiagnostic({ ipcBaseDir, op: 'scanIpcGroupFolders' }, err);
    }
    throw err;
  } finally {
    if (dir) {
      try {
        dir.closeSync();
      } catch {
        // already closed or stale — irrelevant
      }
    }
  }
}

/**
 * Tracks chatJids that received IPC send_message deliveries recently.
 * Used by the streaming output callback to suppress duplicate sends
 * when pool bots already delivered the agent's message via IPC.
 * Entries auto-expire after 60 seconds.
 */
const recentIpcSends = new Map<string, number>(); // chatJid → timestamp

export function markIpcSend(chatJid: string): void {
  recentIpcSends.set(chatJid, Date.now());
}

export function hasRecentIpcSend(chatJid: string): boolean {
  const ts = recentIpcSends.get(chatJid);
  if (!ts) return false;
  // Expire after 60 seconds
  if (Date.now() - ts > 60_000) {
    recentIpcSends.delete(chatJid);
    return false;
  }
  return true;
}

export function clearIpcSend(chatJid: string): void {
  recentIpcSends.delete(chatJid);
}

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
 * Policy: is `sender` allowed to fire a pooled/pinned Telegram bot in
 * `group`? `undefined` permittedSenders = allow any (legacy rows, backwards
 * compat). Empty array = no personas; every `sender` is downgraded to the
 * main bot. Non-empty array = strict allowlist (exact-match, case-sensitive).
 *
 * Named distinctly from `isSenderAllowed` in `sender-allowlist.ts`, which
 * gates whether a raw incoming message is processed at all.
 */
export function isSenderAllowedForPool(
  group: RegisteredGroup,
  sender: string,
): boolean {
  if (group.permittedSenders === undefined) return true;
  return group.permittedSenders.includes(sender);
}

/**
 * Deliver a send_message payload through the appropriate channel path:
 * WebApp button → pool bot with sender prefix → plain main-bot send.
 *
 * Pure delivery: no trust check, no audit log. Callers (processIpcMessage
 * for fresh actions, approval executor for replayed ones) are responsible
 * for those concerns so they can attribute outcomes correctly.
 *
 * On pool-bot delivery, marks the chatJid as recently-IPC-sent to suppress
 * duplicate output from the streaming callback.
 */
export async function deliverSendMessage(
  data: {
    chatJid: string;
    text: string;
    sender?: string;
    webAppUrl?: string;
    proactive?: boolean;
    correlationId?: string;
    urgency?: number;
    ruleId?: string;
    contributingEvents?: string[];
    fromAgent?: string;
    // Per-target-group allowlist. When set, disallowed senders are
    // downgraded from the bot pool to the main bot (with a *Sender:*
    // prefix). Callers compute this from the registered group;
    // `deliverSendMessage` stays a pure delivery primitive.
    permittedSenders?: string[];
  },
  deps: Pick<IpcDeps, 'sendMessage' | 'sendWebAppButton'>,
  sourceGroup: string,
): Promise<void> {
  if (data.proactive && PROACTIVE_GOVERNOR) {
    if (!data.correlationId) {
      throw new Error('proactive=true requires correlationId');
    }
    const pauseFile =
      process.env.PROACTIVE_PAUSE_PATH_OVERRIDE || PROACTIVE_PAUSE_PATH;
    const decision = governorDecide(
      {
        fromAgent: data.fromAgent || sourceGroup,
        toGroup: data.chatJid,
        message: data.text,
        urgency: data.urgency ?? 0.5,
        correlationId: data.correlationId,
        ruleId: data.ruleId,
        contributingEvents: data.contributingEvents || [],
      },
      {
        enabled: PROACTIVE_ENABLED,
        governorOn: true,
        isPaused,
        isInQuiet: (now) =>
          isInQuietHours(now, {
            start: QUIET_HOURS_START,
            end: QUIET_HOURS_END,
            daysOff: QUIET_DAYS_OFF,
            timezone: TIMEZONE,
          }),
        nextQuietEnd: (now) =>
          nextQuietEnd(now, {
            start: QUIET_HOURS_START,
            end: QUIET_HOURS_END,
            daysOff: QUIET_DAYS_OFF,
            timezone: TIMEZONE,
          }),
        now: () => new Date(),
        pauseFile,
      },
    );

    if (decision.decision !== 'send') return; // drop or defer; already logged

    markDispatched(decision.logId, new Date().toISOString());
    try {
      await deps.sendMessage(data.chatJid, data.text);
      markDelivered(decision.logId, new Date().toISOString());
    } catch (err) {
      clearDispatch(decision.logId);
      throw err;
    }
    return;
  }

  if (
    data.webAppUrl &&
    typeof data.webAppUrl === 'string' &&
    deps.sendWebAppButton
  ) {
    await deps.sendWebAppButton(data.chatJid, data.text, data.webAppUrl);
    logger.info(
      { chatJid: data.chatJid, sourceGroup },
      'IPC WebApp button sent',
    );
    return;
  }

  // Enforce per-group sender allowlist. Disallowed senders skip the pool
  // entirely and go out as a prefixed message from the main bot. This
  // stops an agent in group A from firing a pinned pool bot (e.g. Freud)
  // just because it picked that string as its sender in a group that
  // isn't authorized to surface that persona.
  if (
    data.sender &&
    data.permittedSenders !== undefined &&
    !data.permittedSenders.includes(data.sender)
  ) {
    logger.warn(
      {
        chatJid: data.chatJid,
        sourceGroup,
        sender: data.sender,
        permitted: data.permittedSenders,
      },
      'Sender not in group allowlist — downgrading to main-bot prefixed send',
    );
    const prefixed = `*${data.sender}:*\n${data.text}`;
    await deps.sendMessage(data.chatJid, prefixed);
    return;
  }

  if (
    data.sender &&
    data.chatJid.startsWith('tg:') &&
    TELEGRAM_BOT_POOL.length > 0
  ) {
    const sent = await sendPoolMessage(
      data.chatJid,
      data.text,
      data.sender,
      sourceGroup,
    );
    if (!sent) {
      const prefixed = `*${data.sender}:*\n${data.text}`;
      await deps.sendMessage(data.chatJid, prefixed);
    }
    markIpcSend(data.chatJid);
    logger.info(
      { chatJid: data.chatJid, sourceGroup, sender: data.sender },
      'IPC message sent',
    );
    return;
  }

  await deps.sendMessage(data.chatJid, data.text);
  logger.info(
    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
    'IPC message sent',
  );
}

function cleanupStaleProcessing(ipcBaseDir: string): void {
  try {
    const errorDir = path.join(ipcBaseDir, 'errors');
    for (const groupDir of fs.readdirSync(ipcBaseDir)) {
      const groupPath = path.join(ipcBaseDir, groupDir);
      if (!fs.statSync(groupPath).isDirectory() || groupDir === 'errors')
        continue;
      for (const subDir of ['messages', 'tasks']) {
        const dirPath = path.join(groupPath, subDir);
        if (!fs.existsSync(dirPath)) continue;
        const stale = fs
          .readdirSync(dirPath)
          .filter((f) => f.endsWith('.processing'));
        for (const file of stale) {
          fs.mkdirSync(errorDir, { recursive: true });
          try {
            fs.renameSync(
              path.join(dirPath, file),
              path.join(errorDir, `${groupDir}-stale-${file}`),
            );
          } catch {
            // already moved or gone
          }
        }
        if (stale.length > 0) {
          logger.warn(
            { group: groupDir, subDir, count: stale.length },
            'Moved stale .processing IPC files to errors/',
          );
        }
      }
    }
  } catch {
    // Non-fatal: best-effort cleanup
  }
}

/**
 * Resolve a container file path to the host filesystem.
 * Only resolves known mount prefixes — returns null for unknown paths.
 */
function resolveContainerFilePathToHost(
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

/**
 * Process a single IPC message (send_message or send_file).
 * Extracted from the inline watcher loop for testability.
 */
export async function processIpcMessage(
  data: {
    type: string;
    chatJid?: string;
    text?: string;
    sender?: string;
    webAppUrl?: string;
    filePath?: string;
    caption?: string;
    pausedUntil?: string | null;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  if (data.type === 'message' && data.chatJid && data.text) {
    // Authorization: verify this group can send to this chatJid
    const targetGroup = registeredGroups[data.chatJid];
    // For compound groups, extract base group for authorization
    const baseKey = fsPathToCompoundKey(sourceGroup);
    const { group: baseGroupFolder, agent: agentName } =
      parseCompoundKey(baseKey);
    if (isMain || (targetGroup && targetGroup.folder === baseGroupFolder)) {
      // Trust enforcement for compound groups (agents). Capture decision
      // so we can fire a post-hoc notify after delivery succeeds.
      let notify = false;
      if (agentName) {
        const trust = loadAgentTrust(path.join(AGENTS_DIR, agentName));
        const decision = checkTrustAndStage({
          agentName,
          groupFolder: baseGroupFolder,
          actionType: 'send_message',
          summary: data.text,
          target: data.chatJid,
          payloadForStaging: {
            type: 'message',
            chatJid: data.chatJid,
            text: data.text,
            sender: data.sender,
            webAppUrl: data.webAppUrl,
          },
          trust,
        });
        notify = decision.notify;
        if (!decision.allowed) return;
      }

      await deliverSendMessage(
        {
          chatJid: data.chatJid,
          text: data.text,
          sender: data.sender,
          webAppUrl: data.webAppUrl,
          permittedSenders: targetGroup?.permittedSenders,
        },
        deps,
        sourceGroup,
      );

      // Skip the notify if its target jid IS the main jid (would echo back
      // into the same chat we just sent to). The shared helper has no way
      // to know about the message's chatJid, so we guard inline.
      const mainJidForSelfCheck = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      )?.[0];
      if (notify && agentName && mainJidForSelfCheck !== data.chatJid) {
        await firePostHocNotify({
          notify,
          agentName,
          actionType: 'send_message',
          summary: `→ ${registeredGroups[data.chatJid]?.name || data.chatJid}: ${data.text}`,
          registeredGroups,
          deps,
        });
      }
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC message attempt blocked',
      );
    }
  } else if (
    data.type === 'send_file' &&
    data.chatJid &&
    data.filePath &&
    deps.sendFile
  ) {
    const targetGroup = registeredGroups[data.chatJid];
    // For compound groups, extract base group for authorization
    const sfBaseKey = fsPathToCompoundKey(sourceGroup);
    const { group: sfBaseGroup } = parseCompoundKey(sfBaseKey);
    if (isMain || (targetGroup && targetGroup.folder === sfBaseGroup)) {
      // Resolve container path to host path (or pass through absolute host paths)
      let hostFilePath: string | null;
      if (
        isMain &&
        data.filePath.startsWith('/') &&
        !data.filePath.startsWith('/workspace/') &&
        !data.filePath.includes('..') &&
        fs.existsSync(data.filePath)
      ) {
        // Absolute host path pass-through: restricted to main group only.
        // Non-main groups would otherwise be able to exfiltrate arbitrary
        // host files (SSH keys, credentials) by sending them to their own JID.
        hostFilePath = data.filePath;
      } else {
        hostFilePath = resolveContainerFilePathToHost(
          data.filePath,
          sourceGroup,
          registeredGroups,
        );
      }
      if (!hostFilePath || !fs.existsSync(hostFilePath)) {
        logger.warn(
          {
            chatJid: data.chatJid,
            sourceGroup,
            containerPath: data.filePath,
            hostFilePath,
          },
          'IPC send_file: file not found or path not resolvable',
        );
      } else {
        // C2: extension allowlist for non-main. Fast reject before the
        // content-sample credential check so we never open files we don't
        // intend to send anyway (archives, data stores, executables).
        if (!isMain && !isSendFileExtensionAllowed(hostFilePath)) {
          logger.warn(
            { sourceGroup, chatJid: data.chatJid, hostFilePath },
            'IPC send_file rejected: extension not in allowlist',
          );
          return;
        }
        // B2/B4: credential blocklist. Main-group bypasses (operator
        // tooling legitimately forwards tokens). Non-main checks both
        // filename and a content sample so rename-to-x.json doesn't
        // defeat it.
        if (!isMain) {
          try {
            const fd = fs.openSync(hostFilePath, 'r');
            const sample = Buffer.alloc(65536);
            const bytes = fs.readSync(fd, sample, 0, sample.length, 0);
            fs.closeSync(fd);
            const slice = sample.subarray(0, bytes);
            if (isFileCredentialLike(hostFilePath, slice)) {
              logger.warn(
                { sourceGroup, chatJid: data.chatJid, hostFilePath },
                'IPC send_file rejected: credential-like file from non-main',
              );
              return;
            }
          } catch (err) {
            logger.warn(
              { err, hostFilePath },
              'IPC send_file: failed to read credential sample (proceeding)',
            );
          }
        }
        await deps.sendFile(data.chatJid, hostFilePath, data.caption);
        logger.info(
          {
            chatJid: data.chatJid,
            sourceGroup,
            hostFilePath,
          },
          'IPC file sent',
        );
      }
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC send_file attempt blocked',
      );
    }
  } else if (data.type === 'set_proactive_pause') {
    if (!isMain) {
      logger.warn(
        { sourceGroup },
        'IPC set_proactive_pause rejected: not main',
      );
      return;
    }
    const pauseFile =
      process.env.PROACTIVE_PAUSE_PATH_OVERRIDE || PROACTIVE_PAUSE_PATH;
    const pausedUntil =
      typeof data.pausedUntil === 'string' ? data.pausedUntil : null;
    writePause(pauseFile, pausedUntil);
    logger.info({ pausedUntil }, 'proactive pause updated');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Clean up stale .processing files from previous crashes.
  // These represent IPC that may or may not have been executed,
  // so we move them to errors/ for manual inspection rather than replaying.
  cleanupStaleProcessing(ipcBaseDir);

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory).
    // scanIpcGroupFolders wraps the Dir handle in try/finally and emits an
    // FD-pressure diagnostic on EMFILE/ENFILE before re-throwing.
    let groupFolders: string[];
    try {
      groupFolders = scanIpcGroupFolders(ipcBaseDir);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            // Claim the file by renaming to .processing before executing
            // side effects. If we crash after send but before cleanup,
            // the .processing file won't be re-read on next poll.
            const processingPath = `${filePath}.processing`;
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              continue; // another poll cycle already claimed it
            }
            try {
              const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
              await processIpcMessage(data, sourceGroup, isMain, deps);
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                // processingPath may already be gone
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            const processingPath = `${filePath}.processing`;
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              continue;
            }
            try {
              const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                // processingPath may already be gone
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  registerBuiltinHandlers();

  const handlerCtx = buildContext(sourceGroup, isMain, deps);
  const result = await dispatchIpcAction(
    data as { type: string } & Record<string, unknown>,
    handlerCtx,
  );
  if (result.handled) return;

  switch (data.type) {
    // schedule_task / pause_task / resume_task / cancel_task / update_task
    // migrated to src/ipc/handlers/ — dispatched above.

    // update_task migrated to src/ipc/handlers/update-task.ts.

    // refresh_groups + register_group migrated to src/ipc/handlers/.

    // publish_to_bus migrated to src/ipc/handlers/publish-to-bus.ts.

    // knowledge_publish migrated to src/ipc/handlers/knowledge-publish.ts.

    // write_agent_memory + write_agent_state migrated to src/ipc/handlers/.

    default: {
      let handled = false;
      // deploy_mini_app migrated to src/ipc/handlers/deploy-mini-app.ts.
      // dashboard_query migrated to src/ipc/handlers/dashboard-query.ts —
      // both dispatched via the IpcHandler registry above (dispatchIpcAction).
      // pageindex_* migrated to src/ipc/handlers/pageindex.ts — dispatched
      // via the IpcHandler registry above. The per-call mount resolution
      // lives in pageindex.ts:resolveMountsForGroup (execute-time).
      // kg_query migrated to src/ipc/handlers/kg-query.ts — dispatched via
      // the IpcHandler registry above (dispatchIpcAction).
      // task_add / task_list / task_close / task_reopen migrated to
      // src/ipc/handlers/tasks.ts — dispatched via the IpcHandler registry
      // above (dispatchIpcAction).
      // imessage_* migrated to src/ipc/handlers/imessage.ts — dispatched
      // via the IpcHandler registry above (dispatchIpcAction).
      // slack_dm_read AND slack_dm migrated to src/ipc/handlers/slack.ts —
      // both dispatched via the IpcHandler registry above
      // (dispatchIpcAction). slack_dm uses postHocNotify: true (added in
      // Batch 2F.1) to fire a Telegram notify after the result file is
      // written.
      // save_skill / crystallize_skill / skill_search / skill_invoked
      // migrated to src/ipc/handlers/skills.ts — all dispatched via the
      // IpcHandler registry above (dispatchIpcAction). All 4 use
      // skipGate: true (preserve-bypass per Batch 2G; trust.yaml has 9
      // dormant save_skill: draft entries that the gate-bypass keeps
      // inactive — future Batch 4 candidate).
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type.startsWith('x_')
      ) {
        try {
          const modPath = [
            '..',
            '.claude',
            'skills',
            'x-integration',
            'host.js',
          ].join('/');
          const mod = await import(modPath);
          handled = await mod.handleXIpc(
            data as Record<string, unknown>,
            sourceGroup,
            isMain,
            DATA_DIR,
          );
        } catch (err) {
          logger.warn({ err }, 'X integration handler not available');
        }
      }
      if (
        !handled &&
        typeof data.type === 'string' &&
        data.type.startsWith('browser_')
      ) {
        try {
          const modPath = [
            '..',
            '.claude',
            'skills',
            'browser-automation',
            'host.js',
          ].join('/');
          const mod = await import(modPath);
          handled = await mod.handleBrowserIpc(
            data as Record<string, unknown>,
            sourceGroup,
            isMain,
            DATA_DIR,
          );
        } catch (err) {
          logger.warn({ err }, 'Browser automation handler not available');
        }
      }
      if (!handled) {
        logger.warn({ type: data.type }, 'Unknown IPC task type');
      }
    }
  }
}
