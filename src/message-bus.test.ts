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

  describe('per-message agent files', () => {
    it('writeAgentMessage writes individual JSON file', () => {
      bus.writeAgentMessage('telegram_lab-claw--einstein', {
        id: 'test-1',
        from: 'test',
        topic: 'test_topic',
        timestamp: new Date().toISOString(),
        summary: 'Test',
      });
      const dir = path.join(busDir, 'agents', 'telegram_lab-claw--einstein');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
    });

    it('listAgentMessages reads all pending JSON files', () => {
      bus.writeAgentMessage('telegram_lab-claw--einstein', {
        id: '1',
        from: 'a',
        topic: 't1',
        timestamp: new Date().toISOString(),
      });
      bus.writeAgentMessage('telegram_lab-claw--einstein', {
        id: '2',
        from: 'b',
        topic: 't2',
        timestamp: new Date().toISOString(),
      });
      expect(bus.listAgentMessages('telegram_lab-claw--einstein')).toHaveLength(
        2,
      );
    });

    it('listAgentMessages ignores .processing files', () => {
      const dir = path.join(busDir, 'agents', 'telegram_lab-claw--einstein');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, '123-abc.json'),
        '{"id":"1","from":"x","topic":"y","timestamp":"t"}',
      );
      fs.writeFileSync(
        path.join(dir, '456-def.processing'),
        '{"id":"2","from":"x","topic":"y","timestamp":"t"}',
      );
      expect(bus.listAgentMessages('telegram_lab-claw--einstein')).toHaveLength(
        1,
      );
    });

    it('claimAgentMessage renames to .processing', () => {
      bus.writeAgentMessage('telegram_lab-claw--einstein', {
        id: 'c1',
        from: 'x',
        topic: 'y',
        timestamp: new Date().toISOString(),
      });
      const dir = path.join(busDir, 'agents', 'telegram_lab-claw--einstein');
      const [file] = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      bus.claimAgentMessage('telegram_lab-claw--einstein', file);
      const remaining = fs.readdirSync(dir);
      expect(remaining.some((f) => f.endsWith('.processing'))).toBe(true);
      expect(remaining.filter((f) => f.endsWith('.json'))).toHaveLength(0);
    });
  });
});
