import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MessageBus } from './message-bus.js';

describe('MessageBus', () => {
  let busDir: string;
  let bus: MessageBus;

  beforeEach(() => {
    busDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-test-'));
    bus = new MessageBus(busDir);
  });

  afterEach(() => {
    fs.rmSync(busDir, { recursive: true, force: true });
  });

  it('publishes a message to the inbox', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('einstein');
    expect(messages[0].topic).toBe('research');
  });

  it('claims a message atomically', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    const claimed = bus.claim(messages[0].id, 'sep');
    expect(claimed).toBe(true);
    expect(bus.readInbox()).toHaveLength(0);
  });

  it('prevents double-claiming', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    expect(bus.claim(messages[0].id, 'jennifer')).toBe(false);
  });

  it('completes a message', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    bus.complete(messages[0].id);
    expect(fs.readdirSync(path.join(busDir, 'done'))).toHaveLength(1);
  });

  it('filters messages by topic', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'paper' });
    bus.publish({ from: 'jennifer', topic: 'scheduling', finding: 'meeting' });
    expect(bus.readByTopic('research')).toHaveLength(1);
  });

  it('routes to agent queue when action_needed is set', () => {
    bus.publish({
      from: 'einstein',
      topic: 'research',
      action_needed: 'sep',
      finding: 'test',
    });
    const queue = bus.readAgentQueue('sep');
    expect(queue).toHaveLength(1);
  });

  it('prunes old done messages', () => {
    bus.publish({ from: 'einstein', topic: 'research', finding: 'test' });
    const messages = bus.readInbox();
    bus.claim(messages[0].id, 'sep');
    bus.complete(messages[0].id);
    const doneFiles = fs.readdirSync(path.join(busDir, 'done'));
    const donePath = path.join(busDir, 'done', doneFiles[0]);
    const old = new Date(Date.now() - 4 * 24 * 3600_000);
    fs.utimesSync(donePath, old, old);
    bus.pruneOld(3 * 24 * 3600_000);
    expect(fs.readdirSync(path.join(busDir, 'done'))).toHaveLength(0);
  });
});
