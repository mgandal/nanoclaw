import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getTaskById,
  setRegisteredGroup,
  updateTask,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { publishKnowledge } from './knowledge.js';
import { RegisteredGroup } from './types.js';

vi.mock('./knowledge.js', () => ({
  publishKnowledge: vi.fn().mockReturnValue('/tmp/fake-knowledge-file.md'),
}));

// --- Shared setup ---

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
  containerConfig: {
    additionalMounts: [
      {
        hostPath: '/host/vault',
        containerPath: 'vault',
        readonly: true,
      },
    ],
  },
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let onTasksChangedSpy: ReturnType<typeof vi.fn>;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let registerGroupSpy: ReturnType<typeof vi.fn>;
let syncGroupsSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'tg:main123': MAIN_GROUP,
    'tg:other456': OTHER_GROUP,
  };

  setRegisteredGroup('tg:main123', MAIN_GROUP);
  setRegisteredGroup('tg:other456', OTHER_GROUP);

  onTasksChangedSpy = vi.fn();
  sendMessageSpy = vi.fn().mockResolvedValue(undefined);
  registerGroupSpy = vi.fn((jid: string, group: RegisteredGroup) => {
    groups[jid] = group;
    setRegisteredGroup(jid, group);
  });
  syncGroupsSpy = vi.fn().mockResolvedValue(undefined);

  deps = {
    sendMessage: sendMessageSpy,
    registeredGroups: () => groups,
    registerGroup: registerGroupSpy,
    syncGroups: syncGroupsSpy,
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: onTasksChangedSpy,
  };
});

// --- 1. update_task edge cases ---

describe('update_task', () => {
  beforeEach(() => {
    createTask({
      id: 'task-update-test',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'original prompt',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2025-06-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('updates prompt without changing schedule', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update-test',
        prompt: 'new prompt',
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('task-update-test');
    expect(task!.prompt).toBe('new prompt');
    expect(task!.schedule_value).toBe('0 9 * * *');
    expect(onTasksChangedSpy).toHaveBeenCalled();
  });

  it('rejects update from non-main group for foreign task', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update-test',
        prompt: 'hacked',
      },
      'telegram_main', // sourceGroup is main folder but isMain=false
      false,
      deps,
    );

    const task = getTaskById('task-update-test');
    expect(task!.prompt).toBe('original prompt');
  });

  it('rejects update with invalid schedule', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update-test',
        schedule_type: 'cron',
        schedule_value: 'not-valid-cron',
      },
      'telegram_main',
      true,
      deps,
    );

    // Should NOT have called onTasksChanged
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
    const task = getTaskById('task-update-test');
    expect(task!.schedule_value).toBe('0 9 * * *');
  });

  it('recomputes next_run when schedule_value changes', async () => {
    const before = Date.now();
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update-test',
        schedule_type: 'interval',
        schedule_value: '7200000', // 2 hours
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('task-update-test');
    expect(task!.schedule_type).toBe('interval');
    const nextRun = new Date(task!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 7200000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 7200000 + 1000);
  });

  it('handles update of nonexistent task gracefully', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'nonexistent-task',
        prompt: 'nope',
      },
      'telegram_main',
      true,
      deps,
    );

    // Should not crash, should not call onTasksChanged
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});

// --- 2. resume_task next_run recomputation ---

