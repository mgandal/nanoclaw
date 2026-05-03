import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { firePostHocNotify } from './trust-notify.js';
import { logger } from './logger.js';

const mainJid = 'tg:main-1';
const otherJid = 'tg:other-2';

function makeRegisteredGroups(
  extra: Record<string, { isMain?: boolean; name?: string }> = {},
) {
  return {
    [mainJid]: { isMain: true, name: 'CLAIRE' },
    [otherJid]: { isMain: false, name: 'LAB-claw' },
    ...extra,
  } as Record<string, { isMain?: boolean; name?: string }>;
}

describe('firePostHocNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns silently when notify=false (no sendMessage call)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await firePostHocNotify({
      notify: false,
      agentName: 'einstein',
      actionType: 'schedule_task',
      summary: 'cron task added',
      target: 'task-123',
      registeredGroups: makeRegisteredGroups(),
      deps: { sendMessage },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns silently when agentName is null (defensive)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await firePostHocNotify({
      notify: true,
      agentName: null,
      actionType: 'schedule_task',
      summary: 'cron task added',
      target: 'task-123',
      registeredGroups: makeRegisteredGroups(),
      deps: { sendMessage },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends to main when notify=true && agentName is set', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await firePostHocNotify({
      notify: true,
      agentName: 'einstein',
      actionType: 'schedule_task',
      summary: 'cron task added',
      target: 'task-123',
      registeredGroups: makeRegisteredGroups(),
      deps: { sendMessage },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = sendMessage.mock.calls[0];
    expect(jid).toBe(mainJid);
    expect(msg).toContain('einstein');
    expect(msg).toContain('schedule_task');
    expect(msg).toContain('cron task added');
  });

  it('truncates summary to 200 chars (matching send_message precedent)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const longSummary = 'A'.repeat(500);
    await firePostHocNotify({
      notify: true,
      agentName: 'einstein',
      actionType: 'kg_query',
      summary: longSummary,
      target: 'q-1',
      registeredGroups: makeRegisteredGroups(),
      deps: { sendMessage },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    // The summary inside the composed message must be capped at 200 chars
    // (we don't measure the entire formatted message because the prefix
    // template adds bounded extra chars).
    const aRun = msg.match(/A+/);
    expect(aRun).not.toBeNull();
    expect(aRun![0].length).toBe(200);
  });

  it('no-ops if no main group is registered', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await firePostHocNotify({
      notify: true,
      agentName: 'einstein',
      actionType: 'schedule_task',
      summary: 'cron task added',
      target: 'task-123',
      registeredGroups: { [otherJid]: { isMain: false, name: 'LAB-claw' } },
      deps: { sendMessage },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('logs a warn but does not throw on sendMessage failure', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      firePostHocNotify({
        notify: true,
        agentName: 'einstein',
        actionType: 'schedule_task',
        summary: 'cron task added',
        target: 'task-123',
        registeredGroups: makeRegisteredGroups(),
        deps: { sendMessage },
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('omits target line when target is undefined', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await firePostHocNotify({
      notify: true,
      agentName: 'einstein',
      actionType: 'kg_query',
      summary: 'reading recent papers',
      target: undefined,
      registeredGroups: makeRegisteredGroups(),
      deps: { sendMessage },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    expect(msg).not.toMatch(/target:/i);
  });
});
