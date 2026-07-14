import fs from 'fs';

import { logger } from '../../logger.js';
import {
  isFileCredentialLike,
  isSendFileExtensionAllowed,
  resolveContainerFilePathToHost,
} from '../file-validation.js';
import type {
  ExecuteResult,
  IpcHandler,
  IpcHandlerContext,
} from '../handler.js';

/**
 * `send_file` — deliver a file from an agent/group workspace to a chatJid.
 *
 * Migrated out of the inline processIpcMessage branch onto the registry.
 * The generic dispatcher owns trust gating + staging (keyed on the
 * `send_file` action type) and the post-hoc notify; this handler owns the
 * target-group authorization cross-check and the file-safety pipeline:
 * path resolution (main-only absolute pass-through), the C2 extension
 * allowlist, and the B2/B4 credential blocklist for non-main callers.
 *
 * Behavior change vs the ladder (deliberate, 2026-07-14): agent (compound
 * key) callers are now trust-gated and audited like send_message. The
 * ladder ran file sends ungated with no audit row. Every agent trust.yaml
 * gained `send_file: notify` in the same change; an absent entry stages
 * (fail-safe `ask` default in checkTrust).
 *
 * File-safety rejections happen in execute() as bails ({executed:false}),
 * not authorize() nulls: they depend on disk state, must not stage, and a
 * bail suppresses the post-hoc notify so a rejected send never reports as
 * delivered.
 */
interface Input {
  chatJid: string;
  filePath: string;
  caption?: string;
}

function mainJidOf(ctx: IpcHandlerContext): string | undefined {
  return Object.entries(ctx.registeredGroups).find(([, g]) => g.isMain)?.[0];
}

export const sendFileHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'send_file',
  responseKind: 'notify',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.chatJid !== 'string' || r.chatJid.length === 0) return null;
    if (typeof r.filePath !== 'string' || r.filePath.length === 0) return null;
    return {
      chatJid: r.chatJid,
      filePath: r.filePath,
      caption: typeof r.caption === 'string' ? r.caption : undefined,
    };
  },

  authorize(input, ctx) {
    // Authorization: a group may send to its own jid; main may send anywhere.
    const targetGroup = ctx.registeredGroups[input.chatJid];
    const authorized =
      ctx.isMain || (targetGroup && targetGroup.folder === ctx.baseGroup);
    if (!authorized) {
      logger.warn(
        { chatJid: input.chatJid, sourceGroup: ctx.sourceGroup },
        'Unauthorized IPC send_file attempt blocked',
      );
      return null;
    }

    return {
      target: input.chatJid,
      auditSummary: input.filePath,
      notifySummary: `→ ${targetGroup?.name || input.chatJid}: 📎 ${input.filePath}`,
      payloadForStaging: {
        type: 'send_file',
        chatJid: input.chatJid,
        filePath: input.filePath,
        caption: input.caption,
      },
      // Self-echo guard: skip the receipt when delivering to main itself.
      suppressNotifyWhenTargetIs: mainJidOf(ctx),
    };
  },

  async execute(input, ctx) {
    if (!ctx.deps.sendFile) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'IPC send_file: deps.sendFile not wired, skipping',
      );
      return { executed: false };
    }

    // Resolve container path to host path (or pass through absolute host paths)
    let hostFilePath: string | null;
    if (
      ctx.isMain &&
      input.filePath.startsWith('/') &&
      !input.filePath.startsWith('/workspace/') &&
      !input.filePath.includes('..') &&
      fs.existsSync(input.filePath)
    ) {
      // Absolute host path pass-through: restricted to main group only.
      // Non-main groups would otherwise be able to exfiltrate arbitrary
      // host files (SSH keys, credentials) by sending them to their own JID.
      hostFilePath = input.filePath;
    } else {
      hostFilePath = resolveContainerFilePathToHost(
        input.filePath,
        ctx.sourceGroup,
        ctx.registeredGroups,
      );
    }
    if (!hostFilePath || !fs.existsSync(hostFilePath)) {
      logger.warn(
        {
          chatJid: input.chatJid,
          sourceGroup: ctx.sourceGroup,
          containerPath: input.filePath,
          hostFilePath,
        },
        'IPC send_file: file not found or path not resolvable',
      );
      return { executed: false };
    }

    // C2: extension allowlist for non-main. Fast reject before the
    // content-sample credential check so we never open files we don't
    // intend to send anyway (archives, data stores, executables).
    if (!ctx.isMain && !isSendFileExtensionAllowed(hostFilePath)) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup, chatJid: input.chatJid, hostFilePath },
        'IPC send_file rejected: extension not in allowlist',
      );
      return { executed: false };
    }

    // B2/B4: credential blocklist. Main-group bypasses (operator tooling
    // legitimately forwards tokens). Non-main checks both filename and a
    // content sample so rename-to-x.json doesn't defeat it.
    if (!ctx.isMain) {
      try {
        const fd = fs.openSync(hostFilePath, 'r');
        const sample = Buffer.alloc(65536);
        const bytes = fs.readSync(fd, sample, 0, sample.length, 0);
        fs.closeSync(fd);
        const slice = sample.subarray(0, bytes);
        if (isFileCredentialLike(hostFilePath, slice)) {
          logger.warn(
            {
              sourceGroup: ctx.sourceGroup,
              chatJid: input.chatJid,
              hostFilePath,
            },
            'IPC send_file rejected: credential-like file from non-main',
          );
          return { executed: false };
        }
      } catch (err) {
        logger.warn(
          { err, hostFilePath },
          'IPC send_file: failed to read credential sample (proceeding)',
        );
      }
    }

    await ctx.deps.sendFile(input.chatJid, hostFilePath, input.caption);
    logger.info(
      { chatJid: input.chatJid, sourceGroup: ctx.sourceGroup, hostFilePath },
      'IPC file sent',
    );
  },
};