describe('resume_task next_run recomputation', () => {
  it('recomputes next_run for interval tasks on resume', async () => {
    createTask({
      id: 'task-interval-resume',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'interval task',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2020-01-01T00:00:00.000Z', // stale
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const before = Date.now();
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-interval-resume' },
      'telegram_other',
      false,
      deps,
    );

    const task = getTaskById('task-interval-resume');
    expect(task!.status).toBe('active');
    const nextRun = new Date(task!.next_run!).getTime();
    // next_run should be ~1 hour from now, not stuck in 2020
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
  });

  it('bumps past-due once tasks to now + 1 min on resume', async () => {
    createTask({
      id: 'task-once-resume',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'once task',
      schedule_type: 'once',
      schedule_value: '2020-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2020-01-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const before = Date.now();
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-once-resume' },
      'telegram_other',
      false,
      deps,
    );

    const task = getTaskById('task-once-resume');
    expect(task!.status).toBe('active');
    const nextRun = new Date(task!.next_run!).getTime();
    // Should be bumped to ~now + 60s
    expect(nextRun).toBeGreaterThanOrEqual(before + 55000);
    expect(nextRun).toBeLessThanOrEqual(before + 120000);
  });
});

// --- 3. register_group preserves isMain flag ---

describe('register_group isMain preservation', () => {
  it('preserves isMain when re-registering existing group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:main123',
        name: 'Main Updated',
        folder: 'telegram_main',
        trigger: '@Claire',
        containerConfig: {
          additionalMounts: [
            { hostPath: '/some/path', containerPath: 'extra' },
          ],
        },
      },
      'telegram_main',
      true,
      deps,
    );

    // The registered group should still have isMain=true
    expect(registerGroupSpy).toHaveBeenCalled();
    const call = registerGroupSpy.mock.calls[0];
    expect(call[1].isMain).toBe(true);
  });

  it('does not grant isMain to a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:new999',
        name: 'New Group',
        folder: 'telegram_new',
        trigger: '@Claire',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(registerGroupSpy).toHaveBeenCalled();
    const call = registerGroupSpy.mock.calls[0];
    // isMain should be undefined (not set) for new groups
    expect(call[1].isMain).toBeUndefined();
  });
});

// --- 4. publish_to_bus ---

describe('publish_to_bus', () => {
  it('publishes message to bus with correct fields', async () => {
    const writeAgentMessageSpy = vi.fn();
    const bussDeps = {
      ...deps,
      messageBus: {
        publish: vi.fn(),
        writeAgentMessage: writeAgentMessageSpy,
        subscribe: vi.fn(),
      } as any,
    };

    await processTaskIpc(
      {
        type: 'publish_to_bus',
        topic: 'status-update',
        to_agent: 'einstein',
        summary: 'System is healthy',
        priority: 'low',
      } as any,
      'telegram_other--curator',
      false,
      bussDeps,
    );

    expect(writeAgentMessageSpy).toHaveBeenCalledWith(
      'telegram_other--einstein',
      expect.objectContaining({
        from: 'curator',
        topic: 'status-update',
        to_agent: 'einstein',
        to_group: 'telegram_other',
        priority: 'low',
      }),
    );
  });

  it('does nothing when messageBus is not available', async () => {
    // No messageBus in deps — should not crash
    await processTaskIpc(
      {
        type: 'publish_to_bus',
        topic: 'test',
        to_agent: 'einstein',
      } as any,
      'telegram_other',
      false,
      deps,
    );
    // No crash is the test
  });

  it('rejects publish with missing to_agent', async () => {
    const writeAgentMessageSpy = vi.fn();
    const bussDeps = {
      ...deps,
      messageBus: {
        publish: vi.fn(),
        writeAgentMessage: writeAgentMessageSpy,
      } as any,
    };

    await processTaskIpc(
      {
        type: 'publish_to_bus',
        topic: 'test',
        // to_agent missing
      } as any,
      'telegram_other',
      false,
      bussDeps,
    );

    expect(writeAgentMessageSpy).not.toHaveBeenCalled();
  });

  it('rejects publish with path traversal in to_agent', async () => {
    const writeAgentMessageSpy = vi.fn();
    const bussDeps = {
      ...deps,
      messageBus: {
        publish: vi.fn(),
        writeAgentMessage: writeAgentMessageSpy,
      } as any,
    };

    await processTaskIpc(
      {
        type: 'publish_to_bus',
        topic: 'test',
        to_agent: '../escape',
      } as any,
      'telegram_other',
      false,
      bussDeps,
    );

    expect(writeAgentMessageSpy).not.toHaveBeenCalled();
  });
});

// --- 5. Unknown task type handling ---

describe('unknown task type', () => {
  it('logs warning for completely unknown type', async () => {
    // This should not crash; it falls through to the default case
    await processTaskIpc(
      { type: 'completely_unknown_type_xyz' },
      'telegram_main',
      true,
      deps,
    );
    // If we reach here, no crash occurred
  });
});

