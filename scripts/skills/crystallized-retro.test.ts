import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  categorize,
  loadSkillsForAgent,
  parseFrontmatter,
  formatTextReport,
  type SkillRecord,
} from './crystallized-retro.js';

let tmpDir: string;
let agentsRoot: string;

function seedSkill(
  agent: string,
  name: string,
  fm: Partial<{
    crystallized_at: string;
    source_task: string;
    confidence: number;
    invocation_count: number;
    last_invoked_at: string;
  }>,
): void {
  const dir = path.join(agentsRoot, agent, 'skills', 'crystallized', name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, 'description: "demo"'];
  if (fm.crystallized_at)
    lines.push(`crystallized_at: ${fm.crystallized_at}`);
  if (fm.source_task !== undefined)
    lines.push(`source_task: ${JSON.stringify(fm.source_task)}`);
  if (fm.confidence !== undefined) lines.push(`confidence: ${fm.confidence}`);
  if (fm.invocation_count !== undefined)
    lines.push(`invocation_count: ${fm.invocation_count}`);
  if (fm.last_invoked_at) lines.push(`last_invoked_at: ${fm.last_invoked_at}`);
  lines.push('---', '', 'body content', '');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-test-'));
  agentsRoot = path.join(tmpDir, 'data', 'agents');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('extracts JSON-quoted strings cleanly', () => {
    seedSkill('claire', 'demo', {
      crystallized_at: '2026-04-01T00:00:00.000Z',
      source_task: 'a "quoted" task',
      confidence: 7,
      invocation_count: 3,
    });
    const fm = parseFrontmatter(
      path.join(
        agentsRoot,
        'claire',
        'skills',
        'crystallized',
        'demo',
        'SKILL.md',
      ),
    );
    expect(fm).not.toBeNull();
    expect(fm?.name).toBe('demo');
    expect(fm?.source_task).toBe('a "quoted" task');
    expect(fm?.confidence).toBe('7');
    expect(fm?.invocation_count).toBe('3');
  });

  it('returns null on a missing file', () => {
    expect(parseFrontmatter('/nonexistent/SKILL.md')).toBeNull();
  });
});

describe('loadSkillsForAgent', () => {
  it('returns empty array when crystallized dir missing', () => {
    fs.mkdirSync(path.join(agentsRoot, 'claire'), { recursive: true });
    expect(loadSkillsForAgent(agentsRoot, 'claire')).toEqual([]);
  });

  it('skips a skill dir without SKILL.md', () => {
    const incomplete = path.join(
      agentsRoot,
      'claire',
      'skills',
      'crystallized',
      'incomplete',
    );
    fs.mkdirSync(incomplete, { recursive: true });
    seedSkill('claire', 'real', { invocation_count: 1 });
    const records = loadSkillsForAgent(agentsRoot, 'claire');
    expect(records.map((r) => r.name)).toEqual(['real']);
  });

  it('parses invocation_count and confidence as numbers', () => {
    seedSkill('claire', 'demo', { confidence: 8, invocation_count: 5 });
    const [r] = loadSkillsForAgent(agentsRoot, 'claire');
    expect(r.confidence).toBe(8);
    expect(r.invocationCount).toBe(5);
  });
});

describe('categorize', () => {
  const baseRecord: SkillRecord = {
    agent: 'claire',
    name: 'demo',
    crystallizedAt: '2026-04-01T00:00:00.000Z',
    sourceTask: 'demo',
    confidence: 7,
    invocationCount: 0,
    lastInvokedAt: null,
  };
  // Pretend "now" is 30 days after crystallizedAt.
  const now = Date.parse('2026-05-01T00:00:00.000Z');

  it('promotes skills with >= 3 invocations regardless of age', () => {
    expect(categorize({ ...baseRecord, invocationCount: 3 }, now)).toBe('promote');
    expect(
      categorize(
        { ...baseRecord, invocationCount: 99, crystallizedAt: '2026-04-30T00:00:00.000Z' },
        now,
      ),
    ).toBe('promote');
  });

  it('marks 0-invocation skills older than 14d as stale', () => {
    expect(categorize(baseRecord, now)).toBe('stale');
  });

  it('marks 0-invocation skills younger than 14d as recent', () => {
    // 10 days after crystallizedAt (2026-04-01).
    const recent = Date.parse('2026-04-11T00:00:00.000Z');
    expect(categorize(baseRecord, recent)).toBe('recent');
  });

  it('treats skills with unparseable crystallizedAt as recent (defensive default)', () => {
    expect(categorize({ ...baseRecord, crystallizedAt: '' }, now)).toBe('recent');
  });
});

describe('formatTextReport', () => {
  it('prints (no crystallized skills found) on empty input', () => {
    const out = formatTextReport({ promote: [], stale: [], recent: [] });
    expect(out).toContain('(no crystallized skills found)');
  });

  it('lists promotion candidates with invocation counts', () => {
    const r: SkillRecord = {
      agent: 'claire',
      name: 'deadline',
      crystallizedAt: '2026-04-01T00:00:00.000Z',
      sourceTask: 'demo',
      confidence: 7,
      invocationCount: 5,
      lastInvokedAt: null,
    };
    const out = formatTextReport({ promote: [r], stale: [], recent: [] });
    expect(out).toContain('claire/deadline');
    expect(out).toContain('5 invocations');
    expect(out).toContain('conf=7');
  });
});
