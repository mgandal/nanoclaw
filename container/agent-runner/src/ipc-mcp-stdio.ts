/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const BUS_QUEUE_PATH = path.join(IPC_DIR, 'bus-queue.json');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}


const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: MUST use 5-field format (min hour dom mon dow). Examples: "0 9 * * *" (daily 9am), "0 */3 * * *" (every 3 hours), "0 9 * * 1" (Mondays 9am). Do NOT use 6-field format. Minimum interval: 30 minutes.
\u2022 interval: Milliseconds between runs (e.g., "3600000" for 1 hour). Minimum: 1800000 (30 min).
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.
WARNING: Each task run spawns a full agent container and costs tokens. Always verify the schedule preview in the response.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: 5-field "min hour dom mon dow" like "0 9 * * *" (daily 9am) or "0 */3 * * *" (every 3h). interval: ms like "3600000" (1h). once: local time "2026-02-01T15:30:00" (no Z). Min interval: 30min.'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    const MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum
    let schedulePreview = '';

    if (args.schedule_type === 'cron') {
      let interval;
      try {
        interval = CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use 5-field format: "min hour dom mon dow" (e.g., "0 9 * * *" for daily 9am, "0 */3 * * *" for every 3 hours). Do NOT use 6-field format with seconds.` }],
          isError: true,
        };
      }

      // Compute next 3 fire times and check minimum interval
      const fireTimes: Date[] = [];
      for (let i = 0; i < 3; i++) {
        fireTimes.push(interval.next().toDate());
      }
      const gapMs = fireTimes[1].getTime() - fireTimes[0].getTime();
      const gapMinutes = Math.round(gapMs / 60000);

      if (gapMs < MIN_INTERVAL_MS) {
        return {
          content: [{ type: 'text' as const, text: `REJECTED: Cron "${args.schedule_value}" fires every ${gapMinutes} minute(s). Minimum allowed interval is 30 minutes. Each run costs tokens (spawns a full agent container). If you meant every ${gapMinutes} hours, use 5-field cron: "0 */${gapMinutes} * * *". Next 3 would-be fire times: ${fireTimes.map(d => d.toLocaleString()).join(', ')}` }],
          isError: true,
        };
      }

      schedulePreview = `\n\nSchedule preview (next 3 runs):\n${fireTimes.map((d, i) => `  ${i + 1}. ${d.toLocaleString()}`).join('\n')}\nInterval between runs: ~${gapMinutes} minutes (${(gapMinutes / 60).toFixed(1)} hours)`;

    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "3600000" for 1 hour).` }],
          isError: true,
        };
      }
      if (ms < MIN_INTERVAL_MS) {
        return {
          content: [{ type: 'text' as const, text: `REJECTED: Interval ${ms}ms (${Math.round(ms / 60000)} minutes) is too frequent. Minimum allowed is 30 minutes (1800000ms). Each run costs tokens.` }],
          isError: true,
        };
      }
      const hours = (ms / 3600000).toFixed(1);
      schedulePreview = `\n\nInterval: every ${hours} hours (${ms}ms)`;

    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      schedulePreview = `\n\nWill run once at: ${date.toLocaleString()}`;
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled (${args.schedule_type}: ${args.schedule_value}).${schedulePreview}\n\nIMPORTANT: Verify the schedule preview above looks correct. Each run spawns a full agent container and costs tokens.` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Browser Automation Tools ---
// General-purpose browser control via host-side Playwright.
// Uses same IPC pattern: write task file, poll for result.

const BROWSER_RESULTS_DIR = path.join(IPC_DIR, 'browser_results');
const DASHBOARD_RESULTS_DIR = path.join(IPC_DIR, 'dashboard_results');

async function waitForIpcResult(
  resultsDir: string,
  requestId: string,
  maxWait = 120000,
): Promise<Record<string, unknown>> {
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read result' };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Request timed out' };
}

async function waitForBrowserResult(
  requestId: string,
  maxWait = 120000,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  return waitForIpcResult(BROWSER_RESULTS_DIR, requestId, maxWait) as Promise<{
    success: boolean;
    message: string;
    data?: unknown;
  }>;
}

server.tool(
  'query_dashboard',
  'Query NanoClaw system status. Returns task summaries, run logs, group info, skill counts, or state file freshness from the host.',
  {
    queryType: z
      .enum([
        'task_summary',
        'run_logs_24h',
        'run_logs_7d',
        'group_summary',
        'skill_inventory',
        'state_freshness',
      ])
      .describe('The type of dashboard data to query'),
  },
  async (args) => {
    const requestId = `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'dashboard_query',
      requestId,
      queryType: args.queryType,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForIpcResult(DASHBOARD_RESULTS_DIR, requestId, 30000);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: !(result as { success?: boolean }).success,
    };
  },
);

