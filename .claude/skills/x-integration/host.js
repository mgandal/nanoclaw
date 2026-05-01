/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * This is the entry point for X integration in the host process.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../../src/logger.js';
// Run a skill script as subprocess
async function runScript(script, args) {
    const scriptPath = path.join(process.cwd(), '.claude', 'skills', 'x-integration', 'scripts', `${script}.ts`);
    return new Promise((resolve) => {
        const nodeBinDir = '/Users/mgandal/.local/share/fnm/node-versions/v22.22.0/installation/bin';
        // Restricted env: never spread process.env — that would leak host secrets
        // (CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN, Slack tokens, etc.) into the
        // tsx subprocess. Allowlist only what the script genuinely needs.
        const proc = spawn(nodeBinDir + '/npx', ['tsx', scriptPath], {
            cwd: process.cwd(),
            env: {
                NANOCLAW_ROOT: process.cwd(),
                PATH: nodeBinDir + ':' + (process.env.PATH || ''),
                HOME: process.env.HOME || '',
                CHROME_PATH: process.env.CHROME_PATH || '',
            },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stdin.write(JSON.stringify(args));
        proc.stdin.end();
        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve({ success: false, message: 'Script timed out (120s)' });
        }, 120000);
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve({ success: false, message: `Script exited with code: ${code}` });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                resolve(JSON.parse(lines[lines.length - 1]));
            }
            catch {
                resolve({ success: false, message: `Failed to parse output: ${stdout.slice(0, 200)}` });
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({ success: false, message: `Failed to spawn: ${err.message}` });
        });
    });
}
// Write result to IPC results directory
function writeResult(dataDir, sourceGroup, requestId, result) {
    const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'x_results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}
/**
 * Handle X integration IPC messages
 *
 * @returns true if message was handled, false if not an X message
 */
export async function handleXIpc(data, sourceGroup, isMain, dataDir) {
    const type = data.type;
    // Only handle x_* types
    if (!type?.startsWith('x_')) {
        return false;
    }
    // Fail-closed allowlist: every X tool is main-only by default. To open a
    // tool to non-main groups, add it here AND register it outside the
    // `if (isMain)` block in container/agent-runner/src/ipc-mcp-stdio.ts.
    //
    // x_bookmarks is opened because: (a) it returns user-curated content the
    // user already saved, (b) the authenticated Chrome session lives host-side
    // and is never exposed to the container.
    //
    // DO NOT generalize this pattern to imessage_*, apple_notes_*, or gmail_*
    // read tools — those expose third-party PII (other people's messages,
    // notes shared with the user, emails) and need per-tool review.
    const X_NON_MAIN_TYPES = new Set(['x_bookmarks']);
    if (!X_NON_MAIN_TYPES.has(type) && !isMain) {
        logger.warn({ sourceGroup, type }, 'X integration blocked: tool is main-only');
        return true;
    }
    const requestId = data.requestId;
    if (!requestId) {
        logger.warn({ type }, 'X integration blocked: missing requestId');
        return true;
    }
    logger.info({ type, requestId }, 'Processing X request');
    let result;
    switch (type) {
        case 'x_post':
            if (!data.content) {
                result = { success: false, message: 'Missing content' };
                break;
            }
            result = await runScript('post', { content: data.content });
            break;
        case 'x_like':
            if (!data.tweetUrl) {
                result = { success: false, message: 'Missing tweetUrl' };
                break;
            }
            result = await runScript('like', { tweetUrl: data.tweetUrl });
            break;
        case 'x_reply':
            if (!data.tweetUrl || !data.content) {
                result = { success: false, message: 'Missing tweetUrl or content' };
                break;
            }
            result = await runScript('reply', { tweetUrl: data.tweetUrl, content: data.content });
            break;
        case 'x_retweet':
            if (!data.tweetUrl) {
                result = { success: false, message: 'Missing tweetUrl' };
                break;
            }
            result = await runScript('retweet', { tweetUrl: data.tweetUrl });
            break;
        case 'x_quote':
            if (!data.tweetUrl || !data.comment) {
                result = { success: false, message: 'Missing tweetUrl or comment' };
                break;
            }
            result = await runScript('quote', { tweetUrl: data.tweetUrl, comment: data.comment });
            break;
        case 'x_bookmarks':
            result = await runScript('bookmarks', {
                limit: data.limit ?? 50,
                sinceId: data.sinceId,
            });
            break;
        default:
            return false;
    }
    writeResult(dataDir, sourceGroup, requestId, result);
    if (result.success) {
        logger.info({ type, requestId }, 'X request completed');
    }
    else {
        logger.error({ type, requestId, message: result.message }, 'X request failed');
    }
    return true;
}
//# sourceMappingURL=host.js.map