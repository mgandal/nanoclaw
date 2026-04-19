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
  `Send a plain-text message to the current user or group immediately while you are still running.

Use when:
- You want to send progress updates, partial answers, or multiple messages in one turn.
- You need a dedicated persona (sender parameter) to appear as the speaker in Telegram.

Do not use for:
- Sending files (use send_file).
- Sending a tappable WebApp button (use send_webapp_button).
- Sending to an arbitrary Slack user (use slack_dm).

Returns: "Message sent." on success. No failure case — messages are written to the host IPC queue and delivered asynchronously.`,
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
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
  'send_file',
  `Send a file (PDF, image, document, binary) to the current user or group.

Use when:
- Sharing a generated report, research paper, or any file the user should download.
- The payload is too large or non-text for send_message.

Inputs:
- file_path: absolute path inside the container. Typical roots are /workspace/group/ for per-group outputs and /workspace/extra/ for vault files. Relative paths will be rejected.
- caption: optional text sent alongside the file.

Returns: "File sent: <basename>" on success; error object with "File not found: <path>" if the path does not exist at call time.`,
  {
    file_path: z.string().describe('Absolute path to the file inside the container (e.g., /workspace/group/report.pdf)'),
    caption: z.string().optional().describe('Optional caption/message to send with the file'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return { content: [{ type: 'text' as const, text: `Error: File not found: ${args.file_path}` }], isError: true };
    }

    writeIpcFile(MESSAGES_DIR, {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `File sent: ${path.basename(args.file_path)}` }] };
  },
);

