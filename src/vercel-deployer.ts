import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/**
 * Handle deploy_mini_app IPC requests from container agents.
 * Deploys a self-contained HTML file to Vercel and writes the result URL
 * back to the deploy_results directory for the container to poll.
 *
 * Follows the same pattern as handleDashboardIpc / handlePageindexIpc.
 * Returns true if handled, false if not a deploy_mini_app type.
 */
export async function handleDeployMiniApp(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  if (data.type !== 'deploy_mini_app') return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) {
    logger.warn(
      { sourceGroup, requestId },
      'deploy_mini_app IPC invalid requestId',
    );
    return true;
  }

  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'deploy_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    const token = process.env.VERCEL_TOKEN;
    if (!token) {
      writeResult({ success: false, error: 'VERCEL_TOKEN not configured' });
      return true;
    }

    const appName = data.appName as string | undefined;
    const html = data.html as string | undefined;

    if (!appName || !html) {
      writeResult({ success: false, error: 'Missing appName or html' });
      return true;
    }

    // Validate appName: lowercase alphanumeric + hyphens, max 50 chars
    if (!/^[a-z0-9-]{1,50}$/.test(appName)) {
      writeResult({
        success: false,
        error:
          'Invalid appName: must be lowercase alphanumeric with hyphens, max 50 chars',
      });
      return true;
    }

    // Generate unique deployment name with base-36 timestamp
    const timestamp36 = Date.now().toString(36);
    const deployName = `nanoclaw-${appName}-${timestamp36}`;

    // Base64 encode the HTML for Vercel API
    const htmlBase64 = Buffer.from(html, 'utf-8').toString('base64');

    const response = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: deployName,
        files: [
          {
            file: 'index.html',
            data: htmlBase64,
            encoding: 'base64',
          },
        ],
        projectSettings: {
          framework: null,
        },
        target: 'production',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown error');
      writeResult({
        success: false,
        error: `Vercel API returned ${response.status}: ${errBody.slice(0, 500)}`,
      });
      return true;
    }

    const result = (await response.json()) as { url?: string };
    if (!result.url) {
      writeResult({
        success: false,
        error: 'Vercel response missing url field',
      });
      return true;
    }

    const url = result.url.startsWith('https://')
      ? result.url
      : `https://${result.url}`;
    writeResult({ success: true, url });
    logger.info(
      { appName, deployName, url, sourceGroup },
      'Mini app deployed to Vercel',
    );
    return true;
  } catch (err) {
    logger.error({ err, sourceGroup }, 'deploy_mini_app IPC error');
    writeResult({
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}
