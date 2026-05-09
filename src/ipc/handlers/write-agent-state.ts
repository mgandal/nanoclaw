import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  content: string;
  append: boolean;
}

export const writeAgentStateHandler: IpcHandler<Input> = {
  type: 'write_agent_state',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.content !== 'string' || r.content.length === 0) return null;
    return {
      content: r.content,
      append: r.append === true,
    };
  },

  authorize(input, ctx) {
    if (!ctx.agentName) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'write_agent_state from non-compound group',
      );
      return null;
    }

    // Defense in depth — agent name comes from a directory created by the
    // host, but cheap to verify it can't escape AGENTS_DIR.
    if (ctx.agentName.includes('..') || ctx.agentName.includes('/')) {
      logger.warn(
        { agent: ctx.agentName, sourceGroup: ctx.sourceGroup },
        'write_agent_state: invalid agent name',
      );
      return null;
    }

    const agentDir = path.join(AGENTS_DIR, ctx.agentName);
    if (!fs.existsSync(agentDir)) {
      logger.warn(
        { agent: ctx.agentName, sourceGroup: ctx.sourceGroup },
        'write_agent_state: agent directory does not exist',
      );
      return null;
    }

    const summaryShape = input.append ? 'state.md append' : 'state.md replace';
    const notifyShape = `${input.append ? 'appended to' : 'replaced'} state.md`;
    return {
      target: ctx.agentName,
      auditSummary: summaryShape,
      notifySummary: notifyShape,
      payloadForStaging: {
        type: 'write_agent_state',
        content: input.content,
        append: input.append,
      },
    };
  },

  execute(input, ctx) {
    // ctx.agentName is non-null here — authorize rejected non-compound callers.
    const agent = ctx.agentName as string;
    const statePath = path.join(AGENTS_DIR, agent, 'state.md');
    const tmpPath = `${statePath}.tmp`;
    const finalContent = input.append
      ? (fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : '') +
        '\n' +
        input.content
      : input.content;
    fs.writeFileSync(tmpPath, finalContent);
    fs.renameSync(tmpPath, statePath);
    logger.info({ agent }, 'Agent state updated via IPC');
  },
};
