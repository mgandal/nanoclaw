import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to control the allowlist path and fs behavior.
// Strategy: write real temp files for the allowlist, and mock fs.realpathSync / fs.existsSync
// only for the mount *host paths* (which may not exist on disk).

// First, mock the config module to point MOUNT_ALLOWLIST_PATH to our temp dir
let tmpDir: string;
let allowlistPath: string;

vi.mock('./config.js', () => ({
  get MOUNT_ALLOWLIST_PATH() {
    return allowlistPath;
  },
}));

// Suppress logger output during tests
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// We need to import AFTER mocks are set up
import {
  loadMountAllowlist,
  validateMount,
  validateAdditionalMounts,
  generateAllowlistTemplate,
} from './mount-security.js';
import type { AdditionalMount, MountAllowlist } from './types.js';

function writeAllowlist(config: MountAllowlist): void {
  fs.writeFileSync(allowlistPath, JSON.stringify(config));
}

// Monotonically increasing fake time to ensure each test busts the module cache.
// The module caches with a 5-min TTL based on Date.now(), so each test needs
// Date.now() to be >5 min past the previous test's cacheTimestamp.
let fakeTimeBase = Date.now();
const CACHE_BUST_MS = 10 * 60 * 1000; // 10 minutes — well past the 5-min TTL

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-security-test-'));
  allowlistPath = path.join(tmpDir, 'mount-allowlist.json');

  // Advance fake time monotonically past any cached state
  fakeTimeBase += CACHE_BUST_MS;
  vi.useFakeTimers();
  vi.setSystemTime(fakeTimeBase);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Helper: create a real temp directory to use as a "host path" for mounts ---
function createTempMountDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

describe('loadMountAllowlist', () => {
  it('returns null when allowlist file does not exist', () => {
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(allowlistPath, 'not json!!!');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when allowedRoots is not an array', () => {
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        allowedRoots: 'not-array',
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', () => {
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-array',
        nonMainReadOnly: false,
      }),
    );
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when nonMainReadOnly is not a boolean', () => {
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    );
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('loads valid allowlist and merges default blocked patterns', () => {
    writeAllowlist({
      allowedRoots: [
        { path: tmpDir, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: ['custom-secret'],
      nonMainReadOnly: false,
    });

    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    // Should include both default and custom patterns
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.env');
    expect(result!.blockedPatterns).toContain('custom-secret');
  });

  it('caches result within TTL', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const first = loadMountAllowlist();
    expect(first).not.toBeNull();

    // Delete the file — cached result should still be returned
    fs.unlinkSync(allowlistPath);
    const second = loadMountAllowlist();
    expect(second).not.toBeNull();
    expect(second).toBe(first); // Same reference (cached)
  });

  it('reloads after TTL expires', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const first = loadMountAllowlist();
    expect(first).not.toBeNull();

    // Advance past TTL (5 minutes)
    vi.advanceTimersByTime(6 * 60 * 1000);

    // Delete the file so reload returns null
    fs.unlinkSync(allowlistPath);
    const second = loadMountAllowlist();
    expect(second).toBeNull();
  });
});

describe('validateMount — path traversal attacks', () => {
  beforeEach(() => {
    const mountRoot = createTempMountDir('allowed-root');
    writeAllowlist({
      allowedRoots: [
        { path: mountRoot, allowReadWrite: true, description: 'test root' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
  });

  it('rejects container path with ../ traversal', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: '../../etc/passwd',
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects container path with embedded ..', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: 'foo/../../../etc',
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
  });

  it('rejects absolute container path', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: '/workspace/escape',
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
  });

  it('rejects container path with colon (Docker -v injection)', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: 'repo:rw',
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
  });

  it('falls back to basename when containerPath is empty string', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: '',
      readonly: true,
    };
    const result = validateMount(mount, true);
    // Empty string is falsy, so code falls back to path.basename(hostPath)
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('subdir');
  });

  it('rejects whitespace-only container path', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: '   ',
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
  });
});