if (isMain) {
  server.tool(
    'browser_navigate',
    `Navigate to a URL and return the page title and readable text content. Use this to read web pages, check websites, or start a browsing session. The browser runs on the host with a real Chrome profile, so it can access sites that require login if the user has previously authenticated.`,
    { url: z.string().describe('The URL to navigate to') },
    async (args) => {
      const requestId = `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'browser_navigate', requestId, url: args.url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForBrowserResult(requestId);
      let text = result.message;
      if (result.data && typeof result.data === 'object') {
        const d = result.data as Record<string, unknown>;
        text = `${result.message}\n\nTitle: ${d.title}\nURL: ${d.url}\n\n${d.text}`;
      }
      return { content: [{ type: 'text' as const, text }], isError: !result.success };
    },
  );

  server.tool(
    'browser_click',
    `Click an element on a web page by CSS selector. Optionally navigate to a URL first. Returns the page state after clicking.`,
    {
      selector: z.string().describe('CSS selector of the element to click (e.g., "button.submit", "#login-btn", "a[href*=next]")'),
      url: z.string().optional().describe('URL to navigate to before clicking (omit to click on current page)'),
    },
    async (args) => {
      const requestId = `click-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'browser_click', requestId, selector: args.selector, url: args.url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForBrowserResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'browser_fill',
    `Fill form fields on a web page and optionally submit. Each field is specified by CSS selector and value. Useful for login forms, search boxes, contact forms, etc.`,
    {
      fields: z.array(z.object({
        selector: z.string().describe('CSS selector of the input field'),
        value: z.string().describe('Value to fill in'),
      })).describe('Array of {selector, value} pairs to fill'),
      submit_selector: z.string().optional().describe('CSS selector of the submit button to click after filling'),
      url: z.string().optional().describe('URL to navigate to before filling'),
    },
    async (args) => {
      const requestId = `fill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'browser_fill', requestId, fields: args.fields, submit_selector: args.submit_selector, url: args.url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForBrowserResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'browser_extract',
    `Extract structured content from a web page. Can extract: text (readable content), links (all hrefs), tables (structured data), or html (raw markup). Optionally scope extraction to a CSS selector.`,
    {
      extract_type: z.enum(['text', 'links', 'tables', 'html']).describe('What to extract: text=readable content, links=all hrefs, tables=structured data, html=raw markup'),
      selector: z.string().optional().describe('CSS selector to scope extraction (default: entire page)'),
      url: z.string().optional().describe('URL to navigate to before extracting'),
    },
    async (args) => {
      const requestId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'browser_extract', requestId, extract_type: args.extract_type, selector: args.selector, url: args.url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForBrowserResult(requestId);
      let text = result.message;
      if (result.data && typeof result.data === 'object' && 'content' in result.data) {
        const content = (result.data as { content: unknown }).content;
        text += '\n\n' + (typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      }
      return { content: [{ type: 'text' as const, text }], isError: !result.success };
    },
  );

  server.tool(
    'browser_screenshot',
    `Take a screenshot of a web page or specific element. Returns a base64-encoded PNG. Useful for visual verification or capturing dynamic content.`,
    {
      url: z.string().optional().describe('URL to navigate to before taking screenshot'),
      selector: z.string().optional().describe('CSS selector to screenshot (default: full viewport)'),
      full_page: z.boolean().optional().describe('Capture the full scrollable page (default: viewport only)'),
    },
    async (args) => {
      const requestId = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'browser_screenshot', requestId, url: args.url, selector: args.selector, full_page: args.full_page, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForBrowserResult(requestId);
      if (result.success && result.data && typeof result.data === 'object' && 'screenshot_base64' in result.data) {
        return {
          content: [
            { type: 'text' as const, text: result.message },
            { type: 'image' as const, data: (result.data as { screenshot_base64: string }).screenshot_base64, mimeType: 'image/png' },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );
}

// --- X (Twitter) Integration Tools ---
// These tools communicate with the host via IPC task files.
// The host runs browser automation scripts to interact with X.

const X_RESULTS_DIR = path.join(IPC_DIR, 'x_results');

async function waitForXResult(requestId: string, maxWait = 120000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(X_RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read result' };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Request timed out' };
}

if (isMain) {
  server.tool(
    'x_post',
    'Post a tweet to X (Twitter). Main group only. Content max 280 characters.',
    { content: z.string().max(280).describe('The tweet content to post') },
    async (args) => {
      const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_post', requestId, content: args.content, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_like',
    'Like a tweet on X (Twitter). Main group only.',
    { tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123)') },
    async (args) => {
      const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_like', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_reply',
    'Reply to a tweet on X (Twitter). Main group only.',
    {
      tweet_url: z.string().describe('The tweet URL'),
      content: z.string().max(280).describe('The reply content'),
    },
    async (args) => {
      const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_reply', requestId, tweetUrl: args.tweet_url, content: args.content, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet on X (Twitter). Main group only.',
    { tweet_url: z.string().describe('The tweet URL') },
    async (args) => {
      const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_retweet', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_quote',
    'Quote tweet on X (Twitter) with your own comment. Main group only.',
    {
      tweet_url: z.string().describe('The tweet URL'),
      comment: z.string().max(280).describe('Your comment for the quote tweet'),
    },
    async (args) => {
      const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_quote', requestId, tweetUrl: args.tweet_url, comment: args.comment, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );
}

// --- iMessage Tools ---
// Read/search/send iMessages via host-side SQLite + AppleScript.
// Uses same IPC pattern: write task file, poll for result.

const IMESSAGE_RESULTS_DIR = path.join(IPC_DIR, 'imessage_results');

async function waitForImessageResult(requestId: string, maxWait = 30000): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultFile = path.join(IMESSAGE_RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read result' };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Request timed out' };
}

if (isMain) {
  server.tool(
    'imessage_search',
    `Search iMessages by keyword, contact, or date range. Returns matching messages with sender info and timestamps.`,
    {
      query: z.string().optional().describe('Text to search for in message content'),
      contact: z.string().optional().describe('Filter by contact phone number or email (partial match, e.g. "+1703" or "john@")'),
      since_days: z.number().optional().describe('Search messages from the last N days (default: 30)'),
      limit: z.number().optional().describe('Maximum results to return (default: 50, max: 200)'),
    },
    async (args) => {
      const requestId = `imsearch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'imessage_search',
        requestId,
        query: args.query,
        contact: args.contact,
        since_days: args.since_days,
        limit: args.limit,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForImessageResult(requestId);
      let text = result.message;
      if (result.data && Array.isArray(result.data)) {
        text += '\n\n' + result.data
          .map((m: { timestamp: string; contact: string; is_from_me: boolean; text: string }) =>
            `[${m.timestamp}] ${m.is_from_me ? 'Me' : m.contact}: ${m.text}`)
          .join('\n');
      }
      return { content: [{ type: 'text' as const, text }], isError: !result.success };
    },
  );

  server.tool(
    'imessage_read',
    `Read a conversation thread with a specific contact. Returns messages in chronological order.`,
    {
      contact: z.string().describe('Contact phone number or email (partial match)'),
      limit: z.number().optional().describe('Maximum messages to return (default: 50, max: 200)'),
      since_days: z.number().optional().describe('Read messages from the last N days (default: 7)'),
    },
    async (args) => {
      const requestId = `imread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'imessage_read',
        requestId,
        contact: args.contact,
        limit: args.limit,
        since_days: args.since_days,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForImessageResult(requestId);
      let text = result.message;
      if (result.data && typeof result.data === 'object' && 'messages' in result.data) {
        const conv = result.data as { contact: string; messages: Array<{ timestamp: string; is_from_me: boolean; text: string }> };
        text += `\n\nConversation with ${conv.contact}:\n` +
          conv.messages
            .map(m => `[${m.timestamp}] ${m.is_from_me ? 'Me' : conv.contact}: ${m.text}`)
            .join('\n');
      }
      return { content: [{ type: 'text' as const, text }], isError: !result.success };
    },
  );

  server.tool(
    'imessage_send',
    `Send an iMessage to a contact. Requires a valid phone number or Apple ID email.`,
    {
      to: z.string().describe('Recipient phone number (e.g. "+17035551234") or Apple ID email'),
      text: z.string().describe('Message text to send'),
    },
    async (args) => {
      const requestId = `imsend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'imessage_send',
        requestId,
        to: args.to,
        text: args.text,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForImessageResult(requestId, 30000);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'imessage_list_contacts',
    `List recent iMessage contacts with message counts. Useful for finding phone numbers or seeing who you've been chatting with.`,
    {
      since_days: z.number().optional().describe('Look back N days (default: 30)'),
      limit: z.number().optional().describe('Maximum contacts to return (default: 30, max: 100)'),
    },
    async (args) => {
      const requestId = `imcontacts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'imessage_list_contacts',
        requestId,
        since_days: args.since_days,
        limit: args.limit,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForImessageResult(requestId);
      let text = result.message;
      if (result.data && Array.isArray(result.data)) {
        text += '\n\n' + result.data
          .map((c: { contact: string; message_count: number; last_message: string }) =>
            `${c.contact}: ${c.message_count} messages (last: ${c.last_message})`)
          .join('\n');
      }
      return { content: [{ type: 'text' as const, text }], isError: !result.success };
    },
  );
}

// bus_publish — post a finding to the inter-agent message bus
server.tool(
  'bus_publish',
  'Publish a finding or status update to the inter-agent message bus. Other agents subscribed to the topic will see it on their next invocation.',
  {
    topic: z.string().describe('Topic: research, scheduling, lab-ops, personal, or custom'),
    finding: z.string().describe('What you found or want to communicate'),
    action_needed: z.string().optional().describe('Group folder that should act on this (e.g., "telegram_science-claw")'),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
  },
  async (args) => {
    const data = {
      type: 'bus_publish',
      from: groupFolder,
      topic: args.topic,
      finding: args.finding,
      action_needed: args.action_needed,
      priority: args.priority,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Published to bus: [${args.topic}] ${args.finding.slice(0, 80)}...` }],
    };
  },
);

// bus_read — read pending items from the message bus
server.tool(
  'bus_read',
  'Read pending messages from other agents. Items are loaded at container start from the bus queue.',
  {
    topic: z.string().optional().describe('Filter by topic (optional)'),
  },
  async (args) => {
    if (!fs.existsSync(BUS_QUEUE_PATH)) {
      return { content: [{ type: 'text' as const, text: 'No pending bus messages.' }] };
    }
    try {
      const queue = JSON.parse(fs.readFileSync(BUS_QUEUE_PATH, 'utf-8'));
      const filtered = args.topic
        ? queue.filter((m: { topic: string }) => m.topic === args.topic)
        : queue;
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No pending bus messages.' }] };
      }
      const formatted = filtered
        .map((m: { from: string; topic: string; finding: string; priority: string }) =>
          `[${m.priority || 'medium'}] From ${m.from} (${m.topic}): ${m.finding}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Pending bus messages:\n${formatted}` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Error reading bus queue.' }] };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
