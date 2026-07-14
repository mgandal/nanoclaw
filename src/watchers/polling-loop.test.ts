import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startPollingLoop } from './polling-loop.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startPollingLoop', () => {
  it('fires after each interval, not immediately by default', async () => {
    const fn = vi.fn();
    const loop = startPollingLoop(fn, { name: 't', intervalMs: 1000 });
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('runImmediately fires the first poll right away', async () => {
    const fn = vi.fn();
    const loop = startPollingLoop(fn, {
      name: 't',
      intervalMs: 1000,
      runImmediately: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('a throwing poll is reported and the chain continues', async () => {
    const onError = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const loop = startPollingLoop(fn, { name: 't', intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('never overlaps: the next tick is scheduled after completion', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const fn = vi.fn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 2500)); // poll slower than interval
      running--;
    });
    const loop = startPollingLoop(fn, { name: 't', intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
    loop.stop();
  });

  it('stop cancels the pending tick', async () => {
    const fn = vi.fn();
    const loop = startPollingLoop(fn, { name: 't', intervalMs: 1000 });
    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('stop during an in-flight poll prevents the reschedule', async () => {
    let resolveRun!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveRun = r;
        }),
    );
    const loop = startPollingLoop(fn, { name: 't', intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    loop.stop();
    resolveRun();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
