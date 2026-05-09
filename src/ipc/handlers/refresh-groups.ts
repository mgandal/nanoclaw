import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  // refresh_groups carries no input fields; the parsed shape is empty.
  _empty: true;
}

export const refreshGroupsHandler: IpcHandler<Input> = {
  type: 'refresh_groups',

  parse() {
    return { _empty: true };
  },

  authorize(_input, ctx) {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'Unauthorized refresh_groups attempt blocked',
      );
      return null;
    }
    return {
      target: ctx.sourceGroup,
      notifySummary: 'refreshed group metadata',
      payloadForStaging: { type: 'refresh_groups' },
    };
  },

  async execute(_input, ctx) {
    logger.info(
      { sourceGroup: ctx.sourceGroup },
      'Group metadata refresh requested via IPC',
    );
    await ctx.deps.syncGroups(true);
    const availableGroups = ctx.deps.getAvailableGroups();
    ctx.deps.writeGroupsSnapshot(
      ctx.sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(ctx.registeredGroups)),
    );
  },
};
