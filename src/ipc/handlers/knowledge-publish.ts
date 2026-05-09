import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import type { IpcHandler } from '../handler.js';

interface Input {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
}

const KNOWLEDGE_DIR = path.join(DATA_DIR, 'agent-knowledge');
const AUDIT_TARGET = 'agent-knowledge';

export const knowledgePublishHandler: IpcHandler<Input> = {
  type: 'knowledge_publish',

  parse(raw) {
    // Original case accepted any payload, substituting sensible defaults for
    // missing fields. Preserve that lenient behavior — no reject path here.
    const r =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    return {
      topic: typeof r.topic === 'string' ? r.topic : 'unknown',
      finding: typeof r.finding === 'string' ? r.finding : '',
      evidence: typeof r.evidence === 'string' ? r.evidence : '',
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    };
  },

  authorize(input) {
    return {
      target: AUDIT_TARGET,
      auditSummary: input.topic,
      notifySummary: `published "${input.topic}"`,
      payloadForStaging: {
        type: 'knowledge_publish',
        topic: input.topic,
        finding: input.finding,
        evidence: input.evidence,
        tags: input.tags,
      },
    };
  },

  async execute(input, ctx) {
    const { publishKnowledge } = await import('../../knowledge.js');
    const filePath = publishKnowledge(input, ctx.sourceGroup, KNOWLEDGE_DIR);
    logger.info(
      { sourceGroup: ctx.sourceGroup, topic: input.topic, filePath },
      'Knowledge entry published',
    );

    if (ctx.deps.messageBus) {
      ctx.deps.messageBus.publish({
        from: ctx.sourceGroup,
        topic: `knowledge:${input.topic}`,
        summary: input.finding.slice(0, 200),
        action_needed: '',
        priority: 'low',
      });
    }
  },
};
