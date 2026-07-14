import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase, getDb, setRegisteredGroup } from '../../db.js';
import { buildContext, dispatchIpcAction } from '../handler.js';
import {
  registerBuiltinHandlers,
  _resetBuiltinHandlersForTests,
} from './index.js';
import { _resetHandlersForTests } from '../handler.js';
import { DATA_DIR } from '../../config.js';
import type { IpcDeps } from '../../ipc.js';
import type { RegisteredGroup } from '../../types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: '@Claire',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'telegram_other',
  trigger: '@Claire',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let sendMessageSpy: ReturnType<typeof vi.fn>;

function dispatch(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
) {
  return dispatchIpcAction(
    { type: 'message', ...data } as { type: string } & Record<string, unknown>,
    buildContext(sourceGroup, isMain, deps),
  );
}

beforeEach(() => {
  _initTestDatabase();
  _resetHandlersForTests();
  _resetBuiltinHandlersForTests();
  registerBuiltinHandlers();

  groups = { 'tg:main123': MAIN_GROUP, 'tg:other456': OTHER_GROUP };
  setRegisteredGroup('tg:main123', MAIN_GROUP);
  setRegisteredGroup('tg:other456', OTHER_GROUP);

  sendMessageSpy = vi.fn().mockResolvedValue(undefined);
  deps = {
    db: getDb(),
    sendMessage: sendMessageSpy as unknown as IpcDeps['sendMessage'],
    registeredGroups: () => groups,
    registerGroup: vi.fn() as unknown as IpcDeps['registerGroup'],
    syncGroups: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as IpcDeps['syncGroups'],
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn() as unknown as IpcDeps['writeGroupsSnapshot'],
    onTasksChanged: vi.fn() as unknown as IpcDeps['onTasksChanged'],
  };
});

describe('message handler — dispatch parity with processIpcMessage', () => {
  it('delivers an authorized message from main', async () => {
    const res = await dispatch(
      { chatJid: 'tg:main123', text: 'hello' },
      'telegram_main',
      true,
    );
    expect(res.handled).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledWith('tg:main123', 'hello');
  });

  it('delivers for a non-compound non-main group (legacy, no trust check)', async () => {
    const res = await dispatch(
      { chatJid: 'tg:other456', text: 'hello from other' },
      'telegram_other',
      false,
    );
    expect(res.handled).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      'tg:other456',
      'hello from other',
    );
  });

  it('blocks an unauthorized cross-group send (target folder != base group)', async () => {
    // sourceGroup telegram_other, non-main, targeting main's jid → blocked.
    await dispatch(
      { chatJid: 'tg:main123', text: 'sneaky' },
      'telegram_other',
      false,
    );
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('A2: draft-level trust stages a pending_action and does not send', async () => {
    const { listPendingActions } = await import('../../db.js');
    const TEST_AGENT = 'msg-draft-agent';
    const agentDir = path.join(DATA_DIR, 'agents', TEST_AGENT);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_message: draft\n',
    );
    try {
      await dispatch(
        { chatJid: 'tg:other456', text: 'staged please' },
        `telegram_other--${TEST_AGENT}`,
        false,
      );
      expect(sendMessageSpy).not.toHaveBeenCalled();
      const pending = listPendingActions({});
      expect(pending.some((p) => p.action_type === 'send_message')).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('A2: notify-level sends AND posts a receipt to main', async () => {
    const TEST_AGENT = 'msg-notify-agent';
    const agentDir = path.join(DATA_DIR, 'agents', TEST_AGENT);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_message: notify\n',
    );
    try {
      await dispatch(
        { chatJid: 'tg:other456', text: 'FYI: updated the deck' },
        `telegram_other--${TEST_AGENT}`,
        false,
      );
      const calls = sendMessageSpy.mock.calls.map((c) => c[0]);
      expect(calls).toContain('tg:other456'); // delivery
      expect(calls).toContain('tg:main123'); // notify receipt
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('suppresses the self-echo receipt when the target IS the main jid', async () => {
    const TEST_AGENT = 'msg-selfecho-agent';
    const agentDir = path.join(DATA_DIR, 'agents', TEST_AGENT);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  send_message: notify\n',
    );
    try {
      // Compound agent in the MAIN group, sending TO main. Delivery happens,
      // but the notify receipt must be suppressed (would echo into the same
      // chat). So sendMessage is called exactly once (the delivery).
      await dispatch(
        { chatJid: 'tg:main123', text: 'to myself' },
        `telegram_main--${TEST_AGENT}`,
        true,
      );
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendMessageSpy).toHaveBeenCalledWith('tg:main123', 'to myself');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
