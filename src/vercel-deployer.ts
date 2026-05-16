import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export type DeployMiniAppResult = Record<string, unknown>;

/**
 * Deploy a self-contained HTML file to Vercel and return the result payload.
 *
 * Two callers consume this seam:
 *   1. {@link handleDeployMiniApp} — legacy library entry point, writes the
 *      result to data/ipc/.../deploy_results/{requestId}.json. Retained for
 *      vercel-deployer.test.ts.
 *   2. `deployMiniAppHandler` (src/ipc/handlers/deploy-mini-app.ts) — new
 *      registered IPC handler. Returns the result via the ExecuteResult
 *      contract; the dispatcher writes the file (Rule 1).
 *
 * Pure-ish: reads VERCEL_TOKEN from env, calls fetch. No filesystem side
 * effects in the result directory.
 */
export async function runDeployMiniApp(
  appName: string | undefined,
  html: string | undefined,
  sourceGroup: string,
): Promise<DeployMiniAppResult> {
  try {
    const token = process.env.VERCEL_TOKEN;
    if (!token) {
      return { success: false, error: 'VERCEL_TOKEN not configured' };
    }

    if (!appName || !html) {
      return { success: false, error: 'Missing appName or html' };
    }

    // Validate appName: lowercase alphanumeric + hyphens, max 50 chars
    if (!/^[a-z0-9-]{1,50}$/.test(appName)) {
      return {
        success: false,
        error:
          'Invalid appName: must be lowercase alphanumeric with hyphens, max 50 chars',
      };
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
      return {
        success: false,
        error: `Vercel API returned ${response.status}: ${errBody.slice(0, 500)}`,
      };
    }

    const result = (await response.json()) as { url?: string };
    if (!result.url) {
      return { success: false, error: 'Vercel response missing url field' };
    }

    const url = result.url.startsWith('https://')
      ? result.url
      : `https://${result.url}`;
    logger.info(
      { appName, deployName, url, sourceGroup },
      'Mini app deployed to Vercel',
    );
    return { success: true, url };
  } catch (err) {
    logger.error({ err, sourceGroup }, 'deploy_mini_app error');
    return {
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Legacy library entry point. Validates requestId, computes the result
 * via {@link runDeployMiniApp}, writes to dataDir/ipc/.../deploy_results/.
 *
 * The new dispatcher-driven path lives in
 * src/ipc/handlers/deploy-mini-app.ts and is registered through the
 * IpcHandler registry. This function is retained for the vercel-deployer
 * test harness and any direct callers; the if-ladder caller has been
 * removed.
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

  const appName = data.appName as string | undefined;
  const html = data.html as string | undefined;
  const result = await runDeployMiniApp(appName, html, sourceGroup);

  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'deploy_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const tmpFile = `${resultFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(result));
  fs.renameSync(tmpFile, resultFile);

  return true;
}