server.tool(
  'publish_to_bus',
  `Send a DIRECTED message to a specific named agent via the coordination bus.

Use when:
- You want one named specialist (e.g., "einstein", "marvin") to act on a task.
- The receiving agent needs structured payload data, not just a human-readable string.

Prefer bus_publish instead when:
- You want ANY subscribed agent on a topic to see the finding (broadcast, not directed).
- You are posting a status update rather than requesting an action.

Inputs:
- to_agent: target agent name (required). Matches a folder under data/agents/.
- to_group: target group folder, defaults to the current group.
- topic: string category for the receiving agent to route on.
- priority: low | medium | high (default medium).
- summary: short human-readable description of what is needed.
- payload: optional structured data object for the receiving agent.

Returns: "Bus message published to <agent>: <summary>" on success. Delivery is asynchronous; the caller does not get a reply.`,
  {
    to_agent: z.string().describe('Target agent name (e.g., "jennifer", "einstein")'),
    to_group: z.string().optional().describe('Target group folder (defaults to current group)'),
    topic: z.string().describe('Message topic for categorization'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('Message priority (default: medium)'),
    summary: z.string().describe('Brief description of what is needed'),
    payload: z.record(z.unknown()).optional().describe('Structured data for the receiving agent'),
  },
  async (args) => {
    const data = {
      type: 'publish_to_bus',
      chatJid,
      groupFolder,
      from: groupFolder,
      to_agent: args.to_agent,
      to_group: args.to_group || groupFolder,
      topic: args.topic,
      priority: args.priority || 'medium',
      summary: args.summary,
      payload: args.payload || {},
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Bus message published to ${args.to_agent}: ${args.summary}` }],
    };
  },
);

server.tool(
  'write_agent_state',
  `Replace or append your per-group working memory file (groups/{current}/state.md).

Use when:
- You need to persist GROUP-SCOPED working state: current task progress, open questions for this group only, notes that do not apply in other groups.

Prefer write_agent_memory instead when:
- The fact is AGENT-SCOPED: identity, standing instructions, cross-group decisions, anything that should travel with you into other groups.
- You only want to update one section; write_agent_memory patches by section header, whereas this tool rewrites or appends the whole file.

Inputs:
- content: full markdown content (full-file replace by default).
- append: if true, append to the existing file instead of replacing.

Returns: "Agent state update queued." The host serializes writes to prevent corruption; the write completes asynchronously.`,
  {
    content: z.string().describe('Full markdown content for state.md'),
    append: z.boolean().optional().describe('If true, append instead of replace (default: false)'),
  },
  async (args) => {
    const data = {
      type: 'write_agent_state',
      chatJid,
      groupFolder,
      content: args.content,
      append: args.append || false,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: 'Agent state update queued.' }],
    };
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
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: 5-field "min hour dom mon dow" like "0 9 * * *" (daily 9am) or "0 */3 * * *" (every 3h). interval: ms like "3600000" (1h). once: local time "2026-02-01T15:30:00" (no Z). Min interval: 30min.',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
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
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use 5-field format: "min hour dom mon dow" (e.g., "0 9 * * *" for daily 9am, "0 */3 * * *" for every 3 hours). Do NOT use 6-field format with seconds.`,
            },
          ],
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
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "3600000" for 1 hour).`,
            },
          ],
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
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      schedulePreview = `\n\nWill run once at: ${date.toLocaleString()}`;
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled (${args.schedule_type}: ${args.schedule_value}).${schedulePreview}\n\nIMPORTANT: Verify the schedule preview above looks correct. Each run spawns a full agent container and costs tokens.`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  `List scheduled tasks visible to the current group.

Visibility:
- Main group: sees all tasks across all groups.
- Non-main group: sees only its own tasks.

Inputs: none.

Returns: newline-separated list, one task per line:
"- [<task_id>] <prompt first 50 chars>... (<schedule_type>: <schedule_value>) - <status>, next: <next_run>"
Returns "No scheduled tasks found." when the registry is empty.`,
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  `Pause a scheduled task. The task remains registered but will not fire until resume_task is called.

Use when: the user wants to temporarily stop a recurring task without losing its configuration.
Prefer cancel_task when the task should be deleted permanently.

Inputs: task_id (from schedule_task response or list_tasks).

Returns: "Task <id> pause requested." Non-main groups can only pause their own tasks.`,
  { task_id: z.string().describe('The task ID to pause (format: task-<timestamp>-<random>)') },
  async (args) => {
    // Authority (isMain) is determined host-side from the IPC directory,
    // NOT from the payload. Do not include isMain here — a future handler
    // that accidentally reads it would create a confused-deputy bypass.
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  `Resume a task that was previously paused with pause_task.

Inputs: task_id.

Returns: "Task <id> resume requested." No-op if the task was already active; error semantics are handled host-side.`,
  { task_id: z.string().describe('The task ID to resume (format: task-<timestamp>-<random>)') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  `Delete a scheduled task permanently. Task is removed from the registry and cannot be resumed.

Use when the user wants to stop a task forever.
Prefer pause_task if the user may want to re-enable it later.

Inputs: task_id.

Returns: "Task <id> cancellation requested."`,
  { task_id: z.string().describe('The task ID to cancel (format: task-<timestamp>-<random>)') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  `Modify an existing scheduled task in place. Only the fields you provide are changed; omitted fields keep their current values.

Use when: the user asks to change the prompt, schedule, or script of a task that already exists. Preserves task_id and history.
Prefer cancel_task + schedule_task when: the change is so large (e.g. different context_mode, different target group) that tracking continuity adds no value.

Schedule validation: same minimum-interval rules as schedule_task (30-minute floor for cron and interval; invalid values are rejected with an explanatory error). Pass script="" to clear an existing script.

Returns: "Task <id> update requested." Validation errors are returned immediately; the update itself is asynchronous.`,
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    const MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
      if (ms < MIN_INTERVAL_MS) {
        return {
          content: [{ type: 'text' as const, text: `REJECTED: Interval ${ms}ms (${Math.round(ms / 60000)} minutes) is too frequent. Minimum allowed is 30 minutes (1800000ms).` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent will respond to messages there. Main group only — returns an error if called from a non-main group.

Use available_groups.json (readable from the agent's workspace) to find the JID.

Folder-naming rule (strict):
- Format: "{channel}_{group-name}" — e.g. "whatsapp_family-chat", "telegram_dev-team", "discord_general", "slack_general".
- channel prefix: lowercase, matches an installed channel skill.
- group-name: lowercase, hyphens only (no spaces, no underscores).

Inputs:
- jid: chat JID (e.g. "120363336345536173@g.us" for WhatsApp, "tg:-1001234567890" for Telegram, "dc:1234..." for Discord).
- name: display name for humans.
- folder: see folder-naming rule above.
- trigger: trigger phrase (e.g. "@Andy").
- requiresTrigger: if true, messages must start with the trigger. Defaults to false (respond to all). Set true for busy groups.

Returns: "Group <name> registered. It will start receiving messages immediately." on success; error object if called from non-main.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// --- Browser Automation Tools ---
// General-purpose browser control via host-side Playwright.
// Uses same IPC pattern: write task file, poll for result.

const BROWSER_RESULTS_DIR = path.join(IPC_DIR, 'browser_results');
const DASHBOARD_RESULTS_DIR = path.join(IPC_DIR, 'dashboard_results');
const SKILL_RESULTS_DIR = path.join(IPC_DIR, 'skill_results');
const KG_RESULTS_DIR = path.join(IPC_DIR, 'kg_results');

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
  `Query NanoClaw host state for introspection — useful when the user asks about system health or you need to reason about recent activity.

Inputs:
- queryType: one of
  - task_summary: counts + next fire times for all scheduled tasks.
  - run_logs_24h / run_logs_7d: recent task execution history.
  - group_summary: registered groups with trigger settings + folder paths.
  - skill_inventory: installed container skills.
  - state_freshness: last-modified timestamps of state files (current.md, goals.md, etc.).

Returns: JSON string with {success, data} shape. Times out at 30s; on timeout returns {success:false, message:"Request timed out"}.`,
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
      .describe('Dashboard data category — see tool description for each option.'),
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

// --- Knowledge Graph query tool ---
// Traverse the entity-relationship graph produced by scripts/kg/ingest_phase1.py.
// Use for questions about *connections* (who is affiliated with X, what papers
// cite Y, which projects a grant funds). For full-text / semantic search across
// document content, use the qmd tool instead — the KG indexes relationships,
// not prose.
server.tool(
  'kg_query',
  [
    'Query the knowledge graph for entities and their relationships.',
    '',
    'Use when: the question is about CONNECTIONS — "who collaborates with X", "what papers cite Y", "which projects does grant Z fund".',
    'Prefer qmd instead when: the question is about CONTENT — full-text or semantic search across document prose. The KG indexes structured relationships, not text.',
    '',
    'Returns matched entities (by canonical name or alias), their neighbors out to `hops`, and the edges connecting them. 30s timeout.',
    'Entity types: person, paper, dataset, tool, grant, project, method, institution, disorder.',
    'Common relations: authored, collaborates_with, member_of, funds_project, cites, uses_method, related_to.',
  ].join('\n'),
  {
    query: z
      .string()
      .describe(
        'Text to search against entity canonical names and aliases. E.g. "Rachel Smith", "R01-MH137578", "BrainGO".',
      ),
    entity_type: z
      .string()
      .optional()
      .describe('Restrict matches to this type (person/paper/dataset/tool/grant/project).'),
    relation_type: z
      .string()
      .optional()
      .describe(
        'Only traverse edges with this relation (e.g. "authored", "funds_project").',
      ),
    hops: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe(
        'Traversal depth. 0 = matched entities only, 1 = direct neighbors (default), 2-3 = further hops.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Max matched entities before expanding neighbors (default 20).'),
  },
  async (args) => {
    const requestId = `kg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'kg_query',
      requestId,
      query: args.query,
      entity_type: args.entity_type,
      relation_type: args.relation_type,
      hops: args.hops,
      limit: args.limit,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForIpcResult(KG_RESULTS_DIR, requestId, 30000);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: !(result as { success?: boolean }).success,
    };
  },
);

if (isMain) {
  server.tool(
    'browser_navigate',
    `Open a URL in the host's real Chrome profile and return the page title + readable text. Main group only.

Use when: you need to read a website the user has already authenticated to (Gmail, Slack, internal dashboards), or start a browsing session for browser_click / browser_fill.
Do not use for: plain public URLs where a simple fetch would suffice — this tool spins up a full Chrome tab on the host.

Inputs:
- url: full URL including scheme (http:// or https://).

Returns: "Title: <title>\\nURL: <url>\\n\\n<readable text>" on success. 2-minute timeout; on timeout returns an error.`,
    { url: z.string().describe('Full URL including scheme — e.g. https://example.com') },
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
    `Click an element on a web page by CSS selector. Main group only.

Use when: you need to press a button, follow a link, or activate a tab on a page the user has already authenticated to.
Typical sequence: browser_navigate first (or pass url here), then browser_click, then browser_extract or browser_screenshot to read the result.

Inputs:
- selector: CSS selector (e.g. "button.submit", "#login-btn", "a[href*=next]").
- url: optional — navigate here first, otherwise click on the current page.

Returns: short status message describing the click outcome. 2-minute timeout.`,
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
    `Fill one or more form fields by CSS selector, and optionally click a submit button. Main group only.

Use when: interacting with a login form, search box, survey, or any multi-field form.

Inputs:
- fields: array of {selector, value} pairs. All fields are filled before submit.
- submit_selector: optional — CSS selector of a button to click after filling.
- url: optional — navigate here first.

Returns: status message describing the fill + optional submit outcome. 2-minute timeout.`,
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
    `Extract a specific kind of content from a web page — text, links, tables, or raw HTML. Main group only.

Use when: browser_navigate gave you text but you need a different representation (just the links, just the tables, or the raw markup).

Inputs:
- extract_type: "text" (readable), "links" (all hrefs), "tables" (structured data), or "html" (raw).
- selector: optional CSS scope (default: whole page).
- url: optional — navigate here first.

Returns: status message + extracted content. For tables the content is JSON; for the others it is a string. 2-minute timeout.`,
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
    `Capture a PNG screenshot of the current page, a specific element, or the full scrollable page. Main group only.

Use when: you need visual confirmation (the extracted text is ambiguous) or the content is canvas / image-based and can't be read as text.

Inputs:
- url: optional — navigate here first.
- selector: optional CSS scope (default: viewport).
- full_page: if true, capture the entire scrollable page, not just the viewport.

Returns: status message + base64-encoded PNG as an image content block. 2-minute timeout.`,
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

async function waitForXResult(requestId: string, maxWait = 120000): Promise<{ success: boolean; message: string; data?: unknown }> {
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
    `Publish a new tweet to X (Twitter) from the user's account. Main group only.

Inputs: content (1-280 chars).
Returns: host message indicating success (URL of posted tweet) or failure reason. 2-minute timeout.`,
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
    `Like an existing tweet on X. Main group only.

Inputs: tweet_url (e.g. https://x.com/user/status/123).
Returns: host message confirming the like or reporting the failure. 2-minute timeout.`,
    { tweet_url: z.string().describe('Full tweet URL — https://x.com/<user>/status/<id>') },
    async (args) => {
      const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_like', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_reply',
    `Reply to an existing tweet on X. Main group only.

Use x_quote instead if you want your comment to appear above the original (quote tweet) rather than in the reply thread.

Inputs: tweet_url, content (1-280 chars).
Returns: host message confirming the reply (URL) or reporting failure. 2-minute timeout.`,
    {
      tweet_url: z.string().describe('Full tweet URL to reply to — https://x.com/<user>/status/<id>'),
      content: z.string().max(280).describe('Reply text (1-280 chars)'),
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
    `Retweet an existing tweet on X (plain RT, no added comment). Main group only.

Use x_quote instead when you want to add your own commentary.

Inputs: tweet_url.
Returns: host message confirming the RT or reporting failure. 2-minute timeout.`,
    { tweet_url: z.string().describe('Full tweet URL to retweet — https://x.com/<user>/status/<id>') },
    async (args) => {
      const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_retweet', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_quote',
    `Quote-tweet: post your own comment WITH the original tweet embedded below. Main group only.

Use x_reply instead when replying in-thread without embedding.
Use x_retweet instead for a plain RT with no added commentary.

Inputs: tweet_url, comment (1-280 chars).
Returns: host message confirming the quote (URL) or reporting failure. 2-minute timeout.`,
    {
      tweet_url: z.string().describe('Full tweet URL to quote — https://x.com/<user>/status/<id>'),
      comment: z.string().max(280).describe('Your comment (1-280 chars) — appears above the embedded original'),
    },
    async (args) => {
      const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_quote', requestId, tweetUrl: args.tweet_url, comment: args.comment, groupFolder, timestamp: new Date().toISOString() });
      const result = await waitForXResult(requestId);
      return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
    },
  );

  server.tool(
    'x_bookmarks',
    `Fetch the user's recent X bookmarks. Main group only.

Inputs:
- limit: max tweets to return (default 50).
- since_id: stop at this tweet ID (for incremental sync — pass the most recent ID seen last time).

Returns: JSON array of bookmarked tweets, each with author, text, URL, and tweet ID. 3-minute timeout.`,
    {
      limit: z.number().default(50).describe('Max bookmarks to fetch (default 50)'),
      since_id: z.string().optional().describe('Stop at this tweet ID (for incremental sync)'),
    },
    async (args) => {
      const requestId = `xbookmarks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'x_bookmarks',
        requestId,
        limit: args.limit,
        sinceId: args.since_id,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForXResult(requestId, 180000);
      return {
        content: [{ type: 'text' as const, text: typeof result.data === 'object' ? JSON.stringify(result.data) : result.message }],
        isError: !result.success,
      };
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
    `Search the user's iMessages by any combination of keyword, contact, and date range. Main group only.

Use when: the user asks to find a specific message or thread by content or sender.
Prefer imessage_read when: the user wants the recent conversation with a specific contact — it's chronological and includes both sides.
Prefer imessage_list_contacts when: the user doesn't know the phone number or email and needs to look it up.

Inputs:
- query: substring match on message text (optional).
- contact: partial match on phone or email (e.g. "+1703" matches any +1 703 number; "john@" matches any john@… address).
- since_days: limit to last N days (default 30).
- limit: max results (default 50, max 200).

Returns: lines of "[<timestamp>] Me|<contact>: <text>" for matching messages. 30-second timeout.`,
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
    `Read the recent iMessage conversation with a specific contact, in chronological order. Main group only.

Use when: the user wants to catch up on a thread ("what did Alice say yesterday?").
Prefer imessage_search when: looking for a message by keyword across multiple contacts.

Inputs:
- contact: phone number or email — partial match is supported (e.g. "+1703" or "john@").
- since_days: how far back to look (default 7).
- limit: max messages returned (default 50, max 200).

Returns: "Conversation with <contact>:" header followed by lines "[<timestamp>] Me|<contact>: <text>". 30-second timeout.`,
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
    `Send an iMessage from the user's Mac to a contact. Main group only.

Inputs:
- to: EXACT recipient — unlike imessage_read/search, partial matches are not allowed. Use full phone with country code (e.g. "+17035551234") or a valid Apple ID email.
- text: message body.

Returns: host message confirming send or reporting failure. 30-second timeout.`,
    {
      to: z.string().describe('Full recipient phone ("+17035551234") or Apple ID email — no partial matching'),
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
    `List recent iMessage contacts with message counts and most-recent-message timestamps. Main group only.

Use when: the user asks who they've been talking to, or you need to look up a phone number / email before calling imessage_send.

Inputs:
- since_days: look-back window (default 30).
- limit: max contacts (default 30, max 100).

Returns: lines of "<contact>: <count> messages (last: <timestamp>)". 30-second timeout.`,
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

// --- Slack DM Tool ---
// Send a Slack direct message via the host bridge (port 19876).

const SLACK_RESULTS_DIR = path.join(IPC_DIR, 'slack_results');

// Available to all groups — trust enforcement is handled host-side in ipc.ts
server.tool(
    'slack_dm',
    `Send a Slack DM to a specific user. Trust-gated: your agent must have send_slack_dm permission in trust.yaml.

Use when: the user asks you to DM a colleague on Slack.
Prefer send_message when: the message should go to the current Telegram chat.

Inputs:
- EXACTLY ONE of user_id OR user_email (providing neither returns an error).
- text: message body.

Returns: host message from the Slack bridge — either the posted message ts on success, or a reason-for-failure string. 30-second timeout.`,
    {
      user_id: z.string().optional().describe('Slack user ID like "U01ABC123" — provide this OR user_email, not both.'),
      user_email: z.string().optional().describe('User email for Slack lookup — provide this OR user_id, not both.'),
      text: z.string().describe('Message text to send'),
    },
    async (args) => {
      if (!args.user_id && !args.user_email) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Provide either user_id or user_email' }],
          isError: true,
        };
      }
      const requestId = `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'slack_dm',
        requestId,
        user_id: args.user_id,
        user_email: args.user_email,
        text: args.text,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForIpcResult(SLACK_RESULTS_DIR, requestId, 30000);
      return {
        content: [{ type: 'text' as const, text: result.message as string || JSON.stringify(result) }],
        isError: !(result as { success?: boolean }).success,
      };
    },
  );

// --- Slack DM Read Tool ---
// Read Slack DM conversation history via the host bridge (port 19876).

// Available to all groups — trust enforcement is handled host-side in ipc.ts
server.tool(
    'slack_dm_read',
    `Read recent messages from a Slack DM. Trust-gated: your agent must have read_slack_dm permission in trust.yaml.

Note: requires the DM CHANNEL ID (starts with "D"), not a user ID. If you only have the user, you cannot look up their DM channel via this tool — ask the user for the channel ID.

Inputs:
- channel: Slack DM channel ID (format: "D" + 10 alphanumeric chars).
- limit: number of messages to return (default 10, max 50).

Returns: JSON of recent messages with author + timestamp + text. 30-second timeout.`,
    {
      channel: z.string().describe('Slack DM channel ID starting with "D" (e.g. "D0AQ09RSF1B")'),
      limit: z.number().optional().describe('Messages to retrieve (default 10, max 50)'),
    },
    async (args) => {
      const requestId = `slack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'slack_dm_read',
        requestId,
        channel: args.channel,
        limit: args.limit ?? 10,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const result = await waitForIpcResult(SLACK_RESULTS_DIR, requestId, 30000);
      return {
        content: [{ type: 'text' as const, text: result.message as string || JSON.stringify(result) }],
        isError: !(result as { success?: boolean }).success,
      };
    },
  );

// bus_publish — post a finding to the inter-agent message bus
server.tool(
  'bus_publish',
  `Broadcast a finding or status update to a TOPIC on the inter-agent bus. Any agent subscribed to that topic receives it on its next invocation.

Use when:
- You want to share a discovery with whoever cares ("posted for awareness, no specific recipient").
- The content is a status update or published knowledge, not an action request.

Prefer publish_to_bus instead when:
- You want a specific named agent to act. This tool is broadcast-by-topic; publish_to_bus is directed-by-name.

Inputs:
- topic: category — research, scheduling, lab-ops, personal, or a custom string.
- finding: the content to share.
- action_needed: optional group folder (e.g. "telegram_science-claw") that should act on this. Hint, not a hard route.
- priority: low | medium | high (default medium).

Returns: "Published to bus: [<topic>] <first 80 chars>..." — delivery is asynchronous.`,
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
  `Read pending bus messages queued for the current group by other agents. The queue is snapshot at container start; items added mid-session are not visible until the next invocation.

Inputs: topic (optional filter).

Returns: newline-separated lines "[<priority>] From <agent> (<topic>): <finding>". Returns "No pending bus messages." when empty.`,
  {
    topic: z.string().optional().describe('Filter to this topic only (optional)'),
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

// --- Telegram Mini App Tools ---
// Agents can deploy a self-contained HTML page to Vercel and send the user
// an inline button that opens it as a Telegram Mini App (WebApp).

const DEPLOY_RESULTS_DIR = path.join(IPC_DIR, 'deploy_results');

server.tool(
  'deploy_mini_app',
  `Deploy a self-contained HTML page to Vercel and return a public HTTPS URL. Pair with send_webapp_button to surface the URL as a tappable button in Telegram.

Constraints:
- HTML must be fully self-contained. Inline all CSS and JS. No import statements, no external build step, no bundled dependencies.
- External CDN <script src="..."> is fine (e.g. loading React from a CDN); a package.json or webpack config is not.

Inputs:
- appName: short slug, lowercase+digits+hyphens only, 1-50 chars. Used in the Vercel URL (e.g. "quiz" → quiz-abc123.vercel.app).
- html: complete index.html contents.

Returns: JSON {success, url?, message?} — on success, url is the HTTPS endpoint. 60-second timeout.`,
  {
    appName: z
      .string()
      .regex(/^[a-z0-9-]{1,50}$/)
      .describe(
        'Short lowercase name for the app (e.g. "quiz", "survey", "data-viewer"). Used in the Vercel deployment URL.',
      ),
    html: z
      .string()
      .min(1)
      .describe(
        'Complete HTML for index.html. Must be fully self-contained with inline CSS/JS. No external dependencies that require bundling.',
      ),
  },
  async (args) => {
    const requestId = `deploy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'deploy_mini_app',
      requestId,
      appName: args.appName,
      html: args.html,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    const result = await waitForIpcResult(DEPLOY_RESULTS_DIR, requestId, 60000);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: !(result as { success?: boolean }).success,
    };
  },
);

server.tool(
  'send_webapp_button',
  `Send a Telegram inline-keyboard button that opens a Mini App (WebApp) when tapped.

Typical flow: call deploy_mini_app first to get an HTTPS URL, then pass that URL here.

Inputs:
- label: button text, 1-64 chars.
- url: HTTPS URL of the deployed mini app (must be HTTPS; HTTP is rejected by Telegram).

Returns: "WebApp button sent: <label> → <url>". Fires asynchronously; no failure path.`,
  {
    label: z
      .string()
      .min(1)
      .max(64)
      .describe('Button text shown to the user (e.g. "Open Quiz", "View Results")'),
    url: z
      .string()
      .url()
      .describe('HTTPS URL of the deployed mini app (from deploy_mini_app)'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid,
      text: args.label,
      webAppUrl: args.url,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `WebApp button sent: "${args.label}" → ${args.url}`,
        },
      ],
    };
  },
);

// knowledge_publish — publish a structured finding to the shared knowledge base
server.tool(
  'knowledge_publish',
  `Publish a structured finding to the shared cross-group knowledge base. Indexed by QMD so other agents can discover it via semantic search.

Use when: you discover a durable, reusable fact (regulation change, new paper, workflow decision) that future sessions — yours or other agents — should be able to retrieve.
Prefer bus_publish when: the finding is time-sensitive and should trigger immediate awareness rather than live in the searchable index.
Prefer write_agent_memory when: the fact is personal to you (an agent) rather than useful to everyone.

Inputs:
- topic: short category (e.g. "APA regulation", "lab scheduling").
- finding: clear, specific, actionable statement.
- evidence: source — DOI, URL, or conversation reference.
- tags: array of tags for QMD retrieval.

Returns: "Published knowledge: <topic>". Indexing happens asynchronously; retrieval via qmd or knowledge_search may lag by one ingest cycle.`,
  {
    topic: z.string().describe('Topic category (e.g., "APA regulation", "lab scheduling")'),
    finding: z.string().describe('The finding — clear, specific, actionable'),
    evidence: z.string().describe('Source (DOI, URL, conversation reference)'),
    tags: z.array(z.string()).describe('Tags for discoverability'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'knowledge_publish',
      topic: args.topic,
      finding: args.finding,
      evidence: args.evidence,
      tags: args.tags,
      from: groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Published knowledge: "${args.topic}"` }] };
  },
);

// knowledge_search — search the shared knowledge base
server.tool(
  'knowledge_search',
  `Helper that returns an instruction for how to search the shared knowledge base via qmd. Does NOT perform the search itself.

Use when: you want a reminder of the correct qmd invocation for the agent-knowledge collection.
Prefer calling qmd directly when: you already know the qmd query interface — this tool only reformats your query into a qmd call.

Inputs: query (required), from_agent (optional filter), topic (optional filter).

Returns: text instructing which qmd call to make next. You must then call qmd to get actual results.`,
  {
    query: z.string().describe('Semantic search query'),
    from_agent: z.string().optional().describe('Restrict to findings published by this agent'),
    topic: z.string().optional().describe('Restrict to findings with this topic'),
  },
  async (args) => {
    return {
      content: [{
        type: 'text' as const,
        text:
          `To search shared knowledge, use the qmd tool with collection "agent-knowledge" and query: "${args.query}". ` +
          (args.from_agent ? `Filter by agent: ${args.from_agent}. ` : '') +
          (args.topic ? `Filter by topic: ${args.topic}.` : ''),
      }],
    };
  },
);

// skill_search — discover available NanoClaw capabilities
server.tool(
  'skill_search',
  `Search the NanoClaw skill catalog for capabilities that are not currently installed. Use to discover what NEW tools the system could have, not to find something you already have.

Use when: you need a capability but don't see a matching tool in your current toolset (e.g., "I need to read PDFs but send_file only sends them").
Do not use for: finding already-installed tools — those are loaded at startup.

Inputs:
- need: natural-language description of what you want to do.

Returns: matching skills from QMD's skill-catalog collection with install instructions (e.g. "run /add-pdf-reader"). If QMD is unavailable or no matches, returns a short fallback message. 10-second timeout.`,
  {
    need: z.string().describe('Natural-language description of the capability you need'),
  },
  async (args) => {
    const requestId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'skill_search',
      query: args.need,
      requestId,
      groupFolder,
    });
    const result = await waitForIpcResult(SKILL_RESULTS_DIR, requestId, 10000);
    if (!result || !(result as any).success) {
      const msg = (result as any)?.message || 'No matching skills found (or QMD unavailable).';
      return { content: [{ type: 'text' as const, text: msg }] };
    }
    return { content: [{ type: 'text' as const, text: (result as any).message }] };
  },
);

// write_agent_memory — persist structured memory across sessions
server.tool(
  'write_agent_memory',
  `Patch one section of your AGENT-SCOPED persistent memory file (data/agents/<you>/memory.md). Content persists across sessions and travels with you into other groups.

Use when:
- Recording decisions, key facts, or session-continuity notes about YOU as an agent.
- Updating standing instructions that apply everywhere.

Prefer write_agent_state when: the fact is group-specific and shouldn't leak into other groups.
Prefer knowledge_publish when: the fact is useful to OTHER agents, not just to you.

Before writing, apply docs/memory-writeback-sop.md:
- No Execution, No Memory — write only action-verified facts, not planned actions.
- Pick exactly one memory layer using that file's decision tree.
- Prefer minimal patches over full rewrites.
- Skip volatile state (timestamps, PIDs, session IDs).

Inputs:
- section: section header — matches an existing "## Header" line to update it, or creates a new section if not found.
- content: markdown body for this section (bullet points recommended).

Returns: "Memory section <section> updated." Write is asynchronous.`,
  {
    section: z.string().describe('Section header (e.g. "Session Continuity", "Standing Instructions") — matches or creates an ## H2 heading'),
    content: z.string().describe('Markdown content for the section (bullets recommended)'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'write_agent_memory',
      section: args.section,
      content: args.content,
    });
    return { content: [{ type: 'text' as const, text: `Memory section "${args.section}" updated.` }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
