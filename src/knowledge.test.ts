import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { publishKnowledge, type KnowledgeEntry } from './knowledge.js';

describe('publishKnowledge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a markdown file with correct YAML frontmatter', () => {
    const entry: KnowledgeEntry = {
      topic: 'APA regulation',
      finding: 'ChromBERT can predict TF binding at APA sites',
      evidence: 'Paper DOI 10.1234/test',
      tags: ['GWAS', 'APA'],
    };

    const filePath = publishKnowledge(entry, 'telegram_science-claw', tmpDir);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('agent: telegram_science-claw');
    expect(content).toContain('topic: APA regulation');
    expect(content).toContain('tags:');
    expect(content).toContain('- GWAS');
    expect(content).toContain('ChromBERT can predict TF binding');
  });

  it('overwrites agent field from sourceGroup — ignores payload agent', () => {
    const entry: KnowledgeEntry = {
      topic: 'test',
      finding: 'test finding',
      evidence: 'none',
      tags: [],
      agent: 'claire',
    };

    const filePath = publishKnowledge(entry, 'telegram_science-claw', tmpDir);
    const content = fs.readFileSync(filePath, 'utf-8');

    expect(content).toContain('agent: telegram_science-claw');
    expect(content).not.toContain('agent: claire');
  });

  it('generates unique filenames for concurrent writes', () => {
    const entry: KnowledgeEntry = {
      topic: 'test',
      finding: 'finding 1',
      evidence: 'none',
      tags: [],
    };

    const path1 = publishKnowledge(entry, 'group-a', tmpDir);
    const path2 = publishKnowledge(
      { ...entry, finding: 'finding 2' },
      'group-b',
      tmpDir,
    );

    expect(path1).not.toBe(path2);
    expect(fs.existsSync(path1)).toBe(true);
    expect(fs.existsSync(path2)).toBe(true);
  });
});
