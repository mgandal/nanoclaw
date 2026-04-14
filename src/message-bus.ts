/**
 * Inter-Agent Message Bus for NanoClaw
 *
 * Filesystem-based pub/sub. No Redis, no RabbitMQ. Debuggable with ls.
 * Survives reboots. Costs zero tokens.
 *
 * Limitation: single-process (NanoClaw is single-process, so this is fine).
 * Bus items are injected into containers via context-assembler at spawn time.
 * Items published during a container's lifetime are only visible on next spawn.
 *
 * Directory structure:
 *   data/bus/
 *   ├── inbox/        New messages
 *   ├── processing/   Claimed by an agent
 *   ├── done/         Completed (retained 72h)
 *   └── agents/
 *       └── {group}/
 *           └── queue.json
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface BusMessage {
  id: string;
  from: string;
  topic: string;
  action_needed?: string;
  priority?: 'low' | 'medium' | 'high';
  finding?: string;
  timestamp: string;
  [key: string]: unknown;
}

export class MessageBus {
  private inboxDir: string;
  private processingDir: string;
  private doneDir: string;
  private agentsDir: string;

  constructor(basePath: string) {
    this.inboxDir = path.join(basePath, 'inbox');
    this.processingDir = path.join(basePath, 'processing');
    this.doneDir = path.join(basePath, 'done');
    this.agentsDir = path.join(basePath, 'agents');

    for (const dir of [
      this.inboxDir,
      this.processingDir,
      this.doneDir,
      this.agentsDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  publish(data: Omit<BusMessage, 'id' | 'timestamp'>): BusMessage {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = {
      ...data,
      id,
      timestamp: new Date().toISOString(),
    } as BusMessage;

    const tmpPath = path.join(this.inboxDir, `.${id}.json.tmp`);
    const finalPath = path.join(this.inboxDir, `${id}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(message, null, 2));
    fs.renameSync(tmpPath, finalPath);

    if (message.action_needed) {
      this.writeAgentMessage(message.action_needed, message);
    }

    logger.debug(
      { messageId: id, from: data.from, topic: data.topic },
      'Bus message published',
    );
    return message;
  }

  readInbox(): BusMessage[] {
    return this.readDir(this.inboxDir);
  }

  readByTopic(topic: string): BusMessage[] {
    return this.readInbox().filter((m) => m.topic === topic);
  }

  readAgentQueue(agentOrGroup: string): BusMessage[] {
    const queuePath = path.join(this.agentsDir, agentOrGroup, 'queue.json');
    if (!fs.existsSync(queuePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    } catch {
      return [];
    }
  }

  claim(messageId: string, claimedBy: string): boolean {
    const inboxPath = path.join(this.inboxDir, `${messageId}.json`);
    const processingPath = path.join(this.processingDir, `${messageId}.json`);
    if (!fs.existsSync(inboxPath)) return false;
    try {
      fs.renameSync(inboxPath, processingPath);
      const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
      data._claimedBy = claimedBy;
      data._claimedAt = new Date().toISOString();
      fs.writeFileSync(processingPath, JSON.stringify(data, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  complete(messageId: string): void {
    const processingPath = path.join(this.processingDir, `${messageId}.json`);
    const donePath = path.join(this.doneDir, `${messageId}.json`);
    if (fs.existsSync(processingPath)) {
      const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
      data._completedAt = new Date().toISOString();
      fs.writeFileSync(donePath, JSON.stringify(data, null, 2));
      fs.unlinkSync(processingPath);
    }
  }

  pruneOld(retentionMs: number): void {
    const cutoff = Date.now() - retentionMs;
    for (const file of fs.readdirSync(this.doneDir)) {
      const filePath = path.join(this.doneDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  }

  private readDir(dir: string): BusMessage[] {
    const messages: BusMessage[] = [];
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        messages.push(
          JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')),
        );
      } catch {
        /* skip malformed */
      }
    }
    return messages;
  }

  writeAgentMessage(agentFsKey: string, message: Partial<BusMessage>): void {
    if (
      agentFsKey.includes('..') ||
      agentFsKey.includes('/') ||
      agentFsKey.includes('\0')
    ) {
      throw new Error(`Invalid agentFsKey: ${agentFsKey}`);
    }
    const agentDir = path.join(this.agentsDir, agentFsKey);
    fs.mkdirSync(agentDir, { recursive: true });
    const ts = Date.now();
    const idPrefix = (
      message.id ?? Math.random().toString(36).slice(2, 8)
    ).slice(0, 8);
    const filename = `${ts}-${idPrefix}.json`;
    const tmpPath = path.join(agentDir, `.${filename}.tmp`);
    const finalPath = path.join(agentDir, filename);
    fs.writeFileSync(tmpPath, JSON.stringify(message, null, 2));
    fs.renameSync(tmpPath, finalPath);
  }

  listAgentMessages(agentFsKey: string): BusMessage[] {
    const agentDir = path.join(this.agentsDir, agentFsKey);
    if (!fs.existsSync(agentDir)) return [];
    const messages: BusMessage[] = [];
    for (const file of fs.readdirSync(agentDir).sort()) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        messages.push(
          JSON.parse(fs.readFileSync(path.join(agentDir, file), 'utf-8')),
        );
      } catch {
        /* skip corrupt files */
      }
    }
    return messages;
  }

  claimAgentMessage(agentFsKey: string, filename: string): boolean {
    const agentDir = path.join(this.agentsDir, agentFsKey);
    const jsonPath = path.join(agentDir, filename);
    const processingPath = path.join(
      agentDir,
      filename.replace(/\.json$/, '.processing'),
    );
    if (!fs.existsSync(jsonPath)) return false;
    try {
      fs.renameSync(jsonPath, processingPath);
      return true;
    } catch {
      return false;
    }
  }

  completeAgentMessage(agentFsKey: string, filename: string): void {
    const baseName = filename.replace(/\.processing$/, '');
    const agentDir = path.join(this.agentsDir, agentFsKey);
    const processingPath = path.join(agentDir, `${baseName}.processing`);
    const donePath = path.join(this.doneDir, baseName);
    if (fs.existsSync(processingPath)) {
      fs.renameSync(processingPath, donePath);
    }
  }

  private appendToAgentQueue(agentOrGroup: string, message: BusMessage): void {
    const agentDir = path.join(this.agentsDir, agentOrGroup);
    fs.mkdirSync(agentDir, { recursive: true });
    const queuePath = path.join(agentDir, 'queue.json');
    let queue: BusMessage[] = [];
    if (fs.existsSync(queuePath)) {
      try {
        queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      } catch {
        queue = [];
      }
    }
    queue.push(message);
    const tmpPath = `${queuePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
    fs.renameSync(tmpPath, queuePath);
  }
}
