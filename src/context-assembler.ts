/**
 * Context Assembler for NanoClaw
 *
 * Pre-assembles a context packet for each agent container, including:
 * - Current date/time/timezone
 * - Group memory.md content
 * - current.md priorities
 * - Recent messages in the group
 * - Active scheduled tasks
 * - Pending message bus items
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  CONTEXT_PACKET_MAX_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { getRecentMessages, getAllTasks } from './db.js';
import { logger } from './logger.js';

/**
 * Query QMD for relevant knowledge based on the latest message.
 * Returns formatted snippets or empty string if QMD is unreachable.
 */
async function queryQmdForContext(query: string): Promise<string> {
  const QMD_URL = 'http://localhost:8181/mcp';
  const TIMEOUT_MS = 3000;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), TIMEOUT_MS);

    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            searches: [{ type: 'vec', query }],
            intent: query,
            minScore: 0.5,
            limit: 3,
          },
        },
      });

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 8181,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(timer);
            try {
              const text = Buffer.concat(chunks).toString();
              const parsed = JSON.parse(text);
              const content = parsed?.result?.content;
              if (!Array.isArray(content) || content.length === 0) {
                resolve('');
                return;
              }
              // Extract text from MCP response
              const resultText = content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text: string }) => c.text)
                .join('\n');

              if (!resultText.trim()) {
                resolve('');
                return;
              }

              // Parse QMD results and format as snippets
              const lines = resultText
                .split('\n')
                .filter((l: string) => l.trim());
              const snippets = lines
                .slice(0, 6) // title + snippet pairs
                .map((l: string) => l.slice(0, 200))
                .join('\n');

              resolve(
                snippets ? `\n--- Relevant knowledge ---\n${snippets}` : '',
              );
            } catch {
              resolve('');
            }
          });
        },
      );

      req.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timer);
        resolve('');
      });

      req.write(body);
      req.end();
    } catch {
      clearTimeout(timer);
      resolve('');
    }
  });
}

export async function assembleContextPacket(
  groupFolder: string,
  isMain: boolean,
): Promise<string> {
  const sections: string[] = [];

  // 1. Date and timezone
  const now = new Date();
  sections.push(
    `Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
  );
  sections.push(
    `Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
  );
  sections.push(`Timezone: ${TIMEZONE}`);

  // 2. Group memory.md
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'memory.md');
  if (fs.existsSync(memoryPath)) {
    const memory = fs.readFileSync(memoryPath, 'utf-8');
    if (memory.trim()) {
      sections.push(`\n--- Group Memory ---\n${memory.slice(0, 2000)}`);
    }
  }

  // 3. current.md priorities
  const currentPath = path.join(GROUPS_DIR, 'global', 'state', 'current.md');
  if (fs.existsSync(currentPath)) {
    const current = fs.readFileSync(currentPath, 'utf-8');
    if (current.trim()) {
      sections.push(`\n--- Current Priorities ---\n${current.slice(0, 1500)}`);
    }
  }

  // 4. Staleness warnings for key state files and group memory
  const stalenessWarnings = checkStaleness(groupFolder, now);
  if (stalenessWarnings.length > 0) {
    sections.push(`\n--- ⚠️ Stale Files ---\n${stalenessWarnings.join('\n')}`);
  }

  // 5. Recent messages (last 30)
  try {
    const messages = getRecentMessages(groupFolder, 30);
    if (messages.length > 0) {
      const formatted = messages
        .slice(-30)
        .map(
          (m) =>
            `[${new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}] ${m.sender}: ${m.content.slice(0, 200)}`,
        )
        .join('\n');
      sections.push(`\n--- Recent messages ---\n${formatted}`);
    }
  } catch {
    // DB not initialized yet or query failed, skip
  }

  // 5b. Topic-aware QMD search — surface relevant vault/notes content
  try {
    const messages = getRecentMessages(groupFolder, 1);
    const lastMsg = messages[0];
    if (lastMsg?.content && lastMsg.content.length > 10) {
      const qmdResult = await queryQmdForContext(lastMsg.content.slice(0, 300));
      if (qmdResult) {
        sections.push(qmdResult);
      }
    }
  } catch {
    // QMD unavailable, skip
  }

  // 6. Active scheduled tasks
  try {
    const tasks = getAllTasks();
    const groupTasks = tasks
      .filter((t) => t.status === 'active')
      .filter((t) => isMain || t.group_folder === groupFolder);
    if (groupTasks.length > 0) {
      const formatted = groupTasks
        .map(
          (t) =>
            `- ${t.prompt.slice(0, 80)}... (${t.schedule_type}: ${t.schedule_value})`,
        )
        .join('\n');
      sections.push(`\n--- Scheduled tasks ---\n${formatted}`);
    }
  } catch {
    // DB not initialized, skip
  }

  // 7. Message bus items pending for this group
  const busQueuePath = path.join(
    DATA_DIR,
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  if (fs.existsSync(busQueuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const formatted = queue
          .slice(0, 5)
          .map(
            (item: { from: string; finding: string }) =>
              `- From ${item.from}: ${(item.finding || '').slice(0, 150)}`,
          )
          .join('\n');
        sections.push(
          `\n--- Pending items from other agents ---\n${formatted}`,
        );
      }
    } catch {
      // Malformed queue, skip
    }
  }

  // 8. Classified events (from message bus)
  if (fs.existsSync(busQueuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      const classified = queue.filter(
        (m: { topic: string }) => m.topic === 'classified_event',
      );
      if (classified.length > 0) {
        const formatted = classified
          .slice(0, 10)
          .map(
            (e: {
              payload?: {
                classification?: { urgency?: string; summary?: string };
              };
              from?: string;
              finding?: string;
            }) =>
              `[${e.payload?.classification?.urgency || 'medium'}] ${e.payload?.classification?.summary || e.finding || 'No summary'} (from: ${e.from || 'unknown'})`,
          )
          .join('\n');
        sections.push(`\n--- Recent Events (classified) ---\n${formatted}`);
      }
    } catch {
      // Already read above or malformed, skip
    }
  }

  // Assemble and truncate
  let packet = sections.join('\n');
  if (packet.length > CONTEXT_PACKET_MAX_SIZE) {
    packet = packet.slice(0, CONTEXT_PACKET_MAX_SIZE) + '\n[...truncated]';
  }

  return packet;
}

