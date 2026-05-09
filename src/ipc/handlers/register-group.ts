import { isValidGroupFolder } from '../../group-folder.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  containerConfig?: RegisteredGroup['containerConfig'];
  requiresTrigger?: boolean;
}

export const registerGroupHandler: IpcHandler<Input> = {
  type: 'register_group',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.jid !== 'string' ||
      typeof r.name !== 'string' ||
      typeof r.folder !== 'string' ||
      typeof r.trigger !== 'string' ||
      r.jid.length === 0 ||
      r.name.length === 0 ||
      r.folder.length === 0 ||
      r.trigger.length === 0
    ) {
      logger.warn(
        { data: raw },
        'Invalid register_group request - missing required fields',
      );
      return null;
    }
    return {
      jid: r.jid,
      name: r.name,
      folder: r.folder,
      trigger: r.trigger,
      containerConfig: r.containerConfig as Input['containerConfig'],
      requiresTrigger:
        typeof r.requiresTrigger === 'boolean' ? r.requiresTrigger : undefined,
    };
  },

  authorize(input, ctx) {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'Unauthorized register_group attempt blocked',
      );
      return null;
    }
    if (!isValidGroupFolder(input.folder)) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup, folder: input.folder },
        'Invalid register_group request - unsafe folder name',
      );
      return null;
    }
    return {
      target: input.jid,
      notifySummary: `registered group ${input.name}`,
      payloadForStaging: { type: 'register_group', jid: input.jid },
    };
  },

  execute(input, ctx) {
    // Defense in depth: agent cannot set isMain via IPC. Preserve isMain from
    // the existing registration so IPC config updates (e.g. adding
    // additionalMounts) don't strip the flag.
    const existingGroup = ctx.registeredGroups[input.jid];
    ctx.deps.registerGroup(input.jid, {
      name: input.name,
      folder: input.folder,
      trigger: input.trigger,
      added_at: new Date().toISOString(),
      containerConfig: input.containerConfig,
      requiresTrigger: input.requiresTrigger,
      isMain: existingGroup?.isMain,
    });
  },
};
