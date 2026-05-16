import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../../db.js';
import { IpcDeps } from '../../ipc.js';
import {
  _resetHandlersForTests,
  buildContext,
  dispatchIpcAction,
  registerIpcHandler,
} from '../handler.js';
import {
  imessageListContactsHandler,
  imessageReadHandler,
  imessageSearchHandler,
  imessageSendHandler,
} from './imessage.js';

/**
 * Per-handler tests for the imessage_* cluster. There were no legacy
 * tests for handleImessageIpc (it was inlined in ipc.ts), so these are
 * the first test coverage for the cluster.
 *
 * imessage-host.ts is stubbed at the import boundary — the goal here is
 * the dispatcher seam (parse, main-only fence at authorize, wire-format
 * path), not the AppleScript-driven Messages.app integration.
 */
vi.mock('../../imessage-host.js', () => ({
  imessageSearch: vi.fn().mockReturnValue([{ id: 'm1', text: 'hi' }]),
  imessageRead: vi.fn().mockReturnValue({ messages: [{ id: 'm1' }] }),
  imessageSend: vi.fn().mockResolvedValue({
    success: true,
    message: 'sent',
  }),
  imessageListContacts: vi.fn().mockReturnValue([{ name: 'Alice', id: 'c1' }]),
}));

describe('imessage_* cluster handlers', () => {
  const MAIN_GROUP = 'telegram_main';
  const OTHER_GROUP = 'telegram_other';

  let dataDir: string;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    _resetHandlersForTests();
    registerIpcHandler(imessageSearchHandler);
    registerIpcHandler(imessageReadHandler);
    registerIpcHandler(imessageSendHandler);
    registerIpcHandler(imessageListContactsHandler);

    setRegisteredGroup('tg:main123', {
      name: 'Main',
      folder: MAIN_GROUP,
      trigger: '@Claire',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    deps = {
      sendMessage: async () => undefined,
      registeredGroups: () => ({}),
      registerGroup: () => undefined,
      syncGroups: async () => undefined,
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => undefined,
      onTasksChanged: () => undefined,
    };

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-handler-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const dispatch = async (
    data: Record<string, unknown>,
    isMain: boolean,
    compoundSource = isMain ? MAIN_GROUP : OTHER_GROUP,
  ) => {
    const ctx = buildContext(compoundSource, isMain, deps, dataDir);
    return dispatchIpcAction(
      data as { type: string } & Record<string, unknown>,
      ctx,
    );
  };

  const readResult = (
    sourceGroup: string,
    requestId: string,
  ): Record<string, unknown> | null => {
    const file = path.join(
      dataDir,
      'ipc',
      sourceGroup,
      'imessage_results',
      `${requestId}.json`,
    );
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  it('all four imessage_* actions share imessage_results/ (wire-format)', async () => {
    await dispatch(
      { type: 'imessage_search', requestId: 'req-s', query: 'x' },
      true,
    );
    await dispatch(
      { type: 'imessage_read', requestId: 'req-r', contact: 'Alice' },
      true,
    );
    await dispatch(
      {
        type: 'imessage_send',
        requestId: 'req-w',
        to: '+1234',
        text: 'hi',
      },
      true,
    );
    await dispatch(
      { type: 'imessage_list_contacts', requestId: 'req-l' },
      true,
    );

    for (const id of ['req-s', 'req-r', 'req-w', 'req-l']) {
      expect(readResult(MAIN_GROUP, id)).not.toBeNull();
    }
  });

  it('main-only fence: non-main callers are denied at authorize (no result file)', async () => {
    await dispatch(
      { type: 'imessage_search', requestId: 'req-deny', query: 'x' },
      false,
    );
    expect(readResult(OTHER_GROUP, 'req-deny')).toBeNull();
  });

  it('main-only fence: non-main send blocked, no message sent', async () => {
    const { imessageSend } = await import('../../imessage-host.js');
    (imessageSend as unknown as ReturnType<typeof vi.fn>).mockClear();
    await dispatch(
      {
        type: 'imessage_send',
        requestId: 'req-deny-send',
        to: '+1234',
        text: 'hi',
      },
      false,
    );
    expect(imessageSend).not.toHaveBeenCalled();
    expect(readResult(OTHER_GROUP, 'req-deny-send')).toBeNull();
  });

  it('imessage_read returns missing-contact failure when contact param absent', async () => {
    await dispatch({ type: 'imessage_read', requestId: 'req-r-empty' }, true);
    const result = readResult(MAIN_GROUP, 'req-r-empty');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('Missing contact parameter');
  });

  it('imessage_send returns missing-param failure when to/text absent', async () => {
    await dispatch(
      { type: 'imessage_send', requestId: 'req-w-empty', to: '' },
      true,
    );
    const result = readResult(MAIN_GROUP, 'req-w-empty');
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain('Missing to or text');
  });

  it('rejects malformed requestId at the dispatcher (Rule 2)', async () => {
    await dispatch(
      { type: 'imessage_search', requestId: '../../etc/passwd', query: 'x' },
      true,
    );
    expect(
      fs.existsSync(path.join(dataDir, 'ipc', MAIN_GROUP, 'imessage_results')),
    ).toBe(false);
  });

  it('reads skip the gate for non-agent callers (Rule 4 skipGate)', async () => {
    await dispatch(
      { type: 'imessage_search', requestId: 'req-no-audit', query: 'x' },
      true,
    );
    const { getDb } = await import('../../db.js');
    const rows = getDb()
      .prepare(
        "SELECT * FROM agent_actions WHERE action_type = 'imessage_search'",
      )
      .all();
    expect(rows).toHaveLength(0);
  });
});
