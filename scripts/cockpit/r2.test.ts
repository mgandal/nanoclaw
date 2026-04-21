import { describe, it, expect, vi } from 'vitest';
import { uploadObject } from './r2.js';

describe('uploadObject', () => {
  it('calls client.send once on success', async () => {
    const send = vi.fn().mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const client = { send } as any;
    await uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx error', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('500'), { $metadata: { httpStatusCode: 500 } }))
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    const client = { send } as any;
    await uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx', async () => {
    const err = Object.assign(new Error('403'), { $metadata: { httpStatusCode: 403 } });
    const send = vi.fn().mockRejectedValue(err);
    const client = { send } as any;
    await expect(uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails after retrying once on persistent 5xx', async () => {
    const err = Object.assign(new Error('503'), { $metadata: { httpStatusCode: 503 } });
    const send = vi.fn().mockRejectedValue(err);
    const client = { send } as any;
    await expect(uploadObject(client, 'bucket', 'key.json', 'body', 'application/json', 1)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
