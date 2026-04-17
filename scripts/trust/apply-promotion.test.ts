import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyPromotionToYaml, PromotionError } from './apply-promotion.js';

describe('applyPromotionToYaml', () => {
  let tmpDir: string;
  let yamlPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-test-'));
    yamlPath = path.join(tmpDir, 'trust.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('promotes the action from ask → draft', () => {
    fs.writeFileSync(
      yamlPath,
      'actions:\n  send_slack_dm: ask\n  send_message: notify\n',
    );
    const result = applyPromotionToYaml(yamlPath, 'send_slack_dm', 'ask', 'draft');
    expect(result).toMatchObject({
      action: 'send_slack_dm',
      from: 'ask',
      to: 'draft',
    });
    const after = fs.readFileSync(yamlPath, 'utf8');
    expect(after).toContain('send_slack_dm: draft');
    expect(after).toContain('send_message: notify');
  });

  it('rejects promotion when current level does not match expected', () => {
    fs.writeFileSync(yamlPath, 'actions:\n  send_slack_dm: draft\n');
    expect(() =>
      applyPromotionToYaml(yamlPath, 'send_slack_dm', 'ask', 'draft'),
    ).toThrow(PromotionError);
  });

  it('rejects promotion that skips the ladder', () => {
    fs.writeFileSync(yamlPath, 'actions:\n  send_slack_dm: ask\n');
    expect(() =>
      applyPromotionToYaml(yamlPath, 'send_slack_dm', 'ask', 'autonomous'),
    ).toThrow(/one step/);
  });

  it('rejects demotion', () => {
    fs.writeFileSync(yamlPath, 'actions:\n  send_slack_dm: notify\n');
    expect(() =>
      applyPromotionToYaml(yamlPath, 'send_slack_dm', 'notify', 'draft'),
    ).toThrow(/one step/);
  });

  it('rejects unknown action', () => {
    fs.writeFileSync(yamlPath, 'actions:\n  send_slack_dm: ask\n');
    expect(() =>
      applyPromotionToYaml(yamlPath, 'wat', 'ask', 'draft'),
    ).toThrow(/not found/);
  });

  it('preserves file formatting (idempotency of other keys)', () => {
    const before = 'actions:\n  send_slack_dm: ask\n  other_action: notify\n';
    fs.writeFileSync(yamlPath, before);
    applyPromotionToYaml(yamlPath, 'send_slack_dm', 'ask', 'draft');
    const after = fs.readFileSync(yamlPath, 'utf8');
    // other_action untouched, order preserved
    expect(after).toContain('other_action: notify');
    const lines = after.split('\n').filter((l) => l.trim());
    expect(lines[0]).toBe('actions:');
    // send_slack_dm stays as second entry
    expect(lines[1]).toContain('send_slack_dm');
  });

  it('rejects when trust.yaml file does not exist', () => {
    expect(() =>
      applyPromotionToYaml(yamlPath, 'send_slack_dm', 'ask', 'draft'),
    ).toThrow(/not found/);
  });
});
