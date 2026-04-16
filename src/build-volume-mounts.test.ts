import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  AGENTS_DIR: '/tmp/nanoclaw-test-data/agents',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CONTEXT_PACKET_MAX_SIZE: 8000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  OLLAMA_ADMIN_TOOLS: false,
  OLLAMA_DEFAULT_MODEL: '',
  ONECLI_API_KEY: '',
  ONECLI_URL: 'http://localhost:10254',
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

// Track which paths "exist" in the virtual filesystem
let existingPaths: Set<string>;

// Mock fs — buildVolumeMounts uses existsSync, mkdirSync, writeFileSync,
// readFileSync, readdirSync, statSync, cpSync
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => existingPaths.has(p)),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false, mtimeMs: 0 })),
      cpSync: vi.fn(),
    },
  };
});

// Mock context-assembler (transitively imports db.ts which needs bun:sqlite)
vi.mock('./context-assembler.js', () => ({
  writeContextPacket: vi.fn(async () => {}),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
  proxyToken: 'test-proxy-token',
}));

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'container',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(
    (
      mounts: Array<{
        hostPath: string;
        containerPath: string;
        readonly?: boolean;
      }>,
    ) =>
      mounts.map((m) => ({
        hostPath: m.hostPath,
        containerPath: `/workspace/extra/${m.containerPath}`,
        readonly: m.readonly ?? false,
      })),
  ),
}));

import { buildVolumeMounts } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test',
    folder: 'telegram_test',
    trigger: '@Claire',
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildVolumeMounts duplicate detection', () => {
  beforeEach(() => {
    existingPaths = new Set(['/tmp/nanoclaw-test-groups/global']);
  });

  it('produces no duplicate container paths for main group', () => {
    const group = makeGroup({ isMain: true });
    // Should not throw
    const mounts = buildVolumeMounts(group, true);
    const containerPaths = mounts.map((m) => m.containerPath);
    const unique = new Set(containerPaths);
    expect(containerPaths.length).toBe(unique.size);
  });

  it('produces no duplicate container paths for non-main group', () => {
    const group = makeGroup();
    const mounts = buildVolumeMounts(group, false);
    const containerPaths = mounts.map((m) => m.containerPath);
    const unique = new Set(containerPaths);
    expect(containerPaths.length).toBe(unique.size);
  });

  it('includes /workspace/global exactly once for main group', () => {
    const group = makeGroup({ isMain: true });
    const mounts = buildVolumeMounts(group, true);
    const globalMounts = mounts.filter(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMounts).toHaveLength(1);
    expect(globalMounts[0].readonly).toBe(false);
  });

  it('includes /workspace/global exactly once for non-main group (read-only)', () => {
    const group = makeGroup();
    const mounts = buildVolumeMounts(group, false);
    const globalMounts = mounts.filter(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMounts).toHaveLength(1);
    expect(globalMounts[0].readonly).toBe(true);
  });

  it('throws on duplicate container path from additional mounts', () => {
    const group = makeGroup({
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/some/path',
            containerPath: 'group', // resolves to /workspace/extra/group
          },
          {
            hostPath: '/other/path',
            containerPath: 'group', // same target → duplicate
          },
        ],
      },
    });
    expect(() => buildVolumeMounts(group, false)).toThrow(
      /Duplicate container mount path/,
    );
  });

  it('does not include /workspace/global when global dir does not exist', () => {
    existingPaths.delete('/tmp/nanoclaw-test-groups/global');
    const group = makeGroup({ isMain: true });
    const mounts = buildVolumeMounts(group, true);
    const globalMounts = mounts.filter(
      (m) => m.containerPath === '/workspace/global',
    );
    expect(globalMounts).toHaveLength(0);
  });
});