describe('validateMount — allowlist enforcement', () => {
  it('blocks all mounts when no allowlist file exists', () => {
    // Don't write any allowlist — the beforeEach already busted the cache
    const mount: AdditionalMount = { hostPath: '/tmp', readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });

  it('rejects path not under any allowed root', () => {
    const allowedRoot = createTempMountDir('allowed');
    const outsideDir = createTempMountDir('outside');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: outsideDir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows path under an allowed root', () => {
    const allowedRoot = createTempMountDir('allowed');
    const subdir = createTempMountDir('allowed/myrepo');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(fs.realpathSync(subdir));
  });

  it('rejects host path that does not exist', () => {
    const allowedRoot = createTempMountDir('allowed');
    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = {
      hostPath: path.join(allowedRoot, 'nonexistent'),
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });
});

describe('validateMount — blocked patterns', () => {
  it('blocks paths matching default .ssh pattern', () => {
    const allowedRoot = createTempMountDir('allowed');
    const sshDir = createTempMountDir('allowed/.ssh');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: sshDir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks paths matching default .env pattern', () => {
    const allowedRoot = createTempMountDir('allowed');
    const envDir = createTempMountDir('allowed/.env');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: envDir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });

  it('blocks paths matching custom blocked pattern', () => {
    const allowedRoot = createTempMountDir('allowed');
    const secretDir = createTempMountDir('allowed/my-secrets');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: ['my-secrets'],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: secretDir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('my-secrets');
  });

  it('blocks paths with blocked pattern in a parent directory', () => {
    const allowedRoot = createTempMountDir('allowed');
    const deepDir = createTempMountDir('allowed/credentials/subdir');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: deepDir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('credentials');
  });
});

describe('validateMount — read-only vs read-write permissions', () => {
  let allowedRoot: string;
  let subdir: string;

  beforeEach(() => {
    allowedRoot = createTempMountDir('allowed');
    subdir = createTempMountDir('allowed/repo');
  });

  it('defaults to read-only when readonly is not specified', () => {
    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write when root permits and main group', () => {
    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: false };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces read-only when root does not allow read-write', () => {
    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: false, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: false };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('forces read-only for non-main group when nonMainReadOnly is true', () => {
    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: false };
    const result = validateMount(mount, /* isMain */ false);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write for main group even when nonMainReadOnly is true', () => {
    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: false };
    const result = validateMount(mount, /* isMain */ true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});

describe('validateAdditionalMounts', () => {
  it('returns only validated mounts, skipping rejected ones', () => {
    const allowedRoot = createTempMountDir('allowed');
    const goodDir = createTempMountDir('allowed/good');
    const outsideDir = createTempMountDir('outside');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mounts: AdditionalMount[] = [
      { hostPath: goodDir, readonly: true },
      { hostPath: outsideDir, readonly: true },
      { hostPath: path.join(allowedRoot, 'nonexistent'), readonly: true },
    ];

    const results = validateAdditionalMounts(mounts, 'test-group', true);
    expect(results).toHaveLength(1);
    expect(results[0].hostPath).toBe(fs.realpathSync(goodDir));
    expect(results[0].containerPath).toBe('/workspace/extra/good');
    expect(results[0].readonly).toBe(true);
  });

  it('uses basename as container path when containerPath is not specified', () => {
    const allowedRoot = createTempMountDir('allowed');
    const subdir = createTempMountDir('allowed/my-repo');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mounts: AdditionalMount[] = [{ hostPath: subdir, readonly: true }];
    const results = validateAdditionalMounts(mounts, 'test-group', true);
    expect(results).toHaveLength(1);
    expect(results[0].containerPath).toBe('/workspace/extra/my-repo');
  });

  it('uses explicit containerPath when specified', () => {
    const allowedRoot = createTempMountDir('allowed');
    const subdir = createTempMountDir('allowed/my-repo');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mounts: AdditionalMount[] = [
      { hostPath: subdir, containerPath: 'custom-name', readonly: true },
    ];
    const results = validateAdditionalMounts(mounts, 'test-group', true);
    expect(results).toHaveLength(1);
    expect(results[0].containerPath).toBe('/workspace/extra/custom-name');
  });
});

describe('validateMount — edge cases', () => {
  it('handles paths with spaces', () => {
    const allowedRoot = createTempMountDir('allowed root');
    const subdir = createTempMountDir('allowed root/my repo');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
  });

  it('handles trailing slashes on host path', () => {
    const allowedRoot = createTempMountDir('allowed');
    const subdir = createTempMountDir('allowed/repo');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Path with trailing slash
    const mount: AdditionalMount = {
      hostPath: subdir + '/',
      readonly: true,
    };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
  });

  it('handles symlink resolution for host paths', () => {
    const allowedRoot = createTempMountDir('allowed');
    const realDir = createTempMountDir('allowed/real-dir');
    const symlinkPath = path.join(tmpDir, 'symlink-to-allowed');
    fs.symlinkSync(realDir, symlinkPath);

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: symlinkPath, readonly: true };
    const result = validateMount(mount, true);
    // Should be allowed because real path is under allowed root
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(realDir);
  });

  it('blocks symlink that resolves outside allowed root', () => {
    const allowedRoot = createTempMountDir('allowed');
    const outsideDir = createTempMountDir('outside');
    const symlinkPath = path.join(
      tmpDir,
      'allowed',
      'sneaky-link',
    );
    fs.symlinkSync(outsideDir, symlinkPath);

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: symlinkPath, readonly: true };
    const result = validateMount(mount, true);
    // Symlink resolves to outsideDir which is NOT under allowedRoot
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allowed root itself is a valid mount target', () => {
    const allowedRoot = createTempMountDir('allowed');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: allowedRoot, readonly: true };
    const result = validateMount(mount, true);
    expect(result.allowed).toBe(true);
  });
});

describe('generateAllowlistTemplate', () => {
  it('generates valid JSON with required fields', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });
});
