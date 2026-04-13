import { describe, it, expect, vi } from 'vitest';

import { withRetry } from './reconnect.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, 3, 10)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback on each failure', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');
    await withRetry(fn, 3, 10, onRetry);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });
});
