import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  logTaskRun,
  createTask,
  setRegisteredGroup,
} from './db.js';
import { handleDashboardIpc } from './dashboard-ipc.js';

describe('handleDashboardIpc', () => {
  let tmpDir: string;

  beforeEach(() => {
    _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ipc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-dashboard types', async () => {
    const result = await handleDashboardIpc(
      { type: 'pageindex_fetch' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(false);
  });

  it('handles task_summary query', async () => {
    createTask({
      id: 'test-task-1',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test prompt',
      schedule_type: 'cron',
      schedule_value: '0 7 * * 1-5',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
      agent_name: null,
    });

    const result = await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'req-001',
        queryType: 'task_summary',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const resultFile = path.join(
      tmpDir,
      'ipc',
      'telegram_claire',
      'dashboard_results',
      'req-001.json',
    );
    expect(fs.existsSync(resultFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(data.success).toBe(true);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('test-task-1');
  });

  it('handles run_logs_24h query', async () => {
    // Create the parent task first (FK constraint)
    createTask({
      id: 't1',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:123',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 7 * * 1-5',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
      agent_name: null,
    });
    logTaskRun({
      task_id: 't1',
      run_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });

    const result = await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'req-002',
        queryType: 'run_logs_24h',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_claire',
          'dashboard_results',
          'req-002.json',
        ),
        'utf-8',
      ),
    );
    expect(data.success).toBe(true);
    expect(data.logs).toHaveLength(1);
  });

  it('handles group_summary query', async () => {
    setRegisteredGroup('tg:123', {
      name: 'CLAIRE',
      folder: 'telegram_claire',
      trigger: '@Claire',
      added_at: new Date().toISOString(),
      isMain: true,
      requiresTrigger: false,
    });

    const result = await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'req-003',
        queryType: 'group_summary',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_claire',
          'dashboard_results',
          'req-003.json',
        ),
        'utf-8',
      ),
    );
    expect(data.success).toBe(true);
    expect(data.groups).toBeDefined();
  });

  it('rejects invalid requestId', async () => {
    const result = await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: '../../../etc/passwd',
        queryType: 'task_summary',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true); // handled (rejected), not unrecognized
  });

  // --- M2: per-group scoping ---

  it('M2: task_summary returns only the source group tasks for non-main', async () => {
    createTask({
      id: 'own-task',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other',
      prompt: 'own',
      schedule_type: 'cron',
      schedule_value: '0 7 * * *',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
      agent_name: null,
    });
    createTask({
      id: 'other-task',
      group_folder: 'telegram_claire',
      chat_jid: 'tg:claire',
      prompt: 'confidential',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      status: 'active',
      next_run: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context_mode: 'isolated',
      agent_name: null,
    });

    await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'r-own', queryType: 'task_summary' },
      'telegram_other',
      false, // non-main
      tmpDir,
    );

    const data = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'ipc', 'telegram_other', 'dashboard_results', 'r-own.json'),
        'utf-8',
      ),
    );
    expect(data.success).toBe(true);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('own-task');
  });

  it('M2: run_logs_24h returns only source-group run logs for non-main', async () => {
    for (const [id, folder] of [['t-own', 'telegram_other'], ['t-other', 'telegram_claire']]) {
      createTask({
        id,
        group_folder: folder,
        chat_jid: 'tg:x',
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        status: 'active',
        next_run: new Date().toISOString(),
        created_at: new Date().toISOString(),
        context_mode: 'isolated',
        agent_name: null,
      });
      logTaskRun({
        task_id: id,
        run_at: new Date().toISOString(),
        duration_ms: 10,
        status: 'success',
        result: folder === 'telegram_claire' ? 'CLAIRE PRIVATE' : 'ok',
        error: null,
      });
    }

    await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'r-logs', queryType: 'run_logs_24h' },
      'telegram_other',
      false,
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'ipc', 'telegram_other', 'dashboard_results', 'r-logs.json'),
        'utf-8',
      ),
    );
    expect(data.success).toBe(true);
    expect(data.logs).toHaveLength(1);
    expect(data.logs[0].task_id).toBe('t-own');
    expect(JSON.stringify(data)).not.toContain('CLAIRE PRIVATE');
  });

  it('M2: group_summary is main-only', async () => {
    await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'r-gs', queryType: 'group_summary' },
      'telegram_other',
      false,
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'ipc', 'telegram_other', 'dashboard_results', 'r-gs.json'),
        'utf-8',
      ),
    );
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/main/);
  });

  it('M2: skill_inventory is main-only', async () => {
    await handleDashboardIpc(
      { type: 'dashboard_query', requestId: 'r-si', queryType: 'skill_inventory' },
      'telegram_other',
      false,
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'ipc', 'telegram_other', 'dashboard_results', 'r-si.json'),
        'utf-8',
      ),
    );
    expect(data.success).toBe(false);
  });
});
