import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ensure CREDENTIAL_PROXY_HOST is set before container-runtime.ts import
// (module throws at load time if missing)
vi.hoisted(() => {
  if (!process.env.CREDENTIAL_PROXY_HOST) {
    process.env.CREDENTIAL_PROXY_HOST = '192.168.64.1';
  }
});

// Hoisted mocks — vi.hoisted ensures these exist before vi.mock factories run
const { mockExecSync, mockPlatform, mockNetworkInterfaces } = vi.hoisted(
  () => ({
    mockExecSync: vi.fn(),
    mockPlatform: vi.fn(() => 'darwin'),
    mockNetworkInterfaces: vi.fn(() => ({})),
  }),
);

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock os module for platform-specific tests
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      platform: () => mockPlatform(),
      networkInterfaces: () => mockNetworkInterfaces(),
    },
    platform: () => mockPlatform(),
    networkInterfaces: () => mockNetworkInterfaces(),
  };
});

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  hostGatewayArgs,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
      { stdio: 'pipe', timeout: 15000 },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      { stdio: 'pipe' },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('auto-starts when system status fails', () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers from JSON output', () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ls + 2 stop calls (only running nanoclaw- containers)
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe', timeout: 15000 },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group3-333`,
      { stdio: 'pipe', timeout: 15000 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });

  it('handles malformed JSON output gracefully', () => {
    mockExecSync.mockReturnValueOnce('not valid json {{{');

    cleanupOrphans(); // should not throw — outer catch handles parse error

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('handles empty string output by treating as empty array', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw — falls back to '[]'

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('handles many orphans without stopping early', () => {
    const orphans = Array.from({ length: 20 }, (_, i) => ({
      status: 'running',
      configuration: { id: `nanoclaw-group${i}-${i}` },
    }));
    mockExecSync.mockReturnValueOnce(JSON.stringify(orphans));
    // All stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // 1 ls + 20 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(21);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ count: 20 }),
      'Stopped orphaned containers',
    );
  });

  it('skips containers with missing configuration or id fields and still stops valid orphans', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-valid-1' } },
      { status: 'running', configuration: {} }, // missing id
      { status: 'running' }, // missing configuration entirely
      { status: 'running', configuration: { id: 'nanoclaw-valid-2' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValue('');

    cleanupOrphans(); // should not throw

    // Both valid orphans should still be stopped despite malformed entries
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-valid-1`,
      { stdio: 'pipe', timeout: 15000 },
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-valid-2`,
      { stdio: 'pipe', timeout: 15000 },
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// --- stopContainer edge cases ---

describe('stopContainer edge cases', () => {
  it('rejects empty string name', () => {
    expect(() => stopContainer('')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('rejects names starting with a dot', () => {
    expect(() => stopContainer('.hidden')).toThrow('Invalid container name');
  });

  it('rejects names starting with a dash', () => {
    expect(() => stopContainer('-flag')).toThrow('Invalid container name');
  });

  it('accepts names starting with a digit', () => {
    mockExecSync.mockReturnValueOnce('');
    stopContainer('1container');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop 1container`,
      { stdio: 'pipe', timeout: 15000 },
    );
  });

  it('accepts names with dots, dashes, and underscores', () => {
    mockExecSync.mockReturnValueOnce('');
    stopContainer('nanoclaw_group.test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw_group.test-123`,
      { stdio: 'pipe', timeout: 15000 },
    );
  });

  it('rejects names with spaces', () => {
    expect(() => stopContainer('name with spaces')).toThrow(
      'Invalid container name',
    );
  });

  it('rejects names with newlines (shell injection vector)', () => {
    expect(() => stopContainer('name\n--rm')).toThrow('Invalid container name');
  });
});

// --- ensureContainerRuntimeRunning edge cases ---

describe('ensureContainerRuntimeRunning error details', () => {
  it('sets cause on the thrown error for debugging', () => {
    const originalError = new Error('binary not found');
    mockExecSync.mockImplementation(() => {
      throw originalError;
    });

    let caught: Error | undefined;
    try {
      ensureContainerRuntimeRunning();
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toBe(
      'Container runtime is required but failed to start',
    );
    expect(caught!.cause).toBe(originalError);
  });

  it('logs error details when start fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to start container runtime',
    );
  });
});

// --- readonlyMountArgs edge cases ---

describe('readonlyMountArgs edge cases', () => {
  it('handles paths with spaces (Apple Container bind mount)', () => {
    const args = readonlyMountArgs(
      '/host/path with spaces',
      '/container/path with spaces',
    );
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path with spaces,target=/container/path with spaces,readonly',
    ]);
  });

  it('uses --mount flag (not -v) for Apple Container compatibility', () => {
    const args = readonlyMountArgs('/host', '/container');
    // Apple Container requires --mount syntax, not -v
    expect(args[0]).toBe('--mount');
    expect(args[1]).toContain('type=bind');
    expect(args[1]).not.toContain('-v');
  });
});

// --- hostGatewayArgs ---

describe('hostGatewayArgs', () => {
  it('returns --add-host arg on Linux', () => {
    mockPlatform.mockReturnValue('linux');
    // Re-import needed for platform check, but hostGatewayArgs reads os.platform() at call time
    const args = hostGatewayArgs();
    expect(args).toEqual(['--add-host=host.docker.internal:host-gateway']);
  });

  it('returns empty array on macOS (Apple Container handles it)', () => {
    mockPlatform.mockReturnValue('darwin');
    const args = hostGatewayArgs();
    expect(args).toEqual([]);
  });

  it('returns empty array on Windows (not Linux)', () => {
    mockPlatform.mockReturnValue('win32');
    const args = hostGatewayArgs();
    expect(args).toEqual([]);
  });
});

// --- cleanupOrphans additional edge cases ---

describe('cleanupOrphans edge cases', () => {
  it('handles JSON null literal output gracefully', () => {
    mockExecSync.mockReturnValueOnce('null');

    cleanupOrphans(); // should not throw

    // JSON.parse('null') returns null; iterating null should be caught
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('handles whitespace-only output gracefully', () => {
    mockExecSync.mockReturnValueOnce('   \n  ');

    cleanupOrphans(); // should not throw — outer catch handles parse error

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('skips containers with null id field', () => {
    const lsOutput = JSON.stringify([
      {
        status: 'running',
        configuration: { id: null },
      },
      {
        status: 'running',
        configuration: { id: 'nanoclaw-good-1' },
      },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValue('');

    cleanupOrphans(); // should not throw

    // The valid orphan should still be stopped
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-good-1`,
      { stdio: 'pipe', timeout: 15000 },
    );
  });

  it('skips containers with numeric id (not a string)', () => {
    const lsOutput = JSON.stringify([
      {
        status: 'running',
        configuration: { id: 12345 },
      },
      {
        status: 'running',
        configuration: { id: 'nanoclaw-good-2' },
      },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValue('');

    cleanupOrphans(); // should not throw

    // The valid orphan should still be stopped
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-good-2`,
      { stdio: 'pipe', timeout: 15000 },
    );
  });

  it('does not stop containers with nanoclaw in the middle of the name', () => {
    const lsOutput = JSON.stringify([
      {
        status: 'running',
        configuration: { id: 'other-nanoclaw-container' },
      },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);

    cleanupOrphans();

    // Only the ls call, no stop
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('ignores containers in paused/created/exited states', () => {
    const lsOutput = JSON.stringify([
      { status: 'paused', configuration: { id: 'nanoclaw-paused-1' } },
      { status: 'created', configuration: { id: 'nanoclaw-created-1' } },
      { status: 'exited', configuration: { id: 'nanoclaw-exited-1' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);

    cleanupOrphans();

    // Only the ls call, no stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// --- stopContainer propagation ---

describe('stopContainer error propagation', () => {
  it('propagates execSync errors to caller', () => {
    const err = new Error('container not found');
    mockExecSync.mockImplementationOnce(() => {
      throw err;
    });

    expect(() => stopContainer('nanoclaw-test-1')).toThrow(
      'container not found',
    );
  });

  it('rejects names with pipe (shell injection)', () => {
    expect(() => stopContainer('name|cat')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('rejects names with redirect (shell injection)', () => {
    expect(() => stopContainer('name>file')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('rejects names with ampersand (shell injection)', () => {
    expect(() => stopContainer('name&cmd')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