// --- 6. onTasksChanged callback ---

describe('onTasksChanged callback', () => {
  it('is called after schedule_task', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );
    expect(onTasksChangedSpy).toHaveBeenCalledTimes(1);
  });

  it('is called after cancel_task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-12-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-12-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'telegram_other',
      false,
      deps,
    );
    expect(onTasksChangedSpy).toHaveBeenCalledTimes(1);
  });

  it('is NOT called when task operation is unauthorized', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'telegram_main',
      chat_jid: 'tg:main123',
      prompt: 'main only',
      schedule_type: 'once',
      schedule_value: '2025-12-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-12-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-foreign' },
      'telegram_other',
      false,
      deps,
    );
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});

// --- 7. refresh_groups ---

describe('refresh_groups', () => {
  it('main group triggers syncGroups and writeGroupsSnapshot', async () => {
    const writeSnapshotSpy = vi.fn();
    const refreshDeps = { ...deps, writeGroupsSnapshot: writeSnapshotSpy };

    await processTaskIpc(
      { type: 'refresh_groups' },
      'telegram_main',
      true,
      refreshDeps,
    );

    expect(syncGroupsSpy).toHaveBeenCalledWith(true);
    expect(writeSnapshotSpy).toHaveBeenCalled();
  });

  it('non-main group is blocked from refresh_groups', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'telegram_other',
      false,
      deps,
    );

    expect(syncGroupsSpy).not.toHaveBeenCalled();
  });
});

// --- 8. Missing required fields are handled gracefully ---

