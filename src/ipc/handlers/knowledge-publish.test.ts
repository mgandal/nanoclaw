import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------- mocks ----------

// Mock child_process at the module level (ESM-safe pattern).
// vi.hoisted ensures mockExecFile is initialized BEFORE the SUT module's
// import-time side effects (the I3 startup probe calls execFile() at import).
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import { knowledgePublishHandler } from './knowledge-publish.js';
import type { IpcHandlerContext } from '../handler.js';

function buildCtx(
  overrides: Partial<IpcHandlerContext> = {},
): IpcHandlerContext {
  return {
    sourceGroup: 'telegram_claire',
    isMain: true,
    baseGroup: 'telegram_claire',
    agentName: 'claire',
    requestId: null,
    registeredGroups: {},
    deps: {
      messageBus: { publish: () => {} } as any,
    } as any,
    dataDir: '/tmp/test',
    ...overrides,
  };
}

describe('knowledgePublishHandler.parse with confidence', () => {
  it('extracts confidence: 7 from raw payload', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
      confidence: 7,
    });
    expect((result as any).confidence).toBe(7);
  });

  it('defaults confidence to 5 when field is missing', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
    });
    expect((result as any).confidence).toBe(5);
  });

  it('normalizes confidence: 0 to 5 (out-of-range)', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
      confidence: 0,
    });
    expect((result as any).confidence).toBe(5);
  });

  it('normalizes confidence: 11 to 5 (out-of-range)', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
      confidence: 11,
    });
    expect((result as any).confidence).toBe(5);
  });

  it('normalizes confidence: 7.5 to 5 (non-integer)', () => {
    const result = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
      confidence: 7.5,
    });
    expect((result as any).confidence).toBe(5);
  });
});

describe('knowledgePublishHandler.execute fires QMD update', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
    mockExecFile.mockReset();
    // Default mock: just return an empty object (no callback invocation).
    mockExecFile.mockImplementation(() => ({}) as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('execute fires execFile(qmd update agent-knowledge) after publishKnowledge completes', async () => {
    const input = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
      confidence: 8,
    });
    await knowledgePublishHandler.execute!(
      input as any,
      buildCtx({ dataDir: tmpDir }),
    );
    // I3 startup probe also calls execFile once; find the publish-side call
    // by matching args rather than asserting on call[0].
    const updateCall = mockExecFile.mock.calls.find(
      (c) =>
        Array.isArray(c[1]) &&
        c[1].length === 2 &&
        c[1][0] === 'update' &&
        c[1][1] === 'agent-knowledge',
    );
    expect(updateCall).toBeDefined();
  });

  it('QMD update subprocess failure is non-fatal (logger.warn, no throw)', async () => {
    // Stub execFile to invoke the callback with an error.
    mockExecFile.mockImplementation(
      (
        _bin: string,
        _args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (typeof cb === 'function') {
          setImmediate(() => cb(new Error('ENOENT: qmd not found')));
        }
        return {} as any;
      },
    );
    const input = knowledgePublishHandler.parse({
      topic: 't',
      finding: 'f',
      evidence: 'e',
      tags: [],
      confidence: 8,
    });
    // Should NOT throw despite the subprocess error
    await expect(
      knowledgePublishHandler.execute!(
        input as any,
        buildCtx({ dataDir: tmpDir }),
      ),
    ).resolves.toBeUndefined();
  });
});
