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
  AGENTS_DIR,
  CONTEXT_PACKET_MAX_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { compoundKey, compoundKeyToFsPath } from './compound-key.js';
import { getRecentMessages, getAllTasks } from './db.js';
import { logger } from './logger.js';

/**
 * Query QMD for relevant knowledge based on the latest message.
 * Returns formatted snippets or empty string if QMD is unreachable.
 */
/**
 * Send a JSON-RPC request to QMD's Streamable HTTP MCP endpoint.
 * Handles chunked transfer encoding by collecting the full response body.
 */
function qmdRequest(
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
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
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('QMD request timed out'));
    });
    req.write(body);
    req.end();
  });
}

async function queryQmdForContext(query: string): Promise<string> {
  const TIMEOUT_MS = 20_000; // QMD vec search can take 10-15s with embedding

  try {
    // Step 1: Initialize MCP session (required by Streamable HTTP protocol)
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'nanoclaw-context', version: '1.0' },
      },
    });
    const initRes = await qmdRequest(initBody, {}, TIMEOUT_MS);
    const sessionId = initRes.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      logger.debug('QMD: no Mcp-Session-Id in initialize response, skipping');
      return '';
    }

    // Step 2: Query with session ID — hybrid lex+vec for best recall
    // Extract keywords for BM25 leg (strip short/common words)
    const keywords = query
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 8)
      .join(' ');
    const queryBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          searches: [
            { type: 'vec', query },
            ...(keywords ? [{ type: 'lex', query: keywords }] : []),
          ],
          intent: query,
          minScore: 0.4,
          limit: 5,
        },
      },
    });
    const queryRes = await qmdRequest(
      queryBody,
      { 'Mcp-Session-Id': sessionId },
      TIMEOUT_MS,
    );

    const parsed = JSON.parse(queryRes.body);
    const content = parsed?.result?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return '';
    }

    const resultText = content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('\n');

    if (!resultText.trim()) return '';

    // Trust QMD's reranker for quality — take top results at natural length
    const trimmed = resultText.slice(0, 2000).trim();
    return trimmed ? `\n--- Relevant knowledge ---\n${trimmed}` : '';
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'QMD context query failed — skipping knowledge snippets',
    );
    return '';
  }
}

/**
 * Wrap an agent-written string in an XML-like tag for prompt assembly.
 * Neutralizes any closing tag inside the body so the agent cannot break
 * out of its block and inject a sibling (e.g. forge an elevated
 * <agent-trust> block by writing one into its own state.md). Same class
 * as the H6 YAML-frontmatter fix.
 */
