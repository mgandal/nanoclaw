import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  extractToolSequence,
  createStopHook,
  __setStopHookTaskDirForTests,
} from './index.js';

describe('extractToolSequence', () => {
  it('parses tool_use entries from a JSONL transcript', () => {
    const tmp = path.join(os.tmpdir(), `t-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'mcp__qmd__query', input: { query: 'grants' } },
      ] }}),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: '1', content: '7 hits' },
      ] }}),
    ];
    fs.writeFileSync(tmp, lines.join('\n'));
    const seq = extractToolSequence(tmp);
    expect(seq).toHaveLength(1);
    expect(seq[0].tool).toBe('mcp__qmd__query');
    expect(seq[0].argSummary).toContain('grants');
    fs.unlinkSync(tmp);
  });

  it('returns empty array on missing file', () => {
    expect(extractToolSequence('/nonexistent')).toEqual([]);
  });
});

describe('createStopHook gate', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
    __setStopHookTaskDirForTests(tmpDir);
  });

  const transcriptWith = (toolNames: string[]) => {
    const tmp = path.join(os.tmpdir(), `t-${Date.now()}-${Math.random()}.jsonl`);
    const lines = toolNames.map(name => JSON.stringify({
      type: 'assistant', message: { content: [
        { type: 'tool_use', name, input: { x: 'y' } },
      ] }}));
    fs.writeFileSync(tmp, lines.join('\n'));
    return tmp;
  };

  it('skips when stop_hook_active=true (R3 re-entry)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: true,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('skips when no agentName', async () => {
    const hook = createStopHook(undefined, 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('skips when assistant text <500 chars', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'short', session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  // Boundary pin: catches `< 500` → `< N (N<500)` mutation
  it('skips at length===499 (gate boundary)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(499), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  // Boundary pin: catches `< 500` → `<= 500` mutation
  it('passes length gate at length===500', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(500), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(1);
  });

  it('skips when <3 distinct MCP tools', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__qmd__query']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  // Boundary pin: catches `< 3` → `< 2` mutation (2 distinct still skips)
  it('skips at distinct===2 (gate boundary)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('counts Skill tool toward distinct (I3)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'Skill']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(1);
  });

  it('skips when "I could not" at sentence start (I2)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    const msg = 'Did the work. ' + 'A'.repeat(490) + ". I couldn't find the answer.";
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: msg, session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('does NOT skip on "the user could not" (I2 false-negative pin)', async () => {
    const hook = createStopHook('marvin', 'g', 'j');
    const msg = ('A'.repeat(500)) + ". The user couldn't find the answer, so I helped.";
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: msg, session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    expect(fs.readdirSync(tmpDir)).toHaveLength(1);
  });

  it('writes IPC file with group+agent+ts+rand in filename (I8)', async () => {
    const hook = createStopHook('marvin', 'telegram_lab-claw', 'tg:-1234');
    await hook({ hook_event_name: 'Stop', stop_hook_active: false,
      transcript_path: transcriptWith(['mcp__qmd__query', 'mcp__honcho__profile', 'mcp__gmail__search']),
      last_assistant_message: 'A'.repeat(600), session_id: 's' } as any, undefined, { signal: new AbortController().signal });
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^crystallize-candidate-telegram_lab-claw-marvin-\d+-[a-z0-9]{6}\.json$/);
    const body = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));
    expect(body.type).toBe('crystallize_candidate');
    expect(body.agent).toBe('marvin');
    expect(body.sourceGroup).toBe('telegram_lab-claw');
    expect(body.sourceJid).toBe('tg:-1234');
    expect(body.traceSummary.length).toBeLessThanOrEqual(2048);
    expect(Array.isArray(body.toolSequence)).toBe(true);
  });
});
