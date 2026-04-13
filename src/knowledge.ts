import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface KnowledgeEntry {
  topic: string;
  finding: string;
  evidence: string;
  tags: string[];
  /** Ignored — overwritten by verified sourceGroup. */
  agent?: string;
}

/**
 * Write a knowledge entry as a markdown file with YAML frontmatter.
 * The agent field is ALWAYS set from sourceGroup, never from the entry payload.
 * This prevents cross-agent knowledge poisoning.
 */
export function publishKnowledge(
  entry: KnowledgeEntry,
  sourceGroup: string,
  knowledgeDir: string,
): string {
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const id = crypto.randomUUID().slice(0, 8);
  const slug = entry.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const fileName = `${date}-${slug}-${id}.md`;
  const filePath = path.join(knowledgeDir, fileName);

  const tagsYaml =
    entry.tags.length > 0
      ? `tags:\n${entry.tags.map((t) => `  - ${t}`).join('\n')}`
      : 'tags: []';

  const content = `---
agent: ${sourceGroup}
topic: ${entry.topic}
date: ${date}
${tagsYaml}
---

${entry.finding}

**Evidence:** ${entry.evidence}
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
