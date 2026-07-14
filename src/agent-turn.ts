import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { parseCompoundKey } from './compound-key.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import {
  deleteSession,
  getSessionTimestamps,
  setSession,
  touchSession,
} from './db.js';
import { checkSessionExpiry, shouldClearSession } from './index-helpers.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

/**
 * The Session lifecycle around one containerized agent turn, shared by the
 * interactive message loop (runAgent in index.ts) and the scheduler
 * (runTask in task-scheduler.ts). Before this module the two callers
 * mirrored each other by hand — the size-guard, poison-image clearing, and
 * persistence each existed twice and drifted (the scheduler's size guard
 * hand-built the transcript path and its stale-session block was a comment
 * saying "mirrors runAgent()").
 *
 * Policy is expressed by which thresholds are present:
 *   interactive turn:      { idleMs, maxAgeMs, maxSizeBytes } — full expiry
 *   scheduled group-context: { maxSizeBytes } — size-only. Age/idle are
 *     DELIBERATELY absent: group-context tasks keep the session warm across
 *     runs (each wake resumes and appends), so only transcript size bounds
 *     growth. Root cause: 2026-06-23 CLAIRE incident.
 *   stateless (sessionKey: null): no reuse, no persistence — scheduler
 *     isolated-context tasks.
 */
export interface AgentTurnSessionPolicy {
  idleMs?: number;
  maxAgeMs?: number;
  maxSizeBytes?: number;
}

export interface AgentTurnOptions {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  /**
   * Key into the shared sessions map (parsed-form compound key for agent
   * turns, bare folder otherwise). null runs the turn stateless.
   */
  sessionKey: string | null;
  sessionPolicy?: AgentTurnSessionPolicy;
  /** Shared in-memory session map owned by index.ts. */
  sessions: Record<string, string>;
  /**
   * groupFolder passed to the container (defaults to group.folder; the
   * scheduler passes task.group_folder to preserve legacy compound rows).
   */
  groupFolder?: string;
  images?: Array<{ base64: string; mediaType: string }>;
  agentName?: string;
  isScheduledTask?: boolean;
  script?: string;
  extraEnv?: Record<string, string>;
  /** Extra fields merged into session-lifecycle log lines (taskId, etc). */
  logContext?: Record<string, unknown>;
  registerProcess: (
    proc: import('child_process').ChildProcess,
    containerName: string,
  ) => void;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

/**
 * Size in bytes of a session's transcript jsonl, or undefined if it does not
 * exist yet (fresh session, crash mid-write, manual deletion). The on-disk
 * directory is keyed by the BARE group folder — compound agent keys still
 * map to the group's folder; the session id is the filename.
 */
export function sessionFileSize(
  groupFolder: string,
  sessionId: string,
): number | undefined {
  const file = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined; // ENOENT or unreadable → don't trigger size expiry
  }
}

/**
 * Run one containerized agent turn with the full Session lifecycle:
 * policy-driven expiry before spawn, session persistence during/after, and
 * stale-session (poison-image / missing-jsonl) clearing on error.
 *
 * Throws whatever runContainerAgent throws — callers own their error
 * surface (the message loop returns 'error', the scheduler logs the task
 * run). No session state is mutated on a throw.
 */
export async function runAgentTurn(
  opts: AgentTurnOptions,
): Promise<ContainerOutput> {
  const {
    group,
    sessionKey,
    sessions,
    sessionPolicy = {},
    logContext = {},
  } = opts;
  const isMain = group.isMain === true;
  // Transcripts live under the bare group folder even for compound keys.
  const bareFolder = sessionKey
    ? parseCompoundKey(sessionKey).group
    : group.folder;

  let sessionId: string | undefined = sessionKey
    ? sessions[sessionKey]
    : undefined;

  if (sessionKey && sessionId) {
    const { lastUsed, createdAt } = getSessionTimestamps(sessionKey);
    const sizeBytes =
      sessionPolicy.maxSizeBytes !== undefined
        ? sessionFileSize(bareFolder, sessionId)
        : undefined;
    const expireReason = checkSessionExpiry(
      createdAt,
      lastUsed,
      sessionPolicy.idleMs ?? Infinity,
      sessionPolicy.maxAgeMs ?? Infinity,
      sizeBytes,
      sessionPolicy.maxSizeBytes,
    );
    if (expireReason) {
      logger.info(
        {
          group: group.name,
          sessionKey,
          reason: expireReason,
          ...logContext,
        },
        'Session expired, starting fresh',
      );
      delete sessions[sessionKey];
      deleteSession(sessionKey);
      sessionId = undefined;
    }
  }

  const persistNewSessionId = (newSessionId: string) => {
    if (!sessionKey) return;
    sessions[sessionKey] = newSessionId;
    setSession(sessionKey, newSessionId);
  };

  const wrappedOnOutput = async (output: ContainerOutput) => {
    if (output.newSessionId) persistNewSessionId(output.newSessionId);
    await opts.onOutput?.(output);
  };

  const output = await runContainerAgent(
    group,
    {
      prompt: opts.prompt,
      sessionId,
      groupFolder: opts.groupFolder ?? group.folder,
      chatJid: opts.chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      images: opts.images,
      agentName: opts.agentName,
      isScheduledTask: opts.isScheduledTask,
      script: opts.script,
      extraEnv: opts.extraEnv,
    },
    opts.registerProcess,
    wrappedOnOutput,
  );

  if (sessionKey) {
    if (output.newSessionId) {
      persistNewSessionId(output.newSessionId);
    } else if (sessions[sessionKey]) {
      // Session resumed without new ID — still update last_used
      touchSession(sessionKey);
    }

    // Stale/corrupt session or poison image block: clear so the next turn
    // (interactive OR scheduled) starts fresh instead of replaying the bad
    // block and wedging the group permanently.
    if (sessions[sessionKey] && shouldClearSession(output)) {
      logger.warn(
        {
          group: group.name,
          sessionKey,
          staleSessionId: sessions[sessionKey],
          error: output.error,
          ...logContext,
        },
        'Unusable session detected — clearing for next turn',
      );
      delete sessions[sessionKey];
      deleteSession(sessionKey);
    }
  }

  return output;
}
