import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import os from 'os';
import path from 'path';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CONTEXT_PACKET_MAX_SIZE: 8000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  OLLAMA_ADMIN_TOOLS: false,
  OLLAMA_DEFAULT_MODEL: '',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock context-assembler (writeContextPacket does file I/O)
vi.mock('./context-assembler.js', () => ({
  writeContextPacket: vi.fn(async () => {}),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'container',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
  proxyToken: 'test-proxy-token',
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  buildVolumeMounts,
  runContainerAgent,
  setQmdReachable,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  collectToolCalls,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { spawn } from 'child_process';
import fs from 'fs';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import { stopContainer } from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner spawn error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with error when spawn emits ENOENT (runtime not found)', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Need to let the event listeners be registered first
    await vi.advanceTimersByTimeAsync(1);

    // Simulate spawn error: runtime binary not found
    const error = new Error('spawn container ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    fakeProc.emit('error', error);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container spawn error');
    expect(result.error).toContain('ENOENT');
  });

  it('resolves with error when spawn emits EACCES (permission denied)', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(1);

    const error = new Error('spawn container EACCES') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    fakeProc.emit('error', error);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container spawn error');
    expect(result.error).toContain('EACCES');
  });

  it('resolves with error on non-zero exit code and includes stderr tail', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Emit some stderr output to verify it's included in the error
    fakeProc.stderr.push('Error: out of memory\nCannot allocate 4GB\n');

    await vi.advanceTimersByTimeAsync(10);

    // Non-zero exit
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container exited with code 137');
    expect(result.error).toContain('out of memory');
  });
});

