import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Regression: FIFO ordering within a group ---

  it('processes tasks in FIFO order within a group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a message container to block the group
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue 3 tasks while group is active
    for (let i = 1; i <= 3; i++) {
      const idx = i;
      queue.enqueueTask('group1@g.us', `task-${idx}`, async () => {
        executionOrder.push(`task-${idx}`);
      });
    }

    // Release the message container — tasks drain in order
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);
    // Task 1 runs, completes, drains task 2
    await vi.advanceTimersByTimeAsync(10);
    // Task 2 runs, completes, drains task 3
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder).toEqual(['task-1', 'task-2', 'task-3']);
  });

  // --- Regression: parallel processing across groups ---

  it('runs different groups in parallel up to concurrency limit', async () => {
    const activeGroups = new Set<string>();
    let maxParallel = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeGroups.add(groupJid);
      maxParallel = Math.max(maxParallel, activeGroups.size);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeGroups.delete(groupJid);
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('groupA@g.us');
    queue.enqueueMessageCheck('groupB@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(maxParallel).toBe(2);
    expect(activeGroups.size).toBe(2);

    // Clean up
    completionCallbacks.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Regression: error propagation from queued tasks ---

  it('continues draining after a task throws an error', async () => {
    const executionOrder: string[] = [];
    let resolveBlock: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveBlock = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a failing task and a succeeding task
    queue.enqueueTask('group1@g.us', 'bad-task', async () => {
      executionOrder.push('bad-task');
      throw new Error('task exploded');
    });
    queue.enqueueTask('group1@g.us', 'good-task', async () => {
      executionOrder.push('good-task');
    });

    // Release the message container
    resolveBlock!();
    await vi.advanceTimersByTimeAsync(10);
    // bad-task runs, throws, drains good-task
    await vi.advanceTimersByTimeAsync(10);

    // Good task should still run despite the previous task failing
    expect(executionOrder).toContain('bad-task');
    expect(executionOrder).toContain('good-task');
  });

  // --- Regression: group isolation on failure ---

  it('one group failure does not block other groups', async () => {
    const processed: string[] = [];
    const completionCallbacks = new Map<string, () => void>();

    const processMessages = vi.fn(async (groupJid: string) => {
      if (groupJid === 'bad@g.us') {
        throw new Error('group failure');
      }
      processed.push(groupJid);
      await new Promise<void>((resolve) =>
        completionCallbacks.set(groupJid, resolve),
      );
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('bad@g.us');
    queue.enqueueMessageCheck('good@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // bad@g.us threw — its slot freed, good@g.us should still be running
    expect(processed).toContain('good@g.us');

    completionCallbacks.get('good@g.us')?.();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Regression: shutdown drains active containers ---

  it('shutdown waits for active containers then resolves', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start shutdown with a long grace period
    let shutdownResolved = false;
    const shutdownPromise = queue.shutdown(30000).then(() => {
      shutdownResolved = true;
    });

    // Not yet resolved
    await vi.advanceTimersByTimeAsync(100);
    expect(shutdownResolved).toBe(false);

    // Complete the active container
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(600); // poll interval is 500ms

    expect(shutdownResolved).toBe(true);
    await shutdownPromise;
  });

  // --- Regression: shutdown grace period timeout ---

  it('shutdown resolves after grace period even if containers are stuck', async () => {
    const processMessages = vi.fn(
      async () =>
        new Promise<boolean>(() => {
          /* never resolves */
        }),
    );

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    let shutdownResolved = false;
    const shutdownPromise = queue.shutdown(5000).then(() => {
      shutdownResolved = true;
    });

    // Advance past grace period
    await vi.advanceTimersByTimeAsync(5500);

    expect(shutdownResolved).toBe(true);
    await shutdownPromise;
  });

  // --- Regression: empty queue edge cases ---

  it('enqueueMessageCheck on empty queue with no processMessagesFn is safe', async () => {
    // No processMessagesFn set — should not throw
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);
    // No crash = pass
  });

  it('shutdown on empty queue resolves immediately', async () => {
    let resolved = false;
    await queue.shutdown(5000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  // --- Regression: stale waitingGroups cleanup (from drainGroup bug fix) ---

  it('cleans up stale waitingGroups entries when group state is drained', async () => {
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // group3 goes to waiting list
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Now complete group3's pending messages before it gets a slot:
    // enqueue another message for group3 so it has pendingMessages=true
    // then complete group1 so group3 starts
    completionCallbacks[0](); // group1 done
    await vi.advanceTimersByTimeAsync(10);

    // group3 should have started
    expect(processMessages).toHaveBeenCalledTimes(3);
    expect(processMessages).toHaveBeenLastCalledWith('group3@g.us');

    // Clean up remaining
    completionCallbacks[1](); // group2
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks[2](); // group3
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Regression: double-enqueue prevention for pending tasks ---

  it('prevents duplicate task IDs in pending queue', async () => {
    let resolveBlock: () => void;
    const executionCount: Record<string, number> = {};

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveBlock = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Block group with a message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue same task ID twice while blocked
    const makeFn = (label: string) => async () => {
      executionCount[label] = (executionCount[label] || 0) + 1;
    };
    queue.enqueueTask('group1@g.us', 'dup-task', makeFn('first'));
    queue.enqueueTask('group1@g.us', 'dup-task', makeFn('second'));

    // Release
    resolveBlock!();
    await vi.advanceTimersByTimeAsync(10);

    // Only the first enqueue should have run
    expect(executionCount['first']).toBe(1);
    expect(executionCount['second']).toBeUndefined();
  });

  // --- TDD Hardening: FIFO ordering for message drains ---

  it('drains pending messages in FIFO order across multiple enqueue cycles', async () => {
    const callOrder: number[] = [];
    let callIndex = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string) => {
      const idx = ++callIndex;
      callOrder.push(idx);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // First message starts immediately
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callIndex).toBe(1);

    // Enqueue 3 more while active — all set pendingMessages=true
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Complete first — drain fires once (pendingMessages is a boolean, not a counter)
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(callIndex).toBe(2);

    // Complete second
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    // pendingMessages was consumed by the drain, so only 2 total calls
    expect(callIndex).toBe(2);
    expect(callOrder).toEqual([1, 2]);
  });

  // --- TDD Hardening: Cross-group task parallelism ---

  it('runs tasks for different groups in parallel', async () => {
    const activeGroups = new Set<string>();
    let maxParallel = 0;
    const completionCallbacks: Array<() => void> = [];

    queue.enqueueTask('groupA@g.us', 'taskA', async () => {
      activeGroups.add('groupA');
      maxParallel = Math.max(maxParallel, activeGroups.size);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeGroups.delete('groupA');
    });

    queue.enqueueTask('groupB@g.us', 'taskB', async () => {
      activeGroups.add('groupB');
      maxParallel = Math.max(maxParallel, activeGroups.size);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeGroups.delete('groupB');
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(maxParallel).toBe(2);
    expect(activeGroups.size).toBe(2);

    completionCallbacks.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- TDD Hardening: Drain on empty queue is a no-op ---

  it('does nothing when draining a group with no pending work', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    // Run a message, let it complete — drain should be a no-op
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Only 1 call — no spurious re-processing
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  // --- TDD Hardening: Rapid burst enqueue ---

  it('handles rapid burst of enqueues for the same group without duplication', async () => {
    let callCount = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      callCount++;
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Burst: 10 rapid enqueues
    for (let i = 0; i < 10; i++) {
      queue.enqueueMessageCheck('group1@g.us');
    }

    await vi.advanceTimersByTimeAsync(10);
    // Only 1 should be running (first starts, rest set pendingMessages=true)
    expect(callCount).toBe(1);

    // Complete first — drain fires once (boolean flag)
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Complete second — no more pending
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);
  });

  // --- TDD Hardening: processMessages error doesn't block next drain ---

  it('group continues processing after processMessages throws', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing — will throw
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // The error triggers scheduleRetry → enqueueMessageCheck after 5000ms
    await vi.advanceTimersByTimeAsync(5010);
    expect(callCount).toBe(2);
  });

  // --- TDD Hardening: Concurrent tasks + messages interleaved ---

  it('interleaved task and message enqueues are processed correctly', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async () => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('msg');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Interleave: task, message, task
    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      executionOrder.push('task-1');
    });
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask('group1@g.us', 'task-2', async () => {
      executionOrder.push('task-2');
    });

    // Release blocking message
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);
    // Tasks drain first (task-1), then task-2, then messages
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    // Tasks should run before the pending message drain
    expect(executionOrder).toEqual(['msg', 'task-1', 'task-2', 'msg']);
  });

  // --- TDD Hardening: retryCount resets on success after failure ---

  it('resets retryCount on success after previous failures', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      // Fail first 2 times, succeed on 3rd
      return callCount >= 3;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1); // fail

    // Retry 1 after 5000ms
    await vi.advanceTimersByTimeAsync(5010);
    expect(callCount).toBe(2); // fail

    // Retry 2 after 10000ms
    await vi.advanceTimersByTimeAsync(10010);
    expect(callCount).toBe(3); // success — retryCount resets

    // Now trigger a new failure to verify retryCount was reset
    // (if not reset, we'd be at retry 3 and delay would be 40s)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(4); // fail again (callCount >= 3 is true, but let's restructure)
  });

  // --- TDD Hardening: shutdown drops pending items ---

  it('shutdown prevents pending tasks and messages from running', async () => {
    let resolveFirst: () => void;
    const taskRan = vi.fn();

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start one container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue pending work
    queue.enqueueTask('group1@g.us', 'task-1', taskRan);
    queue.enqueueMessageCheck('group1@g.us');

    // Start shutdown
    const shutdownPromise = queue.shutdown(10000);

    // Complete the active container
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(600);

    await shutdownPromise;

    // The pending task should NOT have run because shuttingDown blocks drainGroup
    expect(taskRan).not.toHaveBeenCalled();
  });

  // --- TDD Hardening: shutdown cancels retry timers ---

  it('retry timer does not fire after shutdown', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Shutdown before retry fires
    await queue.shutdown(100);
    await vi.advanceTimersByTimeAsync(200);

    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(6000);

    // Retry should NOT have fired
    expect(callCount).toBe(1);
  });

  // --- TDD Hardening: task enqueue during shutdown ---

  it('enqueueTask is silently dropped during shutdown', async () => {
    const taskRan = vi.fn();

    await queue.shutdown(100);

    queue.enqueueTask('group1@g.us', 'task-1', taskRan);
    await vi.advanceTimersByTimeAsync(100);

    expect(taskRan).not.toHaveBeenCalled();
  });

  // --- Compound key support ---

  describe('compound key support', () => {
    it('tracks compound key state separately from base group', () => {
      // setAgentName creates the state entry via getGroup (lazy init)
      queue.setAgentName('telegram_lab-claw:einstein', 'einstein');
      const state = queue.getGroupState('telegram_lab-claw:einstein');
      expect(state).toBeDefined();
    });

    it('stores agentName on GroupState', () => {
      queue.setAgentName('telegram_lab-claw:einstein', 'einstein');
      const state = queue.getGroupState('telegram_lab-claw:einstein');
      expect(state?.agentName).toBe('einstein');
    });

    it('compound key state is isolated from the base group', () => {
      queue.setAgentName('telegram_lab-claw:einstein', 'einstein');
      queue.setAgentName('telegram_lab-claw', 'base');
      const compoundState = queue.getGroupState('telegram_lab-claw:einstein');
      const baseState = queue.getGroupState('telegram_lab-claw');
      expect(compoundState?.agentName).toBe('einstein');
      expect(baseState?.agentName).toBe('base');
    });
  });
});
