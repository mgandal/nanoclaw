/**
 * Tests for container/agent-runner/src/index.ts
 *
 * Covers the pure/near-pure helper functions and classes that form
 * the backbone of the agent runner: transcript parsing, filename
 * sanitization, MCP server config building, message streaming,
 * output formatting, and session summary lookup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  MessageStream,
  sanitizeFilename,
  generateFallbackName,
  parseTranscript,
  formatTranscriptMarkdown,
  writeOutput,
  getSessionSummary,
  buildMcpServers,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  type ContainerInput,
  type ContainerOutput,
} from './index.js';

// ─── sanitizeFilename ────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('lowercases and replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeFilename('Hello World! Test 123')).toBe('hello-world-test-123');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeFilename('---hello---')).toBe('hello');
  });

  it('truncates to 50 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFilename(long).length).toBe(50);
  });

  it('handles special characters', () => {
    expect(sanitizeFilename('café résumé & notes')).toBe('caf-r-sum-notes');
  });

  it('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  it('collapses multiple non-alnum chars into a single hyphen', () => {
    expect(sanitizeFilename('a!!!b???c')).toBe('a-b-c');
  });
});

// ─── generateFallbackName ────────────────────────────────────────────────────

describe('generateFallbackName', () => {
  it('produces conversation-HHMM format', () => {
    const name = generateFallbackName();
    expect(name).toMatch(/^conversation-\d{2}\d{2}$/);
  });

  it('zero-pads hours and minutes', () => {
    // The function reads the current time, so we just verify the format
    const name = generateFallbackName();
    const match = name.match(/^conversation-(\d{2})(\d{2})$/);
    expect(match).not.toBeNull();
    const hours = parseInt(match![1]);
    const minutes = parseInt(match![2]);
    expect(hours).toBeGreaterThanOrEqual(0);
    expect(hours).toBeLessThanOrEqual(23);
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThanOrEqual(59);
  });
});

// ─── parseTranscript ─────────────────────────────────────────────────────────

describe('parseTranscript', () => {
  it('parses user messages with string content', () => {
    const content = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Hello agent' },
    });
    const messages = parseTranscript(content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello agent' });
  });

  it('parses user messages with array content (multimodal)', () => {
    const content = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { type: 'base64', data: 'abc' } },
        ],
      },
    });
    const messages = parseTranscript(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Look at this');
  });

  it('parses assistant messages filtering text blocks', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is my response' },
          { type: 'tool_use', id: 'tool1', name: 'bash', input: {} },
        ],
      },
    });
    const messages = parseTranscript(content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'Here is my response' });
  });

  it('handles multiple messages across lines', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'First' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Second' } }),
    ].join('\n');
    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
  });

  it('skips empty lines and invalid JSON', () => {
    const content = '\n\nnot json\n' + JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Valid' },
    });
    const messages = parseTranscript(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Valid');
  });

  it('skips entries with empty text', () => {
    const content = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '' },
    });
    const messages = parseTranscript(content);
    expect(messages).toHaveLength(0);
  });

  it('returns empty array for completely empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});

// ─── formatTranscriptMarkdown ────────────────────────────────────────────────

describe('formatTranscriptMarkdown', () => {
  it('formats messages into markdown with title', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    const result = formatTranscriptMarkdown(messages, 'Test Chat');
    expect(result).toContain('# Test Chat');
    expect(result).toContain('**User**: Hello');
    expect(result).toContain('**Assistant**: Hi there');
    expect(result).toContain('Archived:');
  });

  it('uses "Conversation" as default title when none provided', () => {
    const messages = [{ role: 'user' as const, content: 'Hi' }];
    const result = formatTranscriptMarkdown(messages, null);
    expect(result).toContain('# Conversation');
  });

  it('uses custom assistant name when provided', () => {
    const messages = [
      { role: 'assistant' as const, content: 'I am Claire' },
    ];
    const result = formatTranscriptMarkdown(messages, 'Chat', 'Claire');
    expect(result).toContain('**Claire**: I am Claire');
  });

  it('truncates long messages at 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const messages = [{ role: 'user' as const, content: longContent }];
    const result = formatTranscriptMarkdown(messages);
    // The formatted line should contain the truncated content + "..."
    const userLine = result.split('\n').find((l) => l.startsWith('**User**:'));
    expect(userLine).toBeDefined();
    // Content portion is after "**User**: " (10 chars)
    const contentPortion = userLine!.slice('**User**: '.length);
    expect(contentPortion.length).toBe(2003); // 2000 + '...'
    expect(contentPortion.endsWith('...')).toBe(true);
  });
});

// ─── writeOutput ─────────────────────────────────────────────────────────────

describe('writeOutput', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('wraps output in start/end markers', () => {
    const output: ContainerOutput = { status: 'success', result: 'done' };
    writeOutput(output);
    expect(consoleLogSpy).toHaveBeenCalledTimes(3);
    expect(consoleLogSpy.mock.calls[0][0]).toBe(OUTPUT_START_MARKER);
    expect(consoleLogSpy.mock.calls[2][0]).toBe(OUTPUT_END_MARKER);
  });

  it('emits valid JSON between markers', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'test result',
      newSessionId: 'sess-123',
    };
    writeOutput(output);
    const jsonStr = consoleLogSpy.mock.calls[1][0] as string;
    const parsed = JSON.parse(jsonStr);
    expect(parsed.status).toBe('success');
    expect(parsed.result).toBe('test result');
    expect(parsed.newSessionId).toBe('sess-123');
  });

  it('handles error output', () => {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'something failed',
    };
    writeOutput(output);
    const jsonStr = consoleLogSpy.mock.calls[1][0] as string;
    const parsed = JSON.parse(jsonStr);
    expect(parsed.status).toBe('error');
    expect(parsed.result).toBeNull();
    expect(parsed.error).toBe('something failed');
  });
});

// ─── getSessionSummary ───────────────────────────────────────────────────────

describe('getSessionSummary', () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
  });

  it('returns summary when session is found in index', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        entries: [
          { sessionId: 'sess-abc', fullPath: '/path', summary: 'Discussed topic X', firstPrompt: 'hi' },
        ],
      }),
    );
    const result = getSessionSummary('sess-abc', '/workspace/project/transcript.jsonl');
    expect(result).toBe('Discussed topic X');
  });

  it('returns null when session ID is not in the index', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({
        entries: [
          { sessionId: 'other-session', fullPath: '/path', summary: 'Other', firstPrompt: 'x' },
        ],
      }),
    );
    const result = getSessionSummary('sess-missing', '/workspace/project/transcript.jsonl');
    expect(result).toBeNull();
  });

  it('returns null when index file does not exist', () => {
    existsSyncSpy.mockReturnValue(false);
    const result = getSessionSummary('sess-abc', '/workspace/project/transcript.jsonl');
    expect(result).toBeNull();
  });

  it('returns null when index file has invalid JSON', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('not valid json');
    const result = getSessionSummary('sess-abc', '/workspace/project/transcript.jsonl');
    expect(result).toBeNull();
  });

  it('constructs correct index path from transcript path', () => {
    existsSyncSpy.mockReturnValue(false);
    getSessionSummary('sess-abc', '/workspace/myproject/transcript.jsonl');
    // existsSync should be called with the sessions-index.json in the same dir
    expect(existsSyncSpy).toHaveBeenCalledWith('/workspace/myproject/sessions-index.json');
  });
});

// ─── buildMcpServers ─────────────────────────────────────────────────────────

describe('buildMcpServers', () => {
  const baseInput: ContainerInput = {
    prompt: 'test',
    groupFolder: 'telegram_claire',
    chatJid: 'chat-123',
    isMain: true,
  };

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all conditional env vars
    const envVars = [
      'QMD_URL', 'HONCHO_URL', 'APPLE_NOTES_URL', 'TODOIST_URL',
      'HINDSIGHT_URL', 'CALENDAR_URL', 'SLACK_MCP_URL',
    ];
    for (const v of envVars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('always includes nanoclaw and ollama servers', () => {
    const servers = buildMcpServers('/path/to/ipc-mcp-stdio.js', baseInput);
    expect(servers.nanoclaw).toBeDefined();
    expect(servers.nanoclaw.command).toBe('node');
    expect(servers.nanoclaw.args).toEqual(['/path/to/ipc-mcp-stdio.js']);
    expect(servers.ollama).toBeDefined();
    expect(servers.ollama.command).toBe('node');
  });

  it('passes isMain as "1" or "0" string in nanoclaw env', () => {
    const mainServers = buildMcpServers('/path.js', { ...baseInput, isMain: true });
    expect(mainServers.nanoclaw.env.NANOCLAW_IS_MAIN).toBe('1');

    const nonMainServers = buildMcpServers('/path.js', { ...baseInput, isMain: false });
    expect(nonMainServers.nanoclaw.env.NANOCLAW_IS_MAIN).toBe('0');
  });

  it('includes QMD server when QMD_URL is set', () => {
    process.env.QMD_URL = 'http://localhost:8181/mcp';
    const servers = buildMcpServers('/path.js', baseInput);
    expect(servers.qmd).toBeDefined();
    expect(servers.qmd.type).toBe('http');
    expect(servers.qmd.url).toBe('http://localhost:8181/mcp');
  });

  it('does not include QMD server when QMD_URL is not set', () => {
    const servers = buildMcpServers('/path.js', baseInput);
    expect(servers.qmd).toBeUndefined();
  });

  it('includes Honcho server when HONCHO_URL is set', () => {
    process.env.HONCHO_URL = 'http://localhost:8010';
    const servers = buildMcpServers('/path.js', baseInput);
    expect(servers.honcho).toBeDefined();
    expect(servers.honcho.command).toBe('node');
    expect(servers.honcho.env.HONCHO_URL).toBe('http://localhost:8010');
    expect(servers.honcho.env.HONCHO_WORKSPACE).toBe('nanoclaw');
    expect(servers.honcho.env.HONCHO_USER_PEER).toBe('mgandal');
  });

  it('uses agentName for Honcho AI peer when provided', () => {
    process.env.HONCHO_URL = 'http://localhost:8010';
    const servers = buildMcpServers('/path.js', { ...baseInput, agentName: 'einstein' });
    expect(servers.honcho.env.HONCHO_AI_PEER).toBe('einstein');
  });

  it('strips telegram_ prefix from groupFolder for Honcho AI peer when no agentName', () => {
    process.env.HONCHO_URL = 'http://localhost:8010';
    const servers = buildMcpServers('/path.js', {
      ...baseInput,
      groupFolder: 'telegram_science-claw',
    });
    expect(servers.honcho.env.HONCHO_AI_PEER).toBe('science-claw');
  });

  it('includes all optional HTTP servers when env vars are set', () => {
    process.env.APPLE_NOTES_URL = 'http://localhost:8184';
    process.env.TODOIST_URL = 'http://localhost:8186';
    process.env.HINDSIGHT_URL = 'http://localhost:8889';
    process.env.CALENDAR_URL = 'http://localhost:8188';
    process.env.SLACK_MCP_URL = 'http://localhost:9000';
    const servers = buildMcpServers('/path.js', baseInput);
    expect(servers.apple_notes).toBeDefined();
    expect(servers.apple_notes.type).toBe('http');
    expect(servers.todoist).toBeDefined();
    expect(servers.todoist.type).toBe('http');
    expect(servers.hindsight).toBeDefined();
    expect(servers.hindsight.type).toBe('http');
    expect(servers.calendar).toBeDefined();
    expect(servers.calendar.type).toBe('http');
    expect(servers.slack).toBeDefined();
    expect(servers.slack.type).toBe('http');
  });

  it('does not include Gmail server when credentials file is absent', () => {
    // Mock fs.existsSync to return false for gmail path (already cleaned env)
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const servers = buildMcpServers('/path.js', baseInput);
    expect(servers.gmail).toBeUndefined();
    existsSpy.mockRestore();
  });
});

// ─── MessageStream ───────────────────────────────────────────────────────────

describe('MessageStream', () => {
  it('yields pushed text messages', async () => {
    const stream = new MessageStream();
    stream.push('Hello');
    stream.push('World');
    stream.end();

    const messages: string[] = [];
    for await (const msg of stream) {
      const content = msg.message.content;
      if (typeof content === 'string') {
        messages.push(content);
      }
    }
    expect(messages).toEqual(['Hello', 'World']);
  });

  it('handles image attachments in content blocks', async () => {
    const stream = new MessageStream();
    stream.push('Caption', [
      { base64: 'imgdata', mediaType: 'image/jpeg' },
    ]);
    stream.end();

    const messages: unknown[] = [];
    for await (const msg of stream) {
      messages.push(msg.message.content);
    }
    expect(messages).toHaveLength(1);
    const content = messages[0] as Array<{ type: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('image');
    expect(content[1].type).toBe('text');
  });

  it('waits for push after queue is drained', async () => {
    const stream = new MessageStream();

    // Push after a short delay
    setTimeout(() => {
      stream.push('Delayed message');
      stream.end();
    }, 10);

    const messages: string[] = [];
    for await (const msg of stream) {
      const content = msg.message.content;
      if (typeof content === 'string') {
        messages.push(content);
      }
    }
    expect(messages).toEqual(['Delayed message']);
  });

  it('all messages have correct SDKUserMessage structure', async () => {
    const stream = new MessageStream();
    stream.push('test');
    stream.end();

    for await (const msg of stream) {
      expect(msg.type).toBe('user');
      expect(msg.message.role).toBe('user');
      expect(msg.parent_tool_use_id).toBeNull();
      expect(msg.session_id).toBe('');
    }
  });

  it('terminates immediately when end() is called on empty queue', async () => {
    const stream = new MessageStream();
    stream.end();

    const messages: unknown[] = [];
    for await (const msg of stream) {
      messages.push(msg);
    }
    expect(messages).toEqual([]);
  });
});

// ─── Output markers ──────────────────────────────────────────────────────────

describe('output markers', () => {
  it('markers are well-formed strings', () => {
    expect(OUTPUT_START_MARKER).toBe('---NANOCLAW_OUTPUT_START---');
    expect(OUTPUT_END_MARKER).toBe('---NANOCLAW_OUTPUT_END---');
  });
});
