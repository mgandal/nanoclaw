import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { runAgentTurn } from './agent-turn.js';
import { _initTestDatabase, getSessionTimestamps, setSession } from './db.js';
import { DATA_DIR } from './config.js';
import type { RegisteredGroup } from './types.js';

const mockRun = vi.mocked(runContainerAgent);

const GROUP: RegisteredGroup = {
  name: 'Test',
  folder: 'agentturn_test_group',
  trigger: '@Claire',
  added_at: '2024-01-01T00:00:00.000Z',
};

const SESSIONS_ROOT = path.join(DATA_DIR, 'sessions');

function transcriptPath(folder: string, sessionId: string): string {
  return path.join(
    SESSIONS_ROOT,
    folder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

function writeTranscript(folder: string, sessionId: string, bytes: number) {
  const p = transcriptPath(folder, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x61));
}

function output(partial: Partial<ContainerOutput>): ContainerOutput {
  return { status: 'success', result: null, ...partial } as ContainerOutput;
}

let sessions: Record<string, string>;

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    group: GROUP,
    prompt: 'hello',
    chatJid: 'tg:test123',
    sessionKey: GROUP.folder,
    sessionPolicy: {},
    sessions,
    registerProcess: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  sessions = {};
  mockRun.mockReset();
  mockRun.mockResolvedValue(output({}));
});

afterEach(() => {
  fs.rmSync(path.join(SESSIONS_ROOT, GROUP.folder), {
    recursive: true,
    force: true,
  });
});

describe('runAgentTurn session reuse and expiry', () => {
  it('passes the stored sessionId through when no policy threshold trips', async () => {
    sessions[GROUP.folder] = 'sess-live';
    setSession(GROUP.folder, 'sess-live');
    await runAgentTurn(
      baseOpts({
        sessionPolicy: { idleMs: 60_000_000, maxAgeMs: 60_000_000 },
      }) as never,
    );
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][1].sessionId).toBe('sess-live');
  });

  it('expires a session past maxAgeMs and spawns fresh', async () => {
    sessions[GROUP.folder] = 'sess-old';
    setSession(GROUP.folder, 'sess-old');
    // created_at is set by setSession to now; force age expiry with tiny maxAge
    await new Promise((r) => setTimeout(r, 5));
    await runAgentTurn(
      baseOpts({ sessionPolicy: { idleMs: 60_000_000, maxAgeMs: 1 } }) as never,
    );
    expect(mockRun.mock.calls[0][1].sessionId).toBeUndefined();
    expect(sessions[GROUP.folder]).toBeUndefined();
  });

  it('size-only policy skips idle/age (scheduled group-context semantics)', async () => {
    sessions[GROUP.folder] = 'sess-warm';
    setSession(GROUP.folder, 'sess-warm');
    writeTranscript(GROUP.folder, 'sess-warm', 128);
    await new Promise((r) => setTimeout(r, 5));
    // Ancient by age standards (maxAge/idle omitted) but under size cap → kept.
    await runAgentTurn(
      baseOpts({ sessionPolicy: { maxSizeBytes: 1024 } }) as never,
    );
    expect(mockRun.mock.calls[0][1].sessionId).toBe('sess-warm');
  });

  it('rotates an oversized session under a size-only policy', async () => {
    sessions[GROUP.folder] = 'sess-fat';
    setSession(GROUP.folder, 'sess-fat');
    writeTranscript(GROUP.folder, 'sess-fat', 4096);
    await runAgentTurn(
      baseOpts({ sessionPolicy: { maxSizeBytes: 1024 } }) as never,
    );
    expect(mockRun.mock.calls[0][1].sessionId).toBeUndefined();
    expect(sessions[GROUP.folder]).toBeUndefined();
  });

  it('sizes the transcript by the BARE folder for a compound sessionKey', async () => {
    const compound = `${GROUP.folder}:einstein`;
    sessions[compound] = 'sess-agent';
    setSession(compound, 'sess-agent');
    // Transcript lives under the BARE group folder on disk.
    writeTranscript(GROUP.folder, 'sess-agent', 4096);
    await runAgentTurn(
      baseOpts({
        sessionKey: compound,
        sessionPolicy: { maxSizeBytes: 1024 },
      }) as never,
    );
    // Oversized → rotated, proving the size stat found the bare-folder path.
    expect(mockRun.mock.calls[0][1].sessionId).toBeUndefined();
    expect(sessions[compound]).toBeUndefined();
  });

  it('a null sessionKey runs stateless: no reuse, no persistence', async () => {
    mockRun.mockResolvedValue(output({ newSessionId: 'sess-new' }));
    await runAgentTurn(baseOpts({ sessionKey: null }) as never);
    expect(mockRun.mock.calls[0][1].sessionId).toBeUndefined();
    expect(sessions).toEqual({});
    expect(getSessionTimestamps(GROUP.folder).createdAt).toBeUndefined();
  });
});