const STALENESS_THRESHOLD_DAYS = 3;

/**
 * Check key state files and group memory for staleness.
 * Returns human-readable warnings for files not updated in >3 days.
 */
function checkStaleness(groupFolder: string, now: Date): string[] {
  const warnings: string[] = [];

  const filesToCheck: Array<{ path: string; label: string }> = [
    {
      path: path.join(GROUPS_DIR, 'global', 'state', 'current.md'),
      label: 'current.md (priorities)',
    },
    {
      path: path.join(GROUPS_DIR, 'global', 'state', 'goals.md'),
      label: 'goals.md',
    },
    {
      path: path.join(GROUPS_DIR, 'global', 'state', 'todo.md'),
      label: 'todo.md',
    },
    {
      path: path.join(GROUPS_DIR, groupFolder, 'memory.md'),
      label: 'group memory.md',
    },
  ];

  for (const file of filesToCheck) {
    try {
      if (!fs.existsSync(file.path)) continue;
      const stat = fs.statSync(file.path);
      const ageDays = Math.floor(
        (now.getTime() - stat.mtimeMs) / (24 * 60 * 60 * 1000),
      );
      if (ageDays >= STALENESS_THRESHOLD_DAYS) {
        warnings.push(
          `- ${file.label}: last updated ${ageDays} days ago — may be outdated`,
        );
      }
    } catch {
      // stat failed, skip
    }
  }

  return warnings;
}

/**
 * Write the context packet + bus queue to the group's IPC directory
 * so the container can read them at startup.
 */
export async function writeContextPacket(
  groupFolder: string,
  isMain: boolean,
  ipcDir: string,
): Promise<void> {
  const packet = await assembleContextPacket(groupFolder, isMain);
  const packetPath = path.join(ipcDir, 'context-packet.txt');
  fs.writeFileSync(packetPath, packet);

  // Also copy bus queue if it exists, then clear it (agent will process)
  const busQueueSrc = path.join(
    DATA_DIR,
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  const busQueueDst = path.join(ipcDir, 'bus-queue.json');
  if (fs.existsSync(busQueueSrc)) {
    fs.copyFileSync(busQueueSrc, busQueueDst);
    fs.writeFileSync(busQueueSrc, '[]');
  }
}
