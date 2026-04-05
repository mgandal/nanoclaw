/**
 * Tests for src/channels/index.ts — the barrel file that triggers channel
 * self-registration — and the initialization loop pattern used by the orchestrator.
 *
 * These tests verify:
 * - Channel auto-discovery via barrel imports
 * - Factory returns null for missing credentials (graceful skip)
 * - Channel interface compliance (required methods present)
 * - Duplicate channel registration (last-write-wins)
 * - Channel connection lifecycle (connect/disconnect)
 * - Error handling during channel connect
 * - Initialization loop resilience (one channel failing doesn't block others)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Channel } from '../types.js';
import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
  ChannelOpts,
} from './registry.js';

/** Helper: create a mock ChannelOpts for factory calls */
function mockOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
}

/** Helper: create a minimal Channel implementation for testing */
function createMockChannel(
  name: string,
  overrides: Partial<Channel> = {},
): Channel {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    ownsJid: vi.fn((jid: string) => jid.startsWith(`${name}:`)),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('channel barrel file (index.ts)', () => {
  // The barrel file imports channel modules which call registerChannel().
  // By the time this test runs, those side-effects have already fired.
  // We test the registry state to confirm auto-discovery works.

  it('barrel import registers at least one channel', async () => {
    // Force execution of the barrel file (may already be loaded)
    await import('./index.js');

    const names = getRegisteredChannelNames();
    // The barrel imports gmail, slack, and emacs. At minimum those should be registered.
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it('barrel imports register the expected channel names', async () => {
    await import('./index.js');

    const names = getRegisteredChannelNames();
    // index.ts imports gmail, slack, and emacs
    expect(names).toContain('gmail');
    expect(names).toContain('slack');
    expect(names).toContain('emacs');
  });

  it('each registered factory is callable and returns Channel or null', async () => {
    await import('./index.js');

    const opts = mockOpts();
    for (const name of getRegisteredChannelNames()) {
      const factory = getChannelFactory(name);
      expect(factory).toBeDefined();
      // Factory should not throw — it returns null if creds are missing
      const result = factory!(opts);
      // Result must be null or a Channel-shaped object
      if (result !== null) {
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('connect');
        expect(result).toHaveProperty('sendMessage');
        expect(result).toHaveProperty('isConnected');
        expect(result).toHaveProperty('ownsJid');
        expect(result).toHaveProperty('disconnect');
      }
    }
  });
});

describe('channel factory — credential gating', () => {
  it('factory returns null when credentials are missing', () => {
    const factoryReturnsNull = vi.fn((_opts: ChannelOpts) => null);
    registerChannel('test-no-creds', factoryReturnsNull);

    const factory = getChannelFactory('test-no-creds')!;
    const result = factory(mockOpts());
    expect(result).toBeNull();
  });

  it('factory returns a Channel when credentials are present', () => {
    const channel = createMockChannel('test-with-creds');
    registerChannel('test-with-creds', (_opts) => channel);

    const factory = getChannelFactory('test-with-creds')!;
    const result = factory(mockOpts());
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-with-creds');
  });
});

describe('channel interface compliance', () => {
  const requiredMethods: (keyof Channel)[] = [
    'connect',
    'sendMessage',
    'isConnected',
    'ownsJid',
    'disconnect',
  ];

  it('mock channel has all required Channel interface methods', () => {
    const channel = createMockChannel('compliance-test');
    for (const method of requiredMethods) {
      expect(typeof channel[method]).toBe('function');
    }
  });

  it('channel has a name property', () => {
    const channel = createMockChannel('name-test');
    expect(typeof channel.name).toBe('string');
    expect(channel.name.length).toBeGreaterThan(0);
  });

  it('ownsJid correctly identifies channel-prefixed JIDs', () => {
    const channel = createMockChannel('myproto');
    expect(channel.ownsJid('myproto:12345')).toBe(true);
    expect(channel.ownsJid('other:12345')).toBe(false);
  });
});

describe('duplicate channel registration', () => {
  it('last registration wins (overwrites previous factory)', () => {
    const factory1 = vi.fn((_opts: ChannelOpts) =>
      createMockChannel('dup', { name: 'dup-v1' }),
    );
    const factory2 = vi.fn((_opts: ChannelOpts) =>
      createMockChannel('dup', { name: 'dup-v2' }),
    );

    registerChannel('dup-channel', factory1);
    registerChannel('dup-channel', factory2);

    const factory = getChannelFactory('dup-channel')!;
    expect(factory).toBe(factory2);

    const result = factory(mockOpts());
    expect(result!.name).toBe('dup-v2');
  });

  it('channel name list has no duplicates after overwrite', () => {
    registerChannel('dedup-test', () => null);
    registerChannel('dedup-test', () => null);

    const names = getRegisteredChannelNames();
    const count = names.filter((n) => n === 'dedup-test').length;
    expect(count).toBe(1);
  });
});

describe('channel connection lifecycle', () => {
  it('connect transitions channel to connected state', async () => {
    let connected = false;
    const channel = createMockChannel('lifecycle', {
      connect: vi.fn(async () => {
        connected = true;
      }),
      isConnected: vi.fn(() => connected),
    });

    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it('disconnect transitions channel away from connected state', async () => {
    let connected = true;
    const channel = createMockChannel('lifecycle-disc', {
      connect: vi.fn(async () => {
        connected = true;
      }),
      disconnect: vi.fn(async () => {
        connected = false;
      }),
      isConnected: vi.fn(() => connected),
    });

    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });
});

describe('initialization loop pattern', () => {
  // This mirrors the orchestrator loop from src/index.ts lines 1206-1218.
  // It exercises the same logic: iterate registered names, call factory,
  // skip nulls, connect non-nulls, and handle connect errors.

  it('skips channels whose factory returns null', async () => {
    registerChannel('init-skip', () => null);
    registerChannel('init-ok', () => createMockChannel('init-ok'));

    const channels: Channel[] = [];
    for (const name of ['init-skip', 'init-ok']) {
      const factory = getChannelFactory(name);
      if (!factory) continue;
      const ch = factory(mockOpts());
      if (!ch) continue;
      channels.push(ch);
      await ch.connect();
    }

    expect(channels.length).toBe(1);
    expect(channels[0].name).toBe('init-ok');
    expect(channels[0].connect).toHaveBeenCalled();
  });

  it('a failing connect does not prevent subsequent channels from connecting', async () => {
    const failChannel = createMockChannel('fail-conn', {
      connect: vi.fn().mockRejectedValue(new Error('connection failed')),
    });
    const okChannel = createMockChannel('ok-conn');

    registerChannel('init-fail', () => failChannel);
    registerChannel('init-pass', () => okChannel);

    const channels: Channel[] = [];
    for (const name of ['init-fail', 'init-pass']) {
      const factory = getChannelFactory(name);
      if (!factory) continue;
      const ch = factory(mockOpts());
      if (!ch) continue;
      try {
        await ch.connect();
        channels.push(ch);
      } catch {
        // In production, would log and continue
      }
    }

    expect(channels.length).toBe(1);
    expect(channels[0].name).toBe('ok-conn');
    expect(okChannel.connect).toHaveBeenCalled();
  });

  it('getChannelFactory returns undefined for unknown channel names', () => {
    expect(getChannelFactory('nonexistent-channel-xyz')).toBeUndefined();
  });
});