describe('missing required fields', () => {
  it('schedule_task with no prompt does nothing', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:other456',
        // prompt is missing
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('schedule_task with no targetJid does nothing', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        // targetJid is missing
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('pause_task with no taskId does nothing', async () => {
    await processTaskIpc({ type: 'pause_task' }, 'telegram_main', true, deps);

    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('cancel_task with no taskId does nothing', async () => {
    await processTaskIpc({ type: 'cancel_task' }, 'telegram_main', true, deps);

    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('update_task with no taskId does nothing', async () => {
    await processTaskIpc(
      { type: 'update_task', prompt: 'nope' },
      'telegram_main',
      true,
      deps,
    );

    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});

// --- 9. schedule_task with custom taskId ---

describe('schedule_task custom taskId', () => {
  it('uses provided taskId instead of generating one', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'my-custom-id',
        prompt: 'custom id task',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('my-custom-id');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('custom id task');
  });
});

// --- 10. save_skill IPC ---

describe('save_skill', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-skill-test-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    // Create container/skills directory
    fs.mkdirSync(path.join(tmpDir, 'container', 'skills'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-main group cannot save skills', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'evil-skill',
        skillContent: '# Evil',
      } as any,
      'telegram_other',
      false,
      deps,
    );

    // Skill should NOT be saved
    expect(
      fs.existsSync(
        path.join(tmpDir, 'container', 'skills', 'evil-skill', 'SKILL.md'),
      ),
    ).toBe(false);
  });

  it('rejects invalid skill names', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: '../escape',
        skillContent: '# Bad',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    expect(
      fs.existsSync(
        path.join(tmpDir, 'container', 'skills', '../escape', 'SKILL.md'),
      ),
    ).toBe(false);
  });

  it('rejects overwriting built-in skills', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'status',
        skillContent: '# Overwritten',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    expect(
      fs.existsSync(
        path.join(tmpDir, 'container', 'skills', 'status', 'SKILL.md'),
      ),
    ).toBe(false);
  });

  it('main group can save a valid skill', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'my-new-skill',
        skillContent: '# My New Skill\nDoes something.',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    const skillPath = path.join(
      tmpDir,
      'container',
      'skills',
      'my-new-skill',
      'SKILL.md',
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe(
      '# My New Skill\nDoes something.',
    );
  });
});

// --- 11. Malformed task data handling ---

describe('malformed task data', () => {
  it('handles task with empty type string gracefully', async () => {
    // Empty string type should fall through to default case without crash
    await processTaskIpc({ type: '' }, 'telegram_main', true, deps);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('handles schedule_task with invalid schedule_type gracefully', async () => {
    // A schedule_type that is not cron/interval/once should result in
    // nextRun being null, and createTask should still be called
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test task',
        schedule_type: 'bogus_type',
        schedule_value: 'whatever',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    // Task gets created with null next_run (no matching schedule type branch)
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].next_run).toBeNull();
    expect(onTasksChangedSpy).toHaveBeenCalled();
  });
});

// --- 12. Concurrent task processing ---

describe('concurrent task processing', () => {
  it('handles multiple schedule_task calls in parallel without interference', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      processTaskIpc(
        {
          type: 'schedule_task',
          taskId: `concurrent-task-${i}`,
          prompt: `task ${i}`,
          schedule_type: 'once',
          schedule_value: '2025-12-01T00:00:00',
          targetJid: 'tg:other456',
        },
        'telegram_main',
        true,
        deps,
      ),
    );

    await Promise.all(promises);

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(5);
    expect(onTasksChangedSpy).toHaveBeenCalledTimes(5);
  });

  it('handles mixed task types concurrently', async () => {
    // Create a task first so we can pause it
    createTask({
      id: 'mix-task-1',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'existing',
      schedule_type: 'once',
      schedule_value: '2025-12-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-12-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const promises = [
      processTaskIpc(
        {
          type: 'schedule_task',
          taskId: 'mix-task-2',
          prompt: 'new task',
          schedule_type: 'once',
          schedule_value: '2025-12-01T00:00:00',
          targetJid: 'tg:other456',
        },
        'telegram_main',
        true,
        deps,
      ),
      processTaskIpc(
        { type: 'pause_task', taskId: 'mix-task-1' },
        'telegram_other',
        false,
        deps,
      ),
    ];

    await Promise.all(promises);

    const task1 = getTaskById('mix-task-1');
    const task2 = getTaskById('mix-task-2');
    expect(task1!.status).toBe('paused');
    expect(task2).toBeDefined();
  });
});

// --- 13. schedule_task with invalid cron expression ---

describe('schedule_task with invalid cron', () => {
  it('rejects task with invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'should not be created',
        schedule_type: 'cron',
        schedule_value: 'not a valid cron',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('rejects task with invalid interval value', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'not-a-number',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('rejects task with invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});

// --- 14. knowledge_publish ---

describe('processTaskIpc', () => {
  it('knowledge_publish writes file and stamps sourceGroup', async () => {
    await processTaskIpc(
      {
        type: 'knowledge_publish',
        topic: 'test topic',
        finding: 'test finding',
        evidence: 'test evidence',
        tags: ['tag1', 'tag2'],
        agent: 'forged-identity',
      } as any,
      'telegram_science-claw',
      false,
      deps,
    );

    expect(publishKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'test topic',
        finding: 'test finding',
      }),
      'telegram_science-claw',
      expect.stringContaining('agent-knowledge'),
    );
  });
});

// --- 14. Authorization enforcement ---

describe('authorization enforcement', () => {
  it('non-main group cannot schedule task for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cross-group attack',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:main123',
      },
      'telegram_other',
      false,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });

  it('non-main group cannot register new groups', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:evil999',
        name: 'Evil',
        folder: 'telegram_evil',
        trigger: '@Evil',
      },
      'telegram_other',
      false,
      deps,
    );

    expect(registerGroupSpy).not.toHaveBeenCalled();
  });

  it('non-main group cannot refresh groups', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'telegram_other',
      false,
      deps,
    );

    expect(syncGroupsSpy).not.toHaveBeenCalled();
  });
});

// --- 15. schedule_task context_mode defaults ---

describe('schedule_task context_mode', () => {
  it('defaults to isolated when context_mode is not provided', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'ctx-default',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('ctx-default');
    expect(task!.context_mode).toBe('isolated');
  });

  it('accepts group context_mode', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'ctx-group',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:other456',
        context_mode: 'group',
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('ctx-group');
    expect(task!.context_mode).toBe('group');
  });

  it('falls back to isolated for invalid context_mode', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'ctx-invalid',
        prompt: 'invalid context',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:other456',
        context_mode: 'bogus',
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('ctx-invalid');
    expect(task!.context_mode).toBe('isolated');
  });
});

