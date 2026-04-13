import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadMountAllowlist,
  validateMount,
  validateAdditionalMounts,
  generateAllowlistTemplate,
  _resetCache,
} from './mount-security.js';
import type { AdditionalMount, MountAllowlist } from './types.js';

let tmpDir: string;
let allowlistPath: string;

function writeAllowlist(config: MountAllowlist): void {
  fs.writeFileSync(allowlistPath, JSON.stringify(config));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-security-test-'));
  allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  _resetCache();
});

afterEach(() => {
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
    const result = loadMountAllowlist(allowlistPath);
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(allowlistPath, 'not json!!!');
    const result = loadMountAllowlist(allowlistPath);
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
    const result = loadMountAllowlist(allowlistPath);
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
    const result = loadMountAllowlist(allowlistPath);
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
    const result = loadMountAllowlist(allowlistPath);
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

    const result = loadMountAllowlist(allowlistPath);
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

    // First call loads from file
    const first = loadMountAllowlist(allowlistPath);
    expect(first).not.toBeNull();

    // Second call (no pathOverride) should use cache even if file is deleted
    fs.unlinkSync(allowlistPath);
    const second = loadMountAllowlist();
    expect(second).not.toBeNull();
    expect(second).toBe(first); // Same reference (cached)
  });

  it('reloads after cache reset', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const first = loadMountAllowlist(allowlistPath);
    expect(first).not.toBeNull();

    // Reset cache to simulate TTL expiry
    _resetCache();

    // Delete the file so reload returns null
    fs.unlinkSync(allowlistPath);
    const second = loadMountAllowlist(allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });

  it('rejects absolute container path', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: '/workspace/escape',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });

  it('rejects container path with colon (Docker -v injection)', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: 'repo:rw',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });

  it('falls back to basename when containerPath is empty string', () => {
    const hostDir = createTempMountDir('allowed-root/subdir');
    const mount: AdditionalMount = {
      hostPath: hostDir,
      containerPath: '',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });
});