describe('runAgentTurn session persistence', () => {
  it('persists a newSessionId from the final output (map + db)', async () => {
    mockRun.mockResolvedValue(output({ newSessionId: 'sess-new' }));
    await runAgentTurn(baseOpts() as never);
    expect(sessions[GROUP.folder]).toBe('sess-new');
    expect(getSessionTimestamps(GROUP.folder).createdAt).toBeDefined();
  });

  it('persists a streamed newSessionId even when the caller passed no onOutput', async () => {
    mockRun.mockImplementation(async (_g, _p, _reg, onOutput) => {
      await onOutput?.(output({ newSessionId: 'sess-streamed' }));
      return output({});
    });
    await runAgentTurn(baseOpts() as never);
    expect(sessions[GROUP.folder]).toBe('sess-streamed');
  });

  it('still forwards streamed output to the caller onOutput', async () => {
    const seen: string[] = [];
    mockRun.mockImplementation(async (_g, _p, _reg, onOutput) => {
      await onOutput?.(output({ result: 'partial' }));
      return output({});
    });
    await runAgentTurn(
      baseOpts({
        onOutput: async (o: ContainerOutput) => {
          if (o.result) seen.push(o.result);
        },
      }) as never,
    );
    expect(seen).toEqual(['partial']);
  });

  it('touches last_used when resuming without a new session id', async () => {
    sessions[GROUP.folder] = 'sess-live';
    setSession(GROUP.folder, 'sess-live');
    const before = getSessionTimestamps(GROUP.folder).lastUsed;
    await new Promise((r) => setTimeout(r, 15));
    await runAgentTurn(
      baseOpts({
        sessionPolicy: { idleMs: 60_000_000, maxAgeMs: 60_000_000 },
      }) as never,
    );
    const after = getSessionTimestamps(GROUP.folder).lastUsed;
    expect(after).not.toBe(before);
  });

  it('clears the session when the output is a stale-session error', async () => {
    sessions[GROUP.folder] = 'sess-poison';
    setSession(GROUP.folder, 'sess-poison');
    mockRun.mockResolvedValue(
      output({
        status: 'error',
        error: 'API Error: could not process image',
      }),
    );
    const out = await runAgentTurn(
      baseOpts({
        sessionPolicy: { idleMs: 60_000_000, maxAgeMs: 60_000_000 },
      }) as never,
    );
    expect(out.status).toBe('error');
    expect(sessions[GROUP.folder]).toBeUndefined();
    expect(getSessionTimestamps(GROUP.folder).createdAt).toBeUndefined();
  });

  it('keeps the session on a non-stale error', async () => {
    sessions[GROUP.folder] = 'sess-live';
    setSession(GROUP.folder, 'sess-live');
    mockRun.mockResolvedValue(
      output({ status: 'error', error: 'network flake' }),
    );
    await runAgentTurn(
      baseOpts({
        sessionPolicy: { idleMs: 60_000_000, maxAgeMs: 60_000_000 },
      }) as never,
    );
    expect(sessions[GROUP.folder]).toBe('sess-live');
  });
});

describe('runAgentTurn container invocation', () => {
  it('threads scheduled-task params through to runContainerAgent', async () => {
    await runAgentTurn(
      baseOpts({
        sessionKey: null,
        agentName: 'einstein',
        isScheduledTask: true,
        script: 'exit 0',
        extraEnv: { PROACTIVE_CORRELATION_ID: 'task:1:2026-07-14' },
      }) as never,
    );
    const params = mockRun.mock.calls[0][1];
    expect(params.agentName).toBe('einstein');
    expect(params.isScheduledTask).toBe(true);
    expect(params.script).toBe('exit 0');
    expect(params.extraEnv).toEqual({
      PROACTIVE_CORRELATION_ID: 'task:1:2026-07-14',
    });
  });

  it('propagates a runContainerAgent throw after no session mutation', async () => {
    sessions[GROUP.folder] = 'sess-live';
    setSession(GROUP.folder, 'sess-live');
    mockRun.mockRejectedValue(new Error('spawn failed'));
    await expect(
      runAgentTurn(
        baseOpts({
          sessionPolicy: { idleMs: 60_000_000, maxAgeMs: 60_000_000 },
        }) as never,
      ),
    ).rejects.toThrow('spawn failed');
    expect(sessions[GROUP.folder]).toBe('sess-live');
  });
});