describe('container-runner output parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles malformed JSON between markers gracefully', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Push malformed JSON between markers
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{invalid json\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);

    // Then push valid output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Recovery after bad JSON',
    });

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Should still succeed — the valid marker was processed
    expect(result.status).toBe('success');
    // onOutput should have been called only for the valid marker
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Recovery after bad JSON' }),
    );
  });

  it('legacy mode (no onOutput) parses last marker pair from stdout', async () => {
    // No onOutput callback — triggers legacy parsing path
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      // no onOutput
    );

    // Emit two output markers — legacy should pick the last one
    const firstOutput = JSON.stringify({
      status: 'success',
      result: 'first',
    });
    const secondOutput = JSON.stringify({
      status: 'success',
      result: 'second',
      newSessionId: 'sess-legacy',
    });
    fakeProc.stdout.push(
      `some noise\n${OUTPUT_START_MARKER}\n${firstOutput}\n${OUTPUT_END_MARKER}\nmore noise\n${OUTPUT_START_MARKER}\n${secondOutput}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('second');
    expect(result.newSessionId).toBe('sess-legacy');
  });

  it('legacy mode returns error on unparseable stdout', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // No markers at all — just garbage
    fakeProc.stdout.push('this is not JSON at all\nreally not\n');

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Failed to parse container output');
  });
});

describe('container-runner output truncation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('truncates stdout when exceeding CONTAINER_MAX_OUTPUT_SIZE', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // CONTAINER_MAX_OUTPUT_SIZE is 10485760 (10MB) in mock config.
    // Push data that exceeds it. We'll push in chunks to simulate streaming.
    const chunkSize = 1024 * 1024; // 1MB
    for (let i = 0; i < 12; i++) {
      fakeProc.stdout.push('x'.repeat(chunkSize));
    }

    await vi.advanceTimersByTimeAsync(10);

    // Now emit proper output and close
    emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Should still succeed — truncation is for logging, not output parsing
    expect(result.status).toBe('success');
  });

  it('truncates stderr when exceeding CONTAINER_MAX_OUTPUT_SIZE', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Push stderr exceeding the limit
    const chunkSize = 1024 * 1024;
    for (let i = 0; i < 12; i++) {
      fakeProc.stderr.push('e'.repeat(chunkSize));
    }

    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });
});

describe('container-runner environment variable handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    // Reset mocks to defaults to prevent cross-test contamination
    vi.mocked(detectAuthMode).mockReturnValue('api-key');
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up env vars we set during tests
    delete process.env.HONCHO_URL;
    delete process.env.APPLE_NOTES_URL;
    delete process.env.TODOIST_URL;
    delete process.env.HINDSIGHT_URL;
  });

  it('passes OAuth placeholder when auth mode is oauth', async () => {
    vi.mocked(detectAuthMode).mockReturnValue('oauth');

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    // Check the spawn args — env vars are passed as ['-e', 'VAR=value'] pairs
    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];

    // Find env var values (args that follow '-e')
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    // Should have ANTHROPIC_AUTH_TOKEN=placeholder (not ANTHROPIC_API_KEY)
    const authTokenVar = envVars.find((a) =>
      a.startsWith('ANTHROPIC_AUTH_TOKEN='),
    );
    expect(authTokenVar).toBe('ANTHROPIC_AUTH_TOKEN=placeholder');

    // Should NOT have ANTHROPIC_API_KEY
    const apiKeyVar = envVars.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
    expect(apiKeyVar).toBeUndefined();

    // Clean up
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    // Restore default mock
    vi.mocked(detectAuthMode).mockReturnValue('api-key');
  });

  it('passes API key placeholder when auth mode is api-key', async () => {
    vi.mocked(detectAuthMode).mockReturnValue('api-key');

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const apiKeyVar = envVars.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
    expect(apiKeyVar).toBe('ANTHROPIC_API_KEY=placeholder');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('rewrites localhost to host gateway in HONCHO_URL', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      HONCHO_URL: 'http://localhost:8010',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const honchoVar = envVars.find((a) => a.startsWith('HONCHO_URL='));
    expect(honchoVar).toBeDefined();
    expect(honchoVar).toContain('host.docker.internal');
    expect(honchoVar).not.toContain('localhost');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    vi.mocked(readEnvFile).mockReturnValue({});
  });

  it('skips HONCHO_URL when URL is malformed', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      HONCHO_URL: 'not-a-valid-url',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const honchoVar = envVars.find((a) => a.startsWith('HONCHO_URL='));
    expect(honchoVar).toBeUndefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    vi.mocked(readEnvFile).mockReturnValue({});
  });

  it('includes QMD_URL only when QMD is reachable', async () => {
    // QMD not reachable (default)
    setQmdReachable(false);

    const resultPromise1 = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    let spawnCall = vi.mocked(spawn).mock.calls[0];
    let args = spawnCall[1] as string[];
    let envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');
    let qmdVar = envVars.find((a) => a.startsWith('QMD_URL='));
    expect(qmdVar).toBeUndefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    // Now set QMD reachable and try again
    setQmdReachable(true);
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);

    const resultPromise2 = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    spawnCall = vi.mocked(spawn).mock.calls[1];
    args = spawnCall[1] as string[];
    envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');
    qmdVar = envVars.find((a) => a.startsWith('QMD_URL='));
    expect(qmdVar).toBeDefined();
    expect(qmdVar).toContain('host.docker.internal:8181/mcp');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    // Reset
    setQmdReachable(false);
  });
});

describe('container-runner container name sanitization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sanitizes special characters in group folder for container name', async () => {
    const specialGroup: RegisteredGroup = {
      name: 'Weird/Group',
      folder: 'telegram_weird-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };

    const resultPromise = runContainerAgent(
      specialGroup,
      { ...testInput, groupFolder: specialGroup.folder },
      (proc, containerName) => {
        // Container name should only contain allowed chars
        // The code replaces [^a-zA-Z0-9-] with '-'
        expect(containerName).toMatch(/^nanoclaw-[a-zA-Z0-9-]+-\d+$/);
        // Underscores in folder name should be replaced with hyphens
        expect(containerName).toContain('telegram-weird-group');
      },
    );

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('container-runner timeout reset on activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets timeout when streaming output is received', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Advance close to timeout (within 10s of 1830000ms)
    await vi.advanceTimersByTimeAsync(1820000);

    // Emit output — should reset the timeout
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Still working...',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Advance another 1820000ms — if timeout wasn't reset, we'd have timed out
    await vi.advanceTimersByTimeAsync(1820000);

    // Should NOT have timed out yet (timeout was reset)
    // Emit another output to prove the container is still alive
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Final answer',
      newSessionId: 'reset-session',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Now close normally
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(2);
  });

  it('does not reset timeout on stderr output', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Advance close to timeout
    await vi.advanceTimersByTimeAsync(1829000);

    // Emit stderr (should NOT reset timeout)
    fakeProc.stderr.push('DEBUG: some debug log\n');

    await vi.advanceTimersByTimeAsync(10);

    // Advance past the original timeout
    await vi.advanceTimersByTimeAsync(2000);

    // The timeout should have fired — container should be stopped
    // Container emits close after being stopped
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });
});

describe('container-runner onOutput chain error handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues processing when onOutput callback throws', async () => {
    let callCount = 0;
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Callback failure on first output');
      }
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // First output — callback will throw
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First response',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Second output — callback should still be called
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second response',
      newSessionId: 'sess-after-error',
    });

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Should still succeed — errors in onOutput are caught
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(2);
  });
});

describe('container-runner redacts sensitive args', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not expose real credentials in spawn args', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    // The proxy token is embedded in the ANTHROPIC_BASE_URL — verify it
    // uses the test proxy token, NOT a real API key
    const baseUrlVar = envVars.find((a) => a.startsWith('ANTHROPIC_BASE_URL='));
    expect(baseUrlVar).toBeDefined();
    expect(baseUrlVar).toContain('test-proxy-token');

    // API key should be 'placeholder', never a real key
    const apiKeyVar = envVars.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
    if (apiKeyVar) {
      expect(apiKeyVar).toBe('ANTHROPIC_API_KEY=placeholder');
    }

    // Should never contain CLAUDE_CODE_OAUTH_TOKEN as env var
    const oauthTokenVar = envVars.find((a) =>
      a.startsWith('CLAUDE_CODE_OAUTH_TOKEN='),
    );
    expect(oauthTokenVar).toBeUndefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

// ─── NEW REGRESSION TESTS ───────────────────────────────────────────────

describe('container-runner ANTHROPIC_BASE_URL construction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructs ANTHROPIC_BASE_URL with host gateway, proxy port, and proxy token', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const baseUrlVar = envVars.find((a) => a.startsWith('ANTHROPIC_BASE_URL='));
    expect(baseUrlVar).toBeDefined();
    // Should follow format: http://{CONTAINER_HOST_GATEWAY}:{CREDENTIAL_PROXY_PORT}/{proxyToken}
    expect(baseUrlVar).toBe(
      'ANTHROPIC_BASE_URL=http://host.docker.internal:3001/test-proxy-token',
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('container-runner secret filtering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never passes CLAUDE_CODE_OAUTH_TOKEN to containers in either auth mode', async () => {
    for (const mode of ['api-key', 'oauth'] as const) {
      vi.mocked(detectAuthMode).mockReturnValue(mode);
      fakeProc = createFakeProcess();
      vi.mocked(spawn).mockReturnValue(fakeProc as any);

      const resultPromise = runContainerAgent(testGroup, testInput, () => {});
      await vi.advanceTimersByTimeAsync(10);

      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

      const oauthVar = envVars.find((a) =>
        a.startsWith('CLAUDE_CODE_OAUTH_TOKEN='),
      );
      expect(oauthVar).toBeUndefined();

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
    }

    vi.mocked(detectAuthMode).mockReturnValue('api-key');
  });

  it('never passes real ANTHROPIC_API_KEY value to containers', async () => {
    vi.mocked(detectAuthMode).mockReturnValue('api-key');

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const apiKeyVar = envVars.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
    expect(apiKeyVar).toBe('ANTHROPIC_API_KEY=placeholder');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('container-runner volume mount construction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('main group gets project root read-only and store writable', async () => {
    const mainGroup: RegisteredGroup = {
      ...testGroup,
      isMain: true,
    };

    const resultPromise = runContainerAgent(
      mainGroup,
      { ...testInput, isMain: true },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];

    // Project root should be mounted read-only (via readonlyMountArgs mock -> ':ro')
    const projectRoMount = args.find(
      (a) => a.includes('/workspace/project') && a.includes(':ro'),
    );
    expect(projectRoMount).toBeDefined();

    // Store should be writable (no :ro suffix)
    const storeMountIdx = args.findIndex(
      (a) => a.includes('/workspace/project/store') && !a.includes(':ro'),
    );
    expect(storeMountIdx).toBeGreaterThan(-1);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('non-main group does not get project root mount', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];

    // Non-main should NOT have /workspace/project mount (check -v args)
    const mountArgs = args.filter((a, i) => i > 0 && args[i - 1] === '-v');
    const projectMount = mountArgs.find(
      (a) =>
        a.includes(':/workspace/project:') || a.endsWith(':/workspace/project'),
    );
    expect(projectMount).toBeUndefined();

    // But should have /workspace/group
    const groupMount = mountArgs.find((a) => a.includes('/workspace/group'));
    expect(groupMount).toBeDefined();

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('syncs group-level skills from groups/{folder}/skills/', async () => {
    const mockCpSync = vi.mocked(fs.cpSync);
    mockCpSync.mockClear();

    // existsSync: true for group skills dir, false for others (default)
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('/skills')) return true; // both container/ and group/ skills dirs
      return false;
    });

    // readdirSync: return a skill dir for the group skills path
    vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('groups/') && s.endsWith('/skills'))
        return ['autoresearch'] as any;
      if (s.includes('container/skills')) return ['status'] as any;
      return [] as any;
    });

    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as any);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    // cpSync should have been called for both container skills AND group skills
    const calls = mockCpSync.mock.calls.map((c) => ({
      src: String(c[0]),
      dst: String(c[1]),
    }));

    // Group skills dir (groups/test-group/skills/autoresearch) should be synced
    const groupSync = calls.find(
      (c) => c.src.includes('groups/') && c.src.includes('autoresearch'),
    );
    expect(groupSync).toBeDefined();
    expect(groupSync!.dst).toContain('.claude/skills/autoresearch');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('container-runner MCP URL injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(detectAuthMode).mockReturnValue('api-key');
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HINDSIGHT_URL;
    delete process.env.CALENDAR_URL;
    delete process.env.TODOIST_URL;
    delete process.env.APPLE_NOTES_URL;
    delete process.env.READWISE_ACCESS_TOKEN;
  });

  it('rewrites 127.0.0.1 to host gateway for HINDSIGHT_URL', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      HINDSIGHT_URL: 'http://127.0.0.1:8889/mcp/hermes/',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const hindsightVar = envVars.find((a) => a.startsWith('HINDSIGHT_URL='));
    expect(hindsightVar).toBeDefined();
    expect(hindsightVar).toContain('host.docker.internal');
    expect(hindsightVar).not.toContain('127.0.0.1');
    expect(hindsightVar).toContain(':8889');
    expect(hindsightVar).toContain('/mcp/hermes/');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('rewrites localhost to host gateway for CALENDAR_URL', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      CALENDAR_URL: 'http://localhost:8188/mcp',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const calendarVar = envVars.find((a) => a.startsWith('CALENDAR_URL='));
    expect(calendarVar).toBeDefined();
    expect(calendarVar).toContain('host.docker.internal:8188');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('passes READWISE_ACCESS_TOKEN when configured', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      READWISE_ACCESS_TOKEN: 'rwt_test123',
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const readwiseVar = envVars.find((a) =>
      a.startsWith('READWISE_ACCESS_TOKEN='),
    );
    expect(readwiseVar).toBe('READWISE_ACCESS_TOKEN=rwt_test123');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('always passes OLLAMA_HOST with host gateway', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const ollamaVar = envVars.find((a) => a.startsWith('OLLAMA_HOST='));
    expect(ollamaVar).toBe('OLLAMA_HOST=http://host.docker.internal:11434');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('container-runner exit code handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns error with stderr tail on exit code 1', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.stderr.push('Error: ENOMEM\nKilled\n');
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container exited with code 1');
    expect(result.error).toContain('ENOMEM');
  });

  it('returns success with parsed output on exit code 0 (legacy mode)', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const output = JSON.stringify({
      status: 'success',
      result: 'All good',
      newSessionId: 'sess-ok',
    });
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${output}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('All good');
    expect(result.newSessionId).toBe('sess-ok');
  });
});

describe('container-runner output marker parsing edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles output markers split across multiple chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Split the marker and JSON across multiple data events
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n{"statu`);
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.stdout.push(
      `s":"success","result":"chunked"}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'chunked' }),
    );
  });

  it('handles multiple output markers in a single chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    const out1 = JSON.stringify({ status: 'success', result: 'first' });
    const out2 = JSON.stringify({ status: 'success', result: 'second' });
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${out1}\n${OUTPUT_END_MARKER}\n` +
        `${OUTPUT_START_MARKER}\n${out2}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ result: 'first' }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ result: 'second' }),
    );
  });
});

describe('container-runner custom timeout from containerConfig', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
    vi.mocked(stopContainer).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses group containerConfig timeout when larger than IDLE_TIMEOUT + 30s', async () => {
    const longTimeoutGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        timeout: 3600000, // 1 hour -- larger than IDLE_TIMEOUT + 30s (1830000)
      },
    };

    const resultPromise = runContainerAgent(
      longTimeoutGroup,
      testInput,
      () => {},
    );

    // Advance past default timeout (1830000) but before custom timeout (3600000)
    await vi.advanceTimersByTimeAsync(2000000);

    // Should NOT have timed out yet
    expect(vi.mocked(stopContainer)).not.toHaveBeenCalled();

    // Now advance past the custom timeout
    await vi.advanceTimersByTimeAsync(1700000);

    // Now it should have timed out
    expect(vi.mocked(stopContainer)).toHaveBeenCalled();

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });
});

// ─── TDD HARDENING PASS: New regression tests ─────────────────────────

describe('container-runner buildVolumeMounts duplicate container path guard', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  });

  afterEach(() => {
    vi.mocked(validateAdditionalMounts).mockReturnValue([]);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('throws when additionalMounts creates a duplicate container path', () => {
    // validateAdditionalMounts returns a mount that collides with /workspace/group
    vi.mocked(validateAdditionalMounts).mockReturnValue([
      {
        hostPath: '/some/other/path',
        containerPath: '/workspace/group',
        readonly: false,
      },
    ]);

    const groupWithMounts: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/some/other/path',
            containerPath: '/workspace/group',
          },
        ],
      },
    };

    expect(() => buildVolumeMounts(groupWithMounts, false)).toThrow(
      /Duplicate container mount path.*\/workspace\/group/,
    );
  });
});

describe('container-runner writeTasksSnapshot filtering', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.renameSync).mockImplementation(() => {});
  });

  const allTasks = [
    {
      id: 'task-1',
      groupFolder: 'test-group',
      prompt: 'Do thing A',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      status: 'active',
      next_run: '2026-04-12T00:00:00Z',
    },
    {
      id: 'task-2',
      groupFolder: 'other-group',
      prompt: 'Do thing B',
      schedule_type: 'interval',
      schedule_value: '3600000',
      status: 'active',
      next_run: '2026-04-12T01:00:00Z',
    },
    {
      id: 'task-3',
      groupFolder: 'test-group',
      prompt: 'Do thing C',
      schedule_type: 'cron',
      schedule_value: '30 8 * * *',
      status: 'active',
      next_run: '2026-04-12T08:30:00Z',
    },
  ];

  it('non-main group only sees its own tasks', () => {
    writeTasksSnapshot('test-group', false, allTasks);

    // Find the writeFileSync call for the tmp file
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tmpWrite = writeCalls.find((c) =>
      String(c[0]).includes('current_tasks.json.tmp'),
    );
    expect(tmpWrite).toBeDefined();

    const written = JSON.parse(String(tmpWrite![1]));
    // Should only see tasks for 'test-group'
    expect(written).toHaveLength(2);
    expect(written.every((t: any) => t.groupFolder === 'test-group')).toBe(
      true,
    );
  });

  it('main group sees all tasks across all groups', () => {
    vi.mocked(fs.writeFileSync).mockClear();

    writeTasksSnapshot('test-group', true, allTasks);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tmpWrite = writeCalls.find((c) =>
      String(c[0]).includes('current_tasks.json.tmp'),
    );
    expect(tmpWrite).toBeDefined();

    const written = JSON.parse(String(tmpWrite![1]));
    // Main should see ALL tasks
    expect(written).toHaveLength(3);
  });
});

describe('container-runner writeGroupsSnapshot visibility', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.renameSync).mockImplementation(() => {});
  });

  const allGroups = [
    {
      jid: 'group1@g.us',
      name: 'Group 1',
      lastActivity: '2026-04-10',
      isRegistered: true,
    },
    {
      jid: 'group2@g.us',
      name: 'Group 2',
      lastActivity: '2026-04-09',
      isRegistered: false,
    },
  ];

  it('non-main group gets empty groups list', () => {
    writeGroupsSnapshot(
      'test-group',
      false,
      allGroups,
      new Set(['group1@g.us']),
    );

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tmpWrite = writeCalls.find((c) =>
      String(c[0]).includes('available_groups.json.tmp'),
    );
    expect(tmpWrite).toBeDefined();

    const written = JSON.parse(String(tmpWrite![1]));
    expect(written.groups).toHaveLength(0);
    expect(written.lastSync).toBeDefined();
  });

  it('main group sees all available groups', () => {
    vi.mocked(fs.writeFileSync).mockClear();

    writeGroupsSnapshot(
      'test-group',
      true,
      allGroups,
      new Set(['group1@g.us']),
    );

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tmpWrite = writeCalls.find((c) =>
      String(c[0]).includes('available_groups.json.tmp'),
    );
    expect(tmpWrite).toBeDefined();

    const written = JSON.parse(String(tmpWrite![1]));
    expect(written.groups).toHaveLength(2);
  });
});

describe('container-runner process.env takes precedence over readEnvFile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(detectAuthMode).mockReturnValue('api-key');
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.APPLE_NOTES_URL;
    delete process.env.TODOIST_URL;
    delete process.env.HINDSIGHT_URL;
    delete process.env.CALENDAR_URL;
    delete process.env.HONCHO_URL;
    delete process.env.READWISE_ACCESS_TOKEN;
  });

  it('process.env.APPLE_NOTES_URL overrides readEnvFile value', async () => {
    // readEnvFile returns one URL, process.env has a different one
    vi.mocked(readEnvFile).mockReturnValue({
      APPLE_NOTES_URL: 'http://localhost:9999/from-env-file',
    });
    process.env.APPLE_NOTES_URL = 'http://localhost:8184/from-process-env';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const appleNotesVar = envVars.find((a) => a.startsWith('APPLE_NOTES_URL='));
    expect(appleNotesVar).toBeDefined();
    // Should use the process.env value (port 8184), not the env file value (port 9999)
    expect(appleNotesVar).toContain(':8184');
    expect(appleNotesVar).not.toContain(':9999');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });

  it('process.env.READWISE_ACCESS_TOKEN overrides readEnvFile value', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      READWISE_ACCESS_TOKEN: 'token-from-file',
    });
    process.env.READWISE_ACCESS_TOKEN = 'token-from-env';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const readwiseVar = envVars.find((a) =>
      a.startsWith('READWISE_ACCESS_TOKEN='),
    );
    expect(readwiseVar).toBe('READWISE_ACCESS_TOKEN=token-from-env');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('collectToolCalls', () => {
  // Use real fs operations directly since fs is mocked globally.
  // We access the real module via createRequire to avoid Vitest's CJS interop quirks.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require('fs') as typeof import('fs');

  beforeEach(() => {
    // Restore real implementations so collectToolCalls can do real filesystem I/O
    vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
    vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync as any);
    vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync as any);
  });

  afterEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.unlinkSync).mockReset();
  });

  it('reads tool-calls.json and returns parsed records', () => {
    const tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-test-'));
    const outputDir = path.join(tmpDir, 'output');
    realFs.mkdirSync(outputDir, { recursive: true });

    realFs.writeFileSync(
      path.join(outputDir, 'tool-calls.json'),
      JSON.stringify([
        {
          tool: 'qmd_query',
          paramsHash: 'abc123',
          timestamp: '2026-04-13T10:00:00Z',
        },
        {
          tool: 'send_message',
          paramsHash: 'def456',
          timestamp: '2026-04-13T10:01:00Z',
        },
      ]),
    );

    const records = collectToolCalls(outputDir);
    expect(records).toHaveLength(2);
    expect(records[0].tool).toBe('qmd_query');
    expect(records[1].paramsHash).toBe('def456');

    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no tool-calls.json exists', () => {
    const tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-test-'));
    const records = collectToolCalls(path.join(tmpDir, 'nonexistent'));
    expect(records).toHaveLength(0);
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('container-runner MCP URL non-localhost passthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(detectAuthMode).mockReturnValue('api-key');
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.APPLE_NOTES_URL;
  });

  it('preserves non-localhost hostname in APPLE_NOTES_URL unchanged', async () => {
    process.env.APPLE_NOTES_URL = 'http://remote-server.local:8184/mcp';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const envVars = args.filter((a, i) => i > 0 && args[i - 1] === '-e');

    const appleNotesVar = envVars.find((a) => a.startsWith('APPLE_NOTES_URL='));
    expect(appleNotesVar).toBeDefined();
    // Non-localhost should pass through without rewriting to host gateway
    expect(appleNotesVar).toContain('remote-server.local');
    expect(appleNotesVar).not.toContain('host.docker.internal');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('container-runner buildVolumeMounts global dir permissions', () => {
  beforeEach(() => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  });

  afterEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('mounts global dir as read-only for non-main groups', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      // Global dir exists
      if (s.endsWith('/global')) return true;
      return false;
    });

    const mounts = buildVolumeMounts(testGroup, false);
    const globalMount = mounts.find(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMount).toBeDefined();
    expect(globalMount!.readonly).toBe(true);
  });

  it('mounts global dir as writable for main group', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('/global')) return true;
      return false;
    });

    const mainGroup: RegisteredGroup = {
      ...testGroup,
      isMain: true,
    };
    const mounts = buildVolumeMounts(mainGroup, true);
    const globalMount = mounts.find(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMount).toBeDefined();
    expect(globalMount!.readonly).toBe(false);
  });
});
