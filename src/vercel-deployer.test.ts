import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDeployMiniApp } from './vercel-deployer.js';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('handleDeployMiniApp', () => {
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-ipc-'));
    process.env = { ...originalEnv, VERCEL_TOKEN: 'test-token-123' };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  const readResult = (requestId: string) => {
    const file = path.join(tmpDir, 'ipc', 'telegram_claire', 'deploy_results', `${requestId}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  };

  it('returns false for non-deploy_mini_app types', async () => {
    const result = await handleDeployMiniApp(
      { type: 'pageindex_fetch' },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(false);
  });

  it('happy path — successful deployment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'nanoclaw-quiz-m4k7.vercel.app' }),
      }),
    );

    const result = await handleDeployMiniApp(
      {
        type: 'deploy_mini_app',
        requestId: 'req-001',
        appName: 'quiz',
        html: '<html><body>Hello</body></html>',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);

    const data = readResult('req-001');
    expect(data.success).toBe(true);
    expect(data.url).toBe('https://nanoclaw-quiz-m4k7.vercel.app');

    // Verify Vercel API was called correctly
    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vercel.com/v13/deployments');
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token-123');
    const body = JSON.parse(opts.body as string);
    expect(body.name).toMatch(/^nanoclaw-quiz-/);
    expect(body.files[0].file).toBe('index.html');
    expect(body.files[0].encoding).toBe('base64');
    expect(body.projectSettings.framework).toBeNull();
    expect(body.target).toBe('production');
  });

  it('prepends https:// when Vercel url lacks it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://nanoclaw-quiz-m4k7.vercel.app' }),
      }),
    );

    await handleDeployMiniApp(
      { type: 'deploy_mini_app', requestId: 'req-https', appName: 'quiz', html: '<html></html>' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-https');
    expect(data.url).toBe('https://nanoclaw-quiz-m4k7.vercel.app');
  });

  it('returns error when Vercel API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid token',
      }),
    );

    await handleDeployMiniApp(
      { type: 'deploy_mini_app', requestId: 'req-002', appName: 'quiz', html: '<html></html>' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-002');
    expect(data.success).toBe(false);
    expect(data.error).toContain('401');
    expect(data.error).toContain('Invalid token');
  });

  it('returns error when VERCEL_TOKEN is missing', async () => {
    delete process.env.VERCEL_TOKEN;

    await handleDeployMiniApp(
      { type: 'deploy_mini_app', requestId: 'req-003', appName: 'quiz', html: '<html></html>' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-003');
    expect(data.success).toBe(false);
    expect(data.error).toContain('VERCEL_TOKEN');
  });

  it('returns error when Vercel response has no url field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'dpl_123', readyState: 'QUEUED' }),
      }),
    );

    await handleDeployMiniApp(
      { type: 'deploy_mini_app', requestId: 'req-004', appName: 'quiz', html: '<html></html>' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-004');
    expect(data.success).toBe(false);
    expect(data.error).toContain('missing url');
  });

  it('returns error for missing html', async () => {
    await handleDeployMiniApp(
      { type: 'deploy_mini_app', requestId: 'req-005', appName: 'quiz' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-005');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Missing');
  });

  it('validates appName format', async () => {
    await handleDeployMiniApp(
      {
        type: 'deploy_mini_app',
        requestId: 'req-006',
        appName: 'INVALID NAME!',
        html: '<html></html>',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-006');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Invalid appName');
  });

  it('rejects path-traversal requestId without writing result file', async () => {
    const result = await handleDeployMiniApp(
      {
        type: 'deploy_mini_app',
        requestId: '../../../etc/passwd',
        appName: 'quiz',
        html: '<html></html>',
      },
      'telegram_claire',
      true,
      tmpDir,
    );
    expect(result).toBe(true);
    // No result file should exist for the traversal attempt
    const maliciousPath = path.join(tmpDir, '../../../etc/passwd.json');
    expect(fs.existsSync(maliciousPath)).toBe(false);
  });

  it('handles fetch/network errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unreachable')));

    await handleDeployMiniApp(
      { type: 'deploy_mini_app', requestId: 'req-007', appName: 'quiz', html: '<html></html>' },
      'telegram_claire',
      true,
      tmpDir,
    );
    const data = readResult('req-007');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Network unreachable');
  });
});
