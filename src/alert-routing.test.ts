import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OPS_ALERT_FOLDER } from './config.js';

describe('alert routing contract', () => {
  it('OPS_ALERT_FOLDER defaults to telegram_ops-claw', () => {
    expect(OPS_ALERT_FOLDER).toBe('telegram_ops-claw');
  });

  it('OPS_ALERT_FOLDER is a string, not an array', () => {
    expect(typeof OPS_ALERT_FOLDER).toBe('string');
  });
});

describe('task scheduler alert routing', () => {
  it('flushAlerts resolves OPS group by folder, not isMain', async () => {
    const { _initTestDatabase } = await import('./db.js');
    const { checkAlerts, _resetAlertsForTests } =
      await import('./task-scheduler.js');
    const { logTaskRun, createTask } = await import('./db.js');

    _initTestDatabase();
    _resetAlertsForTests();

    vi.useFakeTimers();

    createTask({
      id: 'routing-test',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 7 * * 1-5',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
      script: null,
      agent_name: null,
    });
    logTaskRun({
      task_id: 'routing-test',
      run_at: '2026-04-13T10:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail1',
    });
    logTaskRun({
      task_id: 'routing-test',
      run_at: '2026-04-13T11:00:00Z',
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail2',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const deps = {
      registeredGroups: () => ({
        'tg:ops': {
          name: 'OPS-claw',
          folder: 'telegram_ops-claw',
          trigger: '@Claire',
          added_at: new Date().toISOString(),
          isMain: false,
          requiresTrigger: false,
        },
      }),
      getSessions: () => ({}),
      queue: {} as any,
      onProcess: vi.fn(),
      sendMessage,
    };

    checkAlerts(
      {
        id: 'routing-test',
        group_folder: 'telegram_claire',
        chat_jid: 'tg:123',
        prompt: 'test',
        schedule_type: 'cron',
        schedule_value: '0 7 * * 1-5',
        status: 'active',
        next_run: new Date().toISOString(),
        last_run: null,
        last_result: null,
        created_at: new Date().toISOString(),
        context_mode: 'isolated',
        script: null,
        agent_name: null,
      },
      'fail2',
      deps,
    );

    vi.advanceTimersByTime(70000);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('tg:ops');

    vi.useRealTimers();
    _resetAlertsForTests();
  });
});