function wrapAgentXml(tag: string, body: string): string {
  const closer = new RegExp(`</${tag}>`, 'gi');
  const escaped = body.replace(closer, `</${tag}-escaped>`);
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

/**
 * Sections assembled for the context packet, each tagged with a priority.
 * When the assembled packet exceeds CONTEXT_PACKET_MAX_SIZE, sections are
 * dropped from lowest priority to highest until it fits, and only then is
 * the packet truncated line-wise as a last resort. This prevents the flat
 * string slice from cutting XML tags mid-token.
 *
 * Priority scale (lower number = more important):
 *   1 — identity / structural (date, agent-identity, agent-state, agent-trust)
 *   2 — load-bearing memory (Session Continuity, hot cache, group memory,
 *       current priorities, staleness warnings)
 *   3 — operational context (recent messages, scheduled tasks, bus items)
 *   4 — bonus context (QMD snippets, legacy bus queue)
 */
type Section = { priority: 1 | 2 | 3 | 4; content: string };

export async function assembleContextPacket(
  groupFolder: string,
  isMain: boolean,
  agentName?: string,
): Promise<string> {
  const sections: Section[] = [];

  // 1. Date and timezone
  const now = new Date();
  sections.push({
    priority: 1,
    content: `Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
  });
  sections.push({
    priority: 1,
    content: `Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
  });
  sections.push({ priority: 1, content: `Timezone: ${TIMEZONE}` });

  // 2. Group memory.md
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'memory.md');
  if (fs.existsSync(memoryPath)) {
    const memory = fs.readFileSync(memoryPath, 'utf-8');
    if (memory.trim()) {
      sections.push({
        priority: 2,
        content: `\n--- Group Memory ---\n${memory.slice(0, 2000)}`,
      });
    }
  }

  // 3. current.md priorities
  const currentPath = path.join(GROUPS_DIR, 'global', 'state', 'current.md');
  if (fs.existsSync(currentPath)) {
    const current = fs.readFileSync(currentPath, 'utf-8');
    if (current.trim()) {
      sections.push({
        priority: 2,
        content: `\n--- Current Priorities ---\n${current.slice(0, 1500)}`,
      });
    }
  }

  // Session Continuity from agent memory (injected early so it survives truncation)
  if (agentName) {
    const agentMemoryPath = path.join(AGENTS_DIR, agentName, 'memory.md');
    if (fs.existsSync(agentMemoryPath)) {
      const agentMemory = fs.readFileSync(agentMemoryPath, 'utf-8');
      const continuityMatch = agentMemory.match(
        /## Session Continuity\n([\s\S]*?)(?=\n## |$)/,
      );
      if (continuityMatch?.[1]?.trim()) {
        const continuity = continuityMatch[1].trim().slice(0, 1500);
        sections.push({
          priority: 2,
          content: `\n--- Session Continuity (from prior compaction) ---\n${continuity}`,
        });
      }
    }

    // Hot cache — rolling recent-context snapshot for lead agents.
    // Read identity.md frontmatter; inject hot.md only when `lead: true`.
    const identityPath = path.join(AGENTS_DIR, agentName, 'identity.md');
    if (fs.existsSync(identityPath)) {
      const identity = fs.readFileSync(identityPath, 'utf-8');
      const fmMatch = identity.match(/^---\n([\s\S]*?)\n---/);
      const isLead =
        fmMatch?.[1] &&
        (fmMatch[1].includes('lead: true') || fmMatch[1].includes('lead:true'));
      if (isLead) {
        const hotPath = path.join(AGENTS_DIR, agentName, 'hot.md');
        if (fs.existsSync(hotPath)) {
          const hot = fs.readFileSync(hotPath, 'utf-8').trim();
          if (hot) {
            sections.push({
              priority: 2,
              content: `\n--- Hot Cache (recent context from prior session) ---\n${hot.slice(0, 3000)}`,
            });
          }
        }
      }
    }
  }

  // 4. Staleness warnings for key state files and group memory
  const stalenessWarnings = checkStaleness(groupFolder, now);
  if (stalenessWarnings.length > 0) {
    sections.push({
      priority: 2,
      content: `\n--- ⚠️ Stale Files ---\n${stalenessWarnings.join('\n')}`,
    });
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
      sections.push({
        priority: 3,
        content: `\n--- Recent messages ---\n${formatted}`,
      });
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
        sections.push({ priority: 4, content: qmdResult });
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
      sections.push({
        priority: 3,
        content: `\n--- Scheduled tasks ---\n${formatted}`,
      });
    }
  } catch {
    // DB not initialized, skip
  }

  // Legacy group-level bus queue (see message-bus.ts:217 appendToAgentQueue,
  // now unused). The compound-key per-message format below (pending-bus-messages)
  // is the current path. We still read queue.json if present so an older install
  // isn't silently stranded, but nothing in this codebase writes it anymore —
  // deleting the stray file is safe if you see one. Follow-up: drop this read
  // and the associated dead methods in message-bus.ts.
  const busQueuePath = path.join(
    DATA_DIR,
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  let busQueue: unknown[] = [];
  if (fs.existsSync(busQueuePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      if (Array.isArray(parsed)) busQueue = parsed;
    } catch {
      /* skip */
    }
  }

  // 7. Message bus items pending for this group
  if (busQueue.length > 0) {
    const formatted = busQueue
      .slice(0, 5)
      .map((item: unknown) => {
        const i = item as { from: string; finding: string };
        return `- From ${i.from}: ${(i.finding || '').slice(0, 150)}`;
      })
      .join('\n');
    sections.push({
      priority: 4,
      content: `\n--- Pending items from other agents ---\n${formatted}`,
    });
  }

  // 8. Classified events (from message bus)
  const classified = busQueue.filter(
    (m: unknown) => (m as { topic: string }).topic === 'classified_event',
  );
  if (classified.length > 0) {
    const formatted = classified
      .slice(0, 10)
      .map((e: unknown) => {
        const ev = e as {
          classification?: { urgency?: string; summary?: string };
          from?: string;
          finding?: string;
        };
        return `[${ev.classification?.urgency || 'medium'}] ${ev.classification?.summary || ev.finding || 'No summary'} (from: ${ev.from || 'unknown'})`;
      })
      .join('\n');
    sections.push({
      priority: 3,
      content: `\n--- Recent Events (classified) ---\n${formatted}`,
    });
  }

  // Agent identity sections (if compound group)
  if (agentName) {
    const agentDir = path.join(AGENTS_DIR, agentName);

    // Identity
    const identityPath = path.join(agentDir, 'identity.md');
    if (fs.existsSync(identityPath)) {
      const identity = fs.readFileSync(identityPath, 'utf-8');
      sections.push({
        priority: 1,
        content: wrapAgentXml('agent-identity', identity),
      });
    }

    // State
    const statePath = path.join(agentDir, 'state.md');
    if (fs.existsSync(statePath)) {
      const state = fs.readFileSync(statePath, 'utf-8').slice(0, 2000);
      sections.push({
        priority: 1,
        content: wrapAgentXml('agent-state', state),
      });
    }

    // Trust
    const trustPath = path.join(agentDir, 'trust.yaml');
    if (fs.existsSync(trustPath)) {
      const trust = fs.readFileSync(trustPath, 'utf-8');
      sections.push({
        priority: 1,
        content: wrapAgentXml('agent-trust', trust),
      });
    }

    // Pending bus messages (read-only scan — do NOT claim or delete)
    const busFsKey = compoundKeyToFsPath(compoundKey(groupFolder, agentName));
    const busDir = path.join(DATA_DIR, 'bus', 'agents', busFsKey);
    if (fs.existsSync(busDir)) {
      const pendingFiles = fs
        .readdirSync(busDir)
        .filter((f: string) => f.endsWith('.json'));
      if (pendingFiles.length > 0) {
        const pending = pendingFiles
          .slice(0, 5)
          .map((f: string) => {
            try {
              return JSON.parse(fs.readFileSync(path.join(busDir, f), 'utf-8'));
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (pending.length > 0) {
          sections.push({
            priority: 3,
            content: `<pending-bus-messages count="${pendingFiles.length}">\n${JSON.stringify(pending, null, 2)}\n</pending-bus-messages>`,
          });
        }
      }
    }
  }

  return packSections(sections, CONTEXT_PACKET_MAX_SIZE);
}

/**
 * Join sections into a single packet, respecting the size budget. Sections
 * are dropped whole from lowest to highest priority until the packet fits.
 * If a single must-keep (priority 1) section is larger than the budget, it
 * is truncated at a line boundary with a visible marker — we never cut an
 * XML tag mid-token.
 */
function packSections(sections: Section[], maxSize: number): string {
  const join = (xs: Section[]): string => xs.map((s) => s.content).join('\n');

  // Preserve original insertion order; drop by priority within that order.
  const kept = sections.slice();
  let packet = join(kept);
  if (packet.length <= maxSize) return packet;

  // Drop lowest-priority sections first (highest priority number). We iterate
  // 4 -> 2 because priority 1 is must-keep and gets special-case truncation
  // below if still oversized.
  for (const dropLevel of [4, 3, 2] as const) {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].priority === dropLevel) kept.splice(i, 1);
    }
    packet = join(kept);
    if (packet.length <= maxSize) {
      return `${packet}\n[...lower-priority context dropped to fit budget]`;
    }
  }

  // Only priority-1 sections remain and they still exceed the budget.
  // Truncate line-wise at the end of the packet. This keeps earlier
  // XML tags intact; the final (partial) block is all we sacrifice.
  const lines = packet.split('\n');
  while (lines.length > 1 && lines.join('\n').length > maxSize) {
    lines.pop();
  }
  return `${lines.join('\n')}\n[...truncated: identity content exceeded budget]`;
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
  agentName?: string,
): Promise<void> {
  const packet = await assembleContextPacket(groupFolder, isMain, agentName);
  fs.mkdirSync(ipcDir, { recursive: true });
  const packetPath = path.join(ipcDir, 'context-packet.txt');
  const tmpPacketPath = `${packetPath}.tmp`;
  fs.writeFileSync(tmpPacketPath, packet);
  fs.renameSync(tmpPacketPath, packetPath);

  // Bus messages are delivered via per-message files
  // (writeAgentMessage/listAgentMessages). No queue.json is produced here;
  // the read above is legacy-compat only.
}
