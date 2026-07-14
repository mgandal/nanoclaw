import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
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

const GROUPS_ROOT = path.resolve(DATA_DIR, '..', 'groups');

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let sendFileSpy: ReturnType<typeof vi.fn>;

function dispatch(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
) {
  return dispatchIpcAction(
    { type: 'send_file', ...data } as { type: string } & Record<
      string,
      unknown
    >,
    buildContext(sourceGroup, isMain, deps),
  );
}

function makeGroupFile(groupFolder: string, name: string, content: string) {
  const groupDir = path.join(GROUPS_ROOT, groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  const filePath = path.join(groupDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Write a throwaway trust.yaml for a test agent; returns cleanup fn. */
function makeTestAgent(name: string, trustYaml: string): () => void {
  const agentDir = path.join(DATA_DIR, 'agents', name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'trust.yaml'), trustYaml);
  return () => fs.rmSync(agentDir, { recursive: true, force: true });
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
  sendFileSpy = vi.fn().mockResolvedValue(undefined);
  deps = {
    db: getDb(),
    sendMessage: sendMessageSpy as unknown as IpcDeps['sendMessage'],
    sendFile: sendFileSpy as unknown as IpcDeps['sendFile'],
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

afterEach(() => {
  const testOtherDir = path.join(GROUPS_ROOT, 'telegram_other');
  if (fs.existsSync(testOtherDir)) {
    for (const f of [
      'credentials.json',
      'bundle.pem',
      'notes.json',
      'report.md',
      'report.pdf',
      'data.db',
      'script.sh',
      'noext',
      '.hidden',
      'agent-report.pdf',
    ]) {
      try {
        fs.unlinkSync(path.join(testOtherDir, f));
      } catch {
        /* not ours */
      }
    }
  }
});

describe('send_file handler — dispatch parity with processIpcMessage', () => {
  it('handles type send_file on the registry (not the legacy ladder)', async () => {
    const res = await dispatch(
      { chatJid: 'tg:main123', filePath: '/nonexistent/file.txt' },
      'telegram_main',
      true,
    );
    expect(res.handled).toBe(true);
  });

  it('drops payloads missing filePath at parse time', async () => {
    await dispatch({ chatJid: 'tg:main123' }, 'telegram_main', true);
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('drops payloads missing chatJid at parse time', async () => {
    await dispatch({ filePath: '/tmp/x.txt' }, 'telegram_main', true);
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('bails gracefully when deps.sendFile is not wired', async () => {
    deps.sendFile = undefined;
    const res = await dispatch(
      { chatJid: 'tg:main123', filePath: '/tmp/x.txt' },
      'telegram_main',
      true,
    );
    expect(res.handled).toBe(true);
  });
});

describe('send_file authorization (target-group cross-check)', () => {
  it('blocks cross-group send_file (target folder != base group)', async () => {
    await dispatch(
      { chatJid: 'tg:main123', filePath: '/workspace/group/test.txt' },
      'telegram_other--einstein',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('blocks absolute host path pass-through from non-main groups', async () => {
    const hostFile = path.join(os.tmpdir(), `nc-sf-host-${process.pid}.txt`);
    fs.writeFileSync(hostFile, 'secret');
    try {
      await dispatch(
        { chatJid: 'tg:other456', filePath: hostFile },
        'telegram_other',
        false,
      );
      expect(sendFileSpy).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(hostFile);
    }
  });

  it('allows absolute host path pass-through from main group', async () => {
    const hostFile = path.join(os.tmpdir(), `nc-sf-main-${process.pid}.txt`);
    fs.writeFileSync(hostFile, 'ok');
    try {
      await dispatch(
        { chatJid: 'tg:main123', filePath: hostFile },
        'telegram_main',
        true,
      );
      expect(sendFileSpy).toHaveBeenCalledWith(
        'tg:main123',
        hostFile,
        undefined,
      );
    } finally {
      fs.unlinkSync(hostFile);
    }
  });

  it('passes the caption through to sendFile', async () => {
    const hostFile = path.join(os.tmpdir(), `nc-sf-cap-${process.pid}.txt`);
    fs.writeFileSync(hostFile, 'ok');
    try {
      await dispatch(
        { chatJid: 'tg:main123', filePath: hostFile, caption: 'the report' },
        'telegram_main',
        true,
      );
      expect(sendFileSpy).toHaveBeenCalledWith(
        'tg:main123',
        hostFile,
        'the report',
      );
    } finally {
      fs.unlinkSync(hostFile);
    }
  });
});

describe('send_file credential blocklist (B2/B4)', () => {
  it('rejects filename matching credential pattern from non-main', async () => {
    makeGroupFile('telegram_other', 'credentials.json', '{"safe":"ok"}');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/credentials.json' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('rejects filename matching .pem pattern from non-main', async () => {
    makeGroupFile('telegram_other', 'bundle.pem', 'not-a-real-pem');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/bundle.pem' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('rejects content containing refresh_token even with innocuous filename', async () => {
    makeGroupFile(
      'telegram_other',
      'notes.json',
      JSON.stringify({ refresh_token: 'abc123', scope: 'mail' }),
    );
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/notes.json' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('allows a normal non-credential file', async () => {
    makeGroupFile('telegram_other', 'report.md', '# Report\n\nContents.');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/report.md' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).toHaveBeenCalled();
  });

  it('main group bypasses the blocklist (operator tooling)', async () => {
    const hostFile = path.join(
      os.tmpdir(),
      `nc-sf-cred-${process.pid}-credentials.json`,
    );
    fs.writeFileSync(hostFile, '{"refresh_token":"x"}');
    try {
      await dispatch(
        { chatJid: 'tg:main123', filePath: hostFile },
        'telegram_main',
        true,
      );
      expect(sendFileSpy).toHaveBeenCalled();
    } finally {
      fs.unlinkSync(hostFile);
    }
  });
});

describe('send_file extension allowlist (C2)', () => {
  it('rejects .db from non-main (raw data store)', async () => {
    makeGroupFile('telegram_other', 'data.db', 'SQLite format 3');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/data.db' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('rejects .sh from non-main (executable)', async () => {
    makeGroupFile('telegram_other', 'script.sh', '#!/bin/bash\necho hi');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/script.sh' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('rejects extensionless file from non-main', async () => {
    makeGroupFile('telegram_other', 'noext', 'contents');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/noext' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('rejects dotfile from non-main', async () => {
    makeGroupFile('telegram_other', '.hidden', 'contents');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/.hidden' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('allows .pdf from non-main', async () => {
    makeGroupFile('telegram_other', 'report.pdf', '%PDF-1.4 (fake)');
    await dispatch(
      { chatJid: 'tg:other456', filePath: '/workspace/group/report.pdf' },
      'telegram_other',
      false,
    );
    expect(sendFileSpy).toHaveBeenCalled();
  });

  it('main bypasses the extension allowlist (operator tooling)', async () => {
    const hostFile = path.join(os.tmpdir(), `nc-sf-c2-${process.pid}.db`);
    fs.writeFileSync(hostFile, 'SQLite format 3');
    try {
      await dispatch(
        { chatJid: 'tg:main123', filePath: hostFile },
        'telegram_main',
        true,
      );
      expect(sendFileSpy).toHaveBeenCalled();
    } finally {
      fs.unlinkSync(hostFile);
    }
  });
});

describe('send_file trust gate (new under the dispatcher)', () => {
  it('draft-level trust stages a pending_action and does not send', async () => {
    const { listPendingActions } = await import('../../db.js');
    const cleanup = makeTestAgent(
      'sf-draft-agent',
      'actions:\n  send_file: draft\n',
    );
    makeGroupFile('telegram_other', 'agent-report.pdf', '%PDF-1.4 (fake)');
    try {
      await dispatch(
        {
          chatJid: 'tg:other456',
          filePath: '/workspace/group/agent-report.pdf',
        },
        'telegram_other--sf-draft-agent',
        false,
      );
      expect(sendFileSpy).not.toHaveBeenCalled();
      const pending = listPendingActions({});
      expect(pending.some((p) => p.action_type === 'send_file')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('an agent with NO send_file entry stages (fail-safe default: ask)', async () => {
    const { listPendingActions } = await import('../../db.js');
    const cleanup = makeTestAgent(
      'sf-noentry-agent',
      'actions:\n  send_message: notify\n',
    );
    makeGroupFile('telegram_other', 'agent-report.pdf', '%PDF-1.4 (fake)');
    try {
      await dispatch(
        {
          chatJid: 'tg:other456',
          filePath: '/workspace/group/agent-report.pdf',
        },
        'telegram_other--sf-noentry-agent',
        false,
      );
      expect(sendFileSpy).not.toHaveBeenCalled();
      const pending = listPendingActions({});
      expect(pending.some((p) => p.action_type === 'send_file')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('notify-level sends the file AND posts a receipt to main', async () => {
    const cleanup = makeTestAgent(
      'sf-notify-agent',
      'actions:\n  send_file: notify\n',
    );
    makeGroupFile('telegram_other', 'agent-report.pdf', '%PDF-1.4 (fake)');
    try {
      await dispatch(
        {
          chatJid: 'tg:other456',
          filePath: '/workspace/group/agent-report.pdf',
        },
        'telegram_other--sf-notify-agent',
        false,
      );
      expect(sendFileSpy).toHaveBeenCalled();
      const receiptTargets = sendMessageSpy.mock.calls.map((c) => c[0]);
      expect(receiptTargets).toContain('tg:main123');
    } finally {
      cleanup();
    }
  });

  it('writes an audit row keyed on send_file for agent callers', async () => {
    const cleanup = makeTestAgent(
      'sf-audit-agent',
      'actions:\n  send_file: autonomous\n',
    );
    makeGroupFile('telegram_other', 'agent-report.pdf', '%PDF-1.4 (fake)');
    try {
      await dispatch(
        {
          chatJid: 'tg:other456',
          filePath: '/workspace/group/agent-report.pdf',
        },
        'telegram_other--sf-audit-agent',
        false,
      );
      expect(sendFileSpy).toHaveBeenCalled();
      const rows = getDb()
        .prepare(
          `SELECT action_type, outcome, target FROM agent_actions
           WHERE agent_name = 'sf-audit-agent'`,
        )
        .all() as Array<{
        action_type: string;
        outcome: string;
        target: string;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0].action_type).toBe('send_file');
      expect(rows[0].outcome).toBe('allowed');
      expect(rows[0].target).toBe('tg:other456');
    } finally {
      cleanup();
    }
  });

  it('does not fire a receipt when the send THROWS (no false delivery claim)', async () => {
    const cleanup = makeTestAgent(
      'sf-throw-agent',
      'actions:\n  send_file: notify\n',
    );
    makeGroupFile('telegram_other', 'agent-report.pdf', '%PDF-1.4 (fake)');
    sendFileSpy.mockRejectedValue(new Error('telegram 413: file too large'));
    try {
      // rethrowExecuteErrors: the dispatcher rethrows so the watcher can
      // preserve the payload in errors/ — and no receipt reaches main.
      await expect(
        dispatch(
          {
            chatJid: 'tg:other456',
            filePath: '/workspace/group/agent-report.pdf',
          },
          'telegram_other--sf-throw-agent',
          false,
        ),
      ).rejects.toThrow('413');
      expect(sendMessageSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('does not fire a notify receipt when the file send bailed (file missing)', async () => {
    const cleanup = makeTestAgent(
      'sf-bail-agent',
      'actions:\n  send_file: notify\n',
    );
    try {
      await dispatch(
        { chatJid: 'tg:other456', filePath: '/workspace/group/missing.pdf' },
        'telegram_other--sf-bail-agent',
        false,
      );
      expect(sendFileSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