// --- 16. schedule_task with unregistered target JID ---

describe('schedule_task target validation', () => {
  it('rejects task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'orphan target',
        schedule_type: 'once',
        schedule_value: '2025-12-01T00:00:00',
        targetJid: 'tg:nonexistent999',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});

// --- 17. register_group with invalid folder ---

describe('register_group folder validation', () => {
  it('rejects folder with path traversal', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:bad1',
        name: 'Bad',
        folder: '../escape',
        trigger: '@Bad',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(registerGroupSpy).not.toHaveBeenCalled();
  });

  it('rejects register_group with missing required fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:incomplete',
        name: 'Incomplete',
        // folder and trigger missing
      },
      'telegram_main',
      true,
      deps,
    );

    expect(registerGroupSpy).not.toHaveBeenCalled();
  });
});

// --- 18. save_skill result file writing ---

describe('save_skill result file', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-result-test-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'container', 'skills'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves skill file to disk for valid request', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'result-test-skill',
        skillContent: '# Result Test Skill',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    const skillPath = path.join(
      tmpDir,
      'container',
      'skills',
      'result-test-skill',
      'SKILL.md',
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('# Result Test Skill');
  });

  it('rejects skill with single-char name (regex validation)', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'A',
        skillContent: '# Bad',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    // No skill directory should be created
    const skillDir = path.join(tmpDir, 'container', 'skills', 'A');
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('rejects skill name starting with hyphen', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: '-bad-name',
        skillContent: '# Bad',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    const skillDir = path.join(tmpDir, 'container', 'skills', '-bad-name');
    expect(fs.existsSync(skillDir)).toBe(false);
  });
});

// --- 19. TDD hardening: edge cases ---

describe('save_skill missing skillContent', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-skill-nocontent-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'container', 'skills'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects save_skill with missing skillContent', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'no-content-skill',
        // skillContent is missing
      } as any,
      'telegram_main',
      true,
      deps,
    );

    const skillDir = path.join(
      tmpDir,
      'container',
      'skills',
      'no-content-skill',
    );
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it('rejects save_skill with empty string skillContent', async () => {
    await processTaskIpc(
      {
        type: 'save_skill',
        skillName: 'empty-content',
        skillContent: '',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    // Empty string is falsy, should be rejected by the !skillContent check
    const skillDir = path.join(tmpDir, 'container', 'skills', 'empty-content');
    expect(fs.existsSync(skillDir)).toBe(false);
  });
});