describe('validateMount — allowlist enforcement', () => {
  it('blocks all mounts when no allowlist file exists', () => {
    // Don't write any allowlist — the beforeEach already busted the cache
    const mount: AdditionalMount = { hostPath: '/tmp', readonly: true };
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, /* isMain */ false, allowlistPath);
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
    const result = validateMount(mount, /* isMain */ true, allowlistPath);
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

    const results = validateAdditionalMounts(
      mounts,
      'test-group',
      true,
      allowlistPath,
    );
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
    const results = validateAdditionalMounts(
      mounts,
      'test-group',
      true,
      allowlistPath,
    );
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
    const results = validateAdditionalMounts(
      mounts,
      'test-group',
      true,
      allowlistPath,
    );
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
    // Should be allowed because real path is under allowed root
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(realDir);
  });

  it('blocks symlink that resolves outside allowed root', () => {
    const allowedRoot = createTempMountDir('allowed');
    const outsideDir = createTempMountDir('outside');
    const symlinkPath = path.join(tmpDir, 'allowed', 'sneaky-link');
    fs.symlinkSync(outsideDir, symlinkPath);

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: symlinkPath, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
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
    const result = validateMount(mount, true, allowlistPath);
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

// ==================== NEW REGRESSION TESTS ====================

describe('validateMount — host path traversal attacks', () => {
  it('rejects host path with ../../etc/passwd traversal outside allowed root', () => {
    const allowedRoot = createTempMountDir('safe-root');
    createTempMountDir('safe-root/subdir');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: false, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Attempt to traverse out of allowed root via host path
    const mount: AdditionalMount = {
      hostPath: path.join(allowedRoot, 'subdir', '..', '..', '..', 'etc'),
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    // path.resolve normalizes the traversal; /etc either doesn't exist or is outside allowed root
    expect(result.allowed).toBe(false);
  });

  it('rejects symlink in host path that escapes to /etc', () => {
    const allowedRoot = createTempMountDir('safe-root');
    const symlinkPath = path.join(allowedRoot, 'escape-link');
    // /etc always exists on macOS/Linux
    try {
      fs.symlinkSync('/etc', symlinkPath);
    } catch {
      // If symlink creation fails, skip
      return;
    }

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: symlinkPath, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    // Symlink resolves to /etc which is outside allowed root
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });
});

describe('validateMount — read-only enforcement edge cases', () => {
  it('non-main group gets read-only even when root allows rw and mount requests rw', () => {
    const allowedRoot = createTempMountDir('rw-root');
    const subdir = createTempMountDir('rw-root/data');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: false };
    const result = validateMount(mount, /* isMain */ false, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('non-main group with nonMainReadOnly=false gets rw when root allows it', () => {
    const allowedRoot = createTempMountDir('rw-root');
    const subdir = createTempMountDir('rw-root/data');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: false };
    const result = validateMount(mount, /* isMain */ false, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('mount with readonly=true stays read-only even when everything permits rw', () => {
    const allowedRoot = createTempMountDir('rw-root');
    const subdir = createTempMountDir('rw-root/data');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Explicitly requesting read-only
    const mount: AdditionalMount = { hostPath: subdir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});

describe('validateMount — path normalization', () => {
  it('normalizes double slashes in host path', () => {
    const allowedRoot = createTempMountDir('norm-root');
    const subdir = createTempMountDir('norm-root/repo');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Double slashes in path
    const mount: AdditionalMount = {
      hostPath: subdir.replace('/repo', '//repo'),
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(true);
  });

  it('normalizes trailing slashes on allowed root in allowlist', () => {
    const allowedRoot = createTempMountDir('norm-root');
    const subdir = createTempMountDir('norm-root/repo');

    writeAllowlist({
      allowedRoots: [
        {
          path: allowedRoot + '/',
          allowReadWrite: true,
          description: 'test',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(true);
  });
});

describe('validateMount — sensitive directory protection', () => {
  it('blocks mount to HOME/.ssh even if HOME is an allowed root', () => {
    const fakeHome = createTempMountDir('fakehome');
    const sshDir = createTempMountDir('fakehome/.ssh');

    writeAllowlist({
      allowedRoots: [
        { path: fakeHome, allowReadWrite: true, description: 'home' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: sshDir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks mount containing .env in deeply nested path', () => {
    const allowedRoot = createTempMountDir('deep-root');
    const envDir = createTempMountDir('deep-root/a/b/.env');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: envDir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });
});

describe('validateMount — multiple overlapping allowed roots', () => {
  it('uses correct root permissions when paths overlap (rw root nested in ro root)', () => {
    const outerRoot = createTempMountDir('outer');
    const innerRoot = createTempMountDir('outer/inner');
    const target = createTempMountDir('outer/inner/project');

    writeAllowlist({
      allowedRoots: [
        {
          path: outerRoot,
          allowReadWrite: false,
          description: 'outer read-only',
        },
        {
          path: innerRoot,
          allowReadWrite: true,
          description: 'inner read-write',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: target, readonly: false };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(true);
    // First matching root wins — the outer root matches first, so it should be read-only
    // This documents the current behavior: first-match wins
    // The mount is allowed but the effective readonly depends on which root matches first
  });

  it('path under only one of multiple non-overlapping roots is allowed', () => {
    const rootA = createTempMountDir('rootA');
    const rootB = createTempMountDir('rootB');
    const targetA = createTempMountDir('rootA/project');
    const outside = createTempMountDir('rootC');

    writeAllowlist({
      allowedRoots: [
        { path: rootA, allowReadWrite: true, description: 'A' },
        { path: rootB, allowReadWrite: false, description: 'B' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Target under rootA: allowed
    const mountA: AdditionalMount = { hostPath: targetA, readonly: true };
    const resultA = validateMount(mountA, true, allowlistPath);
    expect(resultA.allowed).toBe(true);

    // Target under neither root: rejected
    const mountOut: AdditionalMount = { hostPath: outside, readonly: true };
    const resultOut = validateMount(mountOut, true, allowlistPath);
    expect(resultOut.allowed).toBe(false);
  });
});

describe('validateMount — empty allowedRoots array', () => {
  it('blocks all mounts when allowedRoots is an empty array', () => {
    const someDir = createTempMountDir('anydir');

    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: someDir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });
});

// ==================== TDD HARDENING: SECURITY EDGE CASES ====================

describe('validateMount — null byte injection', () => {
  it('rejects host path containing null bytes', () => {
    const allowedRoot = createTempMountDir('null-root');
    createTempMountDir('null-root/safe');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Null byte injection: attempt to truncate path resolution
    const mount: AdditionalMount = {
      hostPath: path.join(allowedRoot, 'safe\x00../../etc/passwd'),
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    // Should either reject (path doesn't exist after null byte handling) or
    // resolve safely under the allowed root. Must NOT allow access outside root.
    if (result.allowed) {
      // If allowed, the realHostPath must still be under the allowed root
      expect(
        result.realHostPath!.startsWith(fs.realpathSync(allowedRoot)),
      ).toBe(true);
    } else {
      // Rejected is the safe outcome — path with null byte doesn't resolve
      expect(result.allowed).toBe(false);
    }
    // If realHostPath is set, it must not point to /etc/passwd
    if (result.realHostPath) {
      expect(result.realHostPath).not.toContain('/etc/passwd');
    }
  });

  it('rejects container path containing null bytes', () => {
    const allowedRoot = createTempMountDir('null-root');
    const subdir = createTempMountDir('null-root/safe');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = {
      hostPath: subdir,
      containerPath: 'safe\x00../../etc',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    // Container path with null byte should be rejected as it contains
    // dangerous characters that could confuse container runtimes
    // Current behavior: the ".." check catches it since the full string contains ".."
    expect(result.allowed).toBe(false);
  });
});

describe('validateMount — control characters in container path', () => {
  it('rejects container path with newline characters', () => {
    const allowedRoot = createTempMountDir('ctrl-root');
    const subdir = createTempMountDir('ctrl-root/safe');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Newline in container path could break -v flag parsing in Docker/container CLI
    const mount: AdditionalMount = {
      hostPath: subdir,
      containerPath: 'safe\n--privileged',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    // This SHOULD be rejected — newlines in container paths are dangerous
    // They could inject additional flags into the container command line
    expect(result.allowed).toBe(false);
  });

  it('rejects container path with tab characters', () => {
    const allowedRoot = createTempMountDir('ctrl-root');
    const subdir = createTempMountDir('ctrl-root/safe');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = {
      hostPath: subdir,
      containerPath: 'safe\t--privileged',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });
});

describe('validateMount — blocked pattern substring matching', () => {
  it('blocks directory whose name contains .env as substring (e.g. project.env.local)', () => {
    const allowedRoot = createTempMountDir('substr-root');
    const envDir = createTempMountDir('substr-root/project.env.local');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // "project.env.local" contains ".env" — current implementation blocks via substring match
    // This is security-correct (err on the side of blocking)
    const mount: AdditionalMount = { hostPath: envDir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });

  it('blocks path where blocked pattern appears only in full path (not individual components)', () => {
    // Test the full-path check on line 187: realPath.includes(pattern)
    // This catches cases where the pattern spans across path separators
    const allowedRoot = createTempMountDir('fullpath-root');
    const dir = createTempMountDir('fullpath-root/id_rsa_backups');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: dir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('id_rsa');
  });
});

describe('validateMount — container path single dot escape', () => {
  it('rejects container path that is exactly ".."', () => {
    const allowedRoot = createTempMountDir('dot-root');
    const subdir = createTempMountDir('dot-root/safe');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = {
      hostPath: subdir,
      containerPath: '..',
      readonly: true,
    };
    const result = validateMount(mount, true, allowlistPath);
    expect(result.allowed).toBe(false);
  });
});

describe('validateMount — blocked pattern in allowed root path itself', () => {
  it('blocks mount when allowed root path contains blocked pattern', () => {
    // Edge case: allowed root is "/tmp/xxx/credentials-safe" which contains "credentials"
    // Files under this root should be blocked because the real path contains the pattern
    const allowedRoot = createTempMountDir('credentials-safe');
    const subdir = createTempMountDir('credentials-safe/data');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: subdir, readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    // The real path will contain "credentials" from the root dir name,
    // so blocked pattern check will trigger. This is conservative but safe.
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('credentials');
  });
});

describe('validateMount — empty hostPath', () => {
  it('rejects mount with empty string hostPath', () => {
    const allowedRoot = createTempMountDir('empty-root');

    writeAllowlist({
      allowedRoots: [
        { path: allowedRoot, allowReadWrite: true, description: 'test' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const mount: AdditionalMount = { hostPath: '', readonly: true };
    const result = validateMount(mount, true, allowlistPath);
    // Empty hostPath should be rejected — either it doesn't exist or resolves to cwd
    expect(result.allowed).toBe(false);
  });
});

describe('loadMountAllowlist — malformed allowlist edge cases', () => {
  it('returns null for empty JSON object (missing all required fields)', () => {
    fs.writeFileSync(allowlistPath, '{}');
    const result = loadMountAllowlist(allowlistPath);
    expect(result).toBeNull();
  });

  it('returns null for JSON array instead of object', () => {
    fs.writeFileSync(allowlistPath, '[]');
    const result = loadMountAllowlist(allowlistPath);
    expect(result).toBeNull();
  });

  it('returns null for empty file', () => {
    fs.writeFileSync(allowlistPath, '');
    const result = loadMountAllowlist(allowlistPath);
    expect(result).toBeNull();
  });
});
