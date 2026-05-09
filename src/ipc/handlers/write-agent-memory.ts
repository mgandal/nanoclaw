import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  content: string;
  section?: string;
  /**
   * Resolved target agent. Filled in by authorize() — for agent callers this
   * is always the caller's own agent (ctx.agentName); for main-group callers
   * this comes from the payload's agent_name (admin escape hatch).
   */
  resolvedAgent: string;
  /** Raw payload value, kept around for the resolution step in authorize. */
  payloadAgentName: string;
}

const CONTENT_MAX_BYTES = 64 * 1024;
const SECTION_NAME_RE = /^[\w\s-]{1,80}$/;

export const writeAgentMemoryHandler: IpcHandler<Input> = {
  type: 'write_agent_memory',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    if (typeof r.content !== 'string' || r.content.length === 0) return null;

    // C6: cap content. memory.md is read back into future context packets;
    // an unbounded write is a cheap context-poisoning primitive.
    if (r.content.length > CONTENT_MAX_BYTES) {
      logger.warn(
        { size: r.content.length },
        'write_agent_memory: content exceeds 64KB cap',
      );
      return null;
    }

    let section: string | undefined;
    if (r.section !== undefined) {
      if (typeof r.section !== 'string' || !SECTION_NAME_RE.test(r.section)) {
        logger.warn(
          { section: r.section },
          'write_agent_memory: invalid section name (must match /^[\\w\\s-]{1,80}$/)',
        );
        return null;
      }
      section = r.section;
    }

    return {
      content: r.content,
      section,
      payloadAgentName: typeof r.agent_name === 'string' ? r.agent_name : '',
      resolvedAgent: '', // populated in authorize
    };
  },

  authorize(input, ctx) {
    // Target agent is the compound-key caller's agent, OR for main groups
    // only, the payload's agent_name (admin escape hatch). Non-main non-
    // compound callers cannot determine an agent and must be rejected —
    // otherwise any group could overwrite any agent's memory with arbitrary
    // content.
    const payloadAgent = input.payloadAgentName || undefined;
    const resolvedAgent =
      ctx.agentName || (ctx.isMain ? payloadAgent : undefined);
    if (!resolvedAgent) {
      logger.warn(
        {
          sourceGroup: ctx.sourceGroup,
          payloadAgentProvided: Boolean(payloadAgent),
        },
        'write_agent_memory: cannot determine agent name (must be sent from a compound-key directory, or from main with agent_name)',
      );
      return null;
    }

    if (resolvedAgent.includes('..') || resolvedAgent.includes('/')) {
      logger.warn(
        { agentName: resolvedAgent, sourceGroup: ctx.sourceGroup },
        'write_agent_memory: invalid agent name',
      );
      return null;
    }
    const agentDir = path.join(AGENTS_DIR, resolvedAgent);
    if (!fs.existsSync(agentDir)) {
      logger.warn(
        { agentName: resolvedAgent, sourceGroup: ctx.sourceGroup },
        'write_agent_memory: invalid agent name',
      );
      return null;
    }

    // Pin the resolved agent onto the input so execute() doesn't re-derive
    // the policy. Cheap; the input object lives only for this dispatch.
    input.resolvedAgent = resolvedAgent;

    const sectionLabel = input.section || '(full)';
    return {
      target: resolvedAgent,
      auditSummary: sectionLabel,
      notifySummary: `wrote memory.md ${input.section ? `(section "${input.section}")` : '(full)'} for ${resolvedAgent}`,
      payloadForStaging: {
        type: 'write_agent_memory',
        section: input.section,
        content: input.content,
        agent_name: resolvedAgent,
      },
    };
  },

  execute(input) {
    const agentDir = path.join(AGENTS_DIR, input.resolvedAgent);
    const memoryPath = path.join(agentDir, 'memory.md');
    const tmpPath = `${memoryPath}.tmp`;

    if (input.section) {
      const existing = fs.existsSync(memoryPath)
        ? fs.readFileSync(memoryPath, 'utf-8')
        : `# ${input.resolvedAgent} — Memory\n`;
      const sectionHeader = `## ${input.section}`;
      const escapedHeader = sectionHeader.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );
      const sectionRegex = new RegExp(
        `${escapedHeader}\\n[\\s\\S]*?(?=\\n## |$)`,
      );
      const newSection = `${sectionHeader}\n${input.content}`;
      const updated = sectionRegex.test(existing)
        ? existing.replace(sectionRegex, newSection)
        : `${existing.trimEnd()}\n\n${newSection}\n`;
      fs.writeFileSync(tmpPath, updated);
    } else {
      fs.writeFileSync(tmpPath, input.content);
    }
    fs.renameSync(tmpPath, memoryPath);
    logger.info(
      { agent: input.resolvedAgent, section: input.section || '(full)' },
      'Agent memory updated via IPC',
    );
  },
};