describe('schedule_task with negative interval', () => {
  it('rejects task with negative interval value', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'negative interval',
        schedule_type: 'interval',
        schedule_value: '-5000',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});

describe('schedule_task with past once timestamp', () => {
  it('creates a task even with a past once timestamp', async () => {
    // The schedule_task code does not reject past timestamps for once tasks.
    // It converts the date and sets next_run to the past date.
    // This is arguably valid: the scheduler will pick it up immediately.
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'past-once-task',
        prompt: 'past once',
        schedule_type: 'once',
        schedule_value: '2020-01-01T00:00:00Z',
        targetJid: 'tg:other456',
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('past-once-task');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe('2020-01-01T00:00:00.000Z');
    expect(onTasksChangedSpy).toHaveBeenCalled();
  });
});

describe('resume_task on already-active task', () => {
  it('resume on an active task still recomputes next_run for interval', async () => {
    createTask({
      id: 'already-active-interval',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'active interval',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2020-01-01T00:00:00.000Z', // stale
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const before = Date.now();
    await processTaskIpc(
      { type: 'resume_task', taskId: 'already-active-interval' },
      'telegram_other',
      false,
      deps,
    );

    const task = getTaskById('already-active-interval');
    // Task should still be active, and next_run should be recomputed
    expect(task!.status).toBe('active');
    const nextRun = new Date(task!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
  });
});

describe('update_task with schedule_value only (no schedule_type)', () => {
  beforeEach(() => {
    createTask({
      id: 'task-val-only-update',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'original',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2025-06-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('recomputes next_run when only schedule_value changes', async () => {
    const before = Date.now();
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-val-only-update',
        schedule_value: '7200000', // 2 hours
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('task-val-only-update');
    expect(task!.schedule_value).toBe('7200000');
    // next_run should be recomputed (interval type + new value)
    const nextRun = new Date(task!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 7200000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 7200000 + 1000);
    expect(onTasksChangedSpy).toHaveBeenCalled();
  });
});

describe('publish_to_bus with optional fields', () => {
  it('publishes message even when optional priority is missing', async () => {
    const writeAgentMessageSpy = vi.fn();
    const busDeps = {
      ...deps,
      messageBus: {
        publish: vi.fn(),
        writeAgentMessage: writeAgentMessageSpy,
      } as any,
    };

    await processTaskIpc(
      {
        type: 'publish_to_bus',
        topic: 'test-topic',
        to_agent: 'einstein',
        summary: 'test summary',
        // priority is missing
      } as any,
      'telegram_other--curator',
      false,
      busDeps,
    );

    expect(writeAgentMessageSpy).toHaveBeenCalledWith(
      'telegram_other--einstein',
      expect.objectContaining({
        from: 'curator',
        topic: 'test-topic',
        to_agent: 'einstein',
        priority: undefined,
      }),
    );
  });

  it('uses source agent name as from field', async () => {
    const writeAgentMessageSpy = vi.fn();
    const busDeps = {
      ...deps,
      messageBus: {
        publish: vi.fn(),
        writeAgentMessage: writeAgentMessageSpy,
      } as any,
    };

    await processTaskIpc(
      {
        type: 'publish_to_bus',
        topic: 'override-from',
        to_agent: 'jennifer',
        summary: 'test',
      } as any,
      'telegram_other--custom_sender',
      false,
      busDeps,
    );

    expect(writeAgentMessageSpy).toHaveBeenCalledWith(
      'telegram_other--jennifer',
      expect.objectContaining({
        from: 'custom_sender',
      }),
    );
  });
});

describe('register_group with requiresTrigger and containerConfig', () => {
  it('preserves requiresTrigger flag', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:new-trigger',
        name: 'Trigger Group',
        folder: 'telegram_trigger',
        trigger: '@Bot',
        requiresTrigger: false,
      },
      'telegram_main',
      true,
      deps,
    );

    expect(registerGroupSpy).toHaveBeenCalled();
    const call = registerGroupSpy.mock.calls[0];
    expect(call[1].requiresTrigger).toBe(false);
  });

  it('passes containerConfig with additionalMounts', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'tg:with-mounts',
        name: 'Mount Group',
        folder: 'telegram_mounts',
        trigger: '@Bot',
        containerConfig: {
          additionalMounts: [
            { hostPath: '/data/stuff', containerPath: 'stuff', readonly: true },
          ],
        },
      },
      'telegram_main',
      true,
      deps,
    );

    expect(registerGroupSpy).toHaveBeenCalled();
    const call = registerGroupSpy.mock.calls[0];
    expect(call[1].containerConfig).toEqual({
      additionalMounts: [
        { hostPath: '/data/stuff', containerPath: 'stuff', readonly: true },
      ],
    });
  });
});

describe('update_task rejects schedule_value change to invalid value for existing type', () => {
  beforeEach(() => {
    createTask({
      id: 'task-reject-invalid-val',
      group_folder: 'telegram_other',
      chat_jid: 'tg:other456',
      prompt: 'original',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2025-06-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('rejects update when new schedule_value is too small for interval type', async () => {
    // validateTaskSchedule requires interval >= 30 minutes (1800000ms)
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-reject-invalid-val',
        schedule_value: '1000', // 1 second - too small
      },
      'telegram_main',
      true,
      deps,
    );

    const task = getTaskById('task-reject-invalid-val');
    // Should be rejected - original value preserved
    expect(task!.schedule_value).toBe('3600000');
    expect(onTasksChangedSpy).not.toHaveBeenCalled();
  });
});
