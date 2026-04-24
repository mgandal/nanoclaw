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
      {
        type: 'dashboard_query',
        requestId: 'r-own',
        queryType: 'task_summary',
      },
      'telegram_other',
      false, // non-main
      tmpDir,
    );

    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_other',
          'dashboard_results',
          'r-own.json',
        ),
        'utf-8',
      ),
    );
    expect(data.success).toBe(true);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('own-task');
  });

  it('M2: run_logs_24h returns only source-group run logs for non-main', async () => {
    for (const [id, folder] of [
      ['t-own', 'telegram_other'],
      ['t-other', 'telegram_claire'],
    ]) {
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
      {
        type: 'dashboard_query',
        requestId: 'r-logs',
        queryType: 'run_logs_24h',
      },
      'telegram_other',
      false,
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_other',
          'dashboard_results',
          'r-logs.json',
        ),
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
      {
        type: 'dashboard_query',
        requestId: 'r-gs',
        queryType: 'group_summary',
      },
      'telegram_other',
      false,
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_other',
          'dashboard_results',
          'r-gs.json',
        ),
        'utf-8',
      ),
    );
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/main/);
  });

  it('M2: skill_inventory is main-only', async () => {
    await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'r-si',
        queryType: 'skill_inventory',
      },
      'telegram_other',
      false,
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_other',
          'dashboard_results',
          'r-si.json',
        ),
        'utf-8',
      ),
    );
    expect(data.success).toBe(false);
  });

  // --- C3: state_freshness pinning invariant ---
  //
  // dashboard-ipc.ts:147-163 exposes mtimes for every file in
  // groups/global/state/ to every group caller (no isMain gate). The inline
  // comment argues this is safe because those files are "already injected
  // into every group's context packet."
  //
  // Verified 2026-04-23 (Task 9 of docs/superpowers/plans/2026-04-23-c3-c20-kg-provenance.md):
  //   - src/context-assembler.ts:221 injects current.md into the packet as
  //     content (not every state file), BUT
  //   - src/container-runner.ts:286-293 mounts the entire groups/global/
  //     directory at /workspace/global (read-only for non-main groups).
  //     Every file in groups/global/state/ is filesystem-accessible to
  //     every group via that mount.
  //
  // Conclusion: mtimes + filenames from state_freshness are strictly a
  // subset of information already accessible via the /workspace/global
  // mount. The comment's claim holds.
  //
  // This pinning test catches architectural drift: if someone narrows the
  // global mount in the future without also gating state_freshness,
  // dashboard-ipc would start leaking info beyond what the mount exposes.
  it('C3 pin: state_freshness exposes exactly the filename set in groups/global/state/', async () => {
    const repoRoot = process.cwd();
    const stateDir = path.join(repoRoot, 'groups', 'global', 'state');

    // Repo invariant: the state dir must exist for this test to mean anything.
    // If this fails, state layout has changed and this pin needs review.
    expect(fs.existsSync(stateDir)).toBe(true);

    const onDisk = new Set(fs.readdirSync(stateDir));
    expect(onDisk.size).toBeGreaterThan(0);

    // Call state_freshness from a non-main group (the exposure path of concern)
    await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'r-sf-pin',
        queryType: 'state_freshness',
      },
      'telegram_other',
      false, // non-main — this is the leak surface being pinned
      tmpDir,
    );
    const data = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_other',
          'dashboard_results',
          'r-sf-pin.json',
        ),
        'utf-8',
      ),
    );
    expect(data.success).toBe(true);
    expect(data.freshness).toBeDefined();

    const exposed = new Set(Object.keys(data.freshness));

    // Invariant: the exposed filename set equals the on-disk filename set.
    // If state_freshness starts filtering, this test will fail and force
    // a design review (do callers still get what they need? is the filter
    // correct?). If someone adds a main-only file to state/ without gating
    // dashboard-ipc, this test will still pass — because the mount in
    // container-runner.ts:286-293 already exposes it, and that's the
    // architectural invariant being pinned.
    expect(exposed).toEqual(onDisk);

    // mtimes must be ISO strings (sanity — structure check)
    for (const [, mtime] of Object.entries(data.freshness)) {
      expect(typeof mtime).toBe('string');
      expect(() => new Date(mtime as string).toISOString()).not.toThrow();
    }
  });

  it('C3 pin: state_freshness is not isMain-gated (same set for main and non-main)', async () => {
    // Companion pin: the dashboard-ipc comment claim is that the exposure
    // is uniform across callers. If a future change adds isMain gating in
    // one branch but not the other, we want loud failure here so the
    // author can decide whether the gate is correct.
    await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'r-sf-main',
        queryType: 'state_freshness',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    await handleDashboardIpc(
      {
        type: 'dashboard_query',
        requestId: 'r-sf-non',
        queryType: 'state_freshness',
      },
      'telegram_other',
      false,
      tmpDir,
    );

    const mainData = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_claire',
          'dashboard_results',
          'r-sf-main.json',
        ),
        'utf-8',
      ),
    );
    const nonMainData = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          'ipc',
          'telegram_other',
          'dashboard_results',
          'r-sf-non.json',
        ),
        'utf-8',
      ),
    );

    expect(mainData.success).toBe(true);
    expect(nonMainData.success).toBe(true);
    // Same filename set exposed to both. mtimes can drift between calls,
    // so compare keys only.
    expect(new Set(Object.keys(nonMainData.freshness))).toEqual(
      new Set(Object.keys(mainData.freshness)),
    );
  });
});
