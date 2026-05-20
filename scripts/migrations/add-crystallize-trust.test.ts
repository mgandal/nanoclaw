import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runMigration } from './2026-05-19-add-crystallize-trust.js';

describe('migration: add crystallize_skill: draft', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-test-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupAgent(name: string, trustContent: string) {
    const dir = path.join(agentsDir, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'trust.yaml'), trustContent);
    return dir;
  }

  it('T28 — idempotency: running twice produces byte-identical output', async () => {
    // Mutation pin for M5 (whitespace mangling in migration).
    setupAgent(
      'agent1',
      'actions:\n  save_skill: draft\n  send_message: notify\n',
    );
    await runMigration({ agentsDir, apply: true });
    const after1 = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    await runMigration({ agentsDir, apply: true });
    const after2 = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    expect(after2).toBe(after1);
  });

  it('T28.5 — round-trip: loadAgentTrust returns crystallize_skill === "draft"', async () => {
    // Mutation pin for M5: whitespace-mangled value fails this.
    // Pure exact-string idempotency does NOT catch this — must validate
    // through the real loader.
    setupAgent('agent1', 'actions:\n  save_skill: draft\n');
    await runMigration({ agentsDir, apply: true });

    const { loadAgentTrust } = await import('../../src/agent-registry.js');
    const trust = loadAgentTrust(path.join(agentsDir, 'agent1'));
    // Note: loadAgentTrust never returns null (returns {actions:{}} on missing/invalid).
    expect(trust.actions.crystallize_skill).toBe('draft');
  });

  it('T29 — malformed YAML: rejects without writing any file', async () => {
    setupAgent('agent1', 'actions:\n  save_skill: draft\n');
    setupAgent('agent2', 'this is not: valid\n  yaml: at all\n  : :');
    setupAgent('agent3', 'actions:\n  save_skill: draft\n');
    const beforeA1 = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    const beforeA3 = fs.readFileSync(
      path.join(agentsDir, 'agent3', 'trust.yaml'),
      'utf-8',
    );
    await expect(runMigration({ agentsDir, apply: true })).rejects.toThrow();
    expect(
      fs.readFileSync(path.join(agentsDir, 'agent1', 'trust.yaml'), 'utf-8'),
    ).toBe(beforeA1);
    expect(
      fs.readFileSync(path.join(agentsDir, 'agent3', 'trust.yaml'), 'utf-8'),
    ).toBe(beforeA3);
  });

  it('idempotent on already-migrated file (does not duplicate the key)', async () => {
    setupAgent(
      'agent1',
      'actions:\n  save_skill: draft\n  crystallize_skill: draft\n',
    );
    await runMigration({ agentsDir, apply: true });
    const content = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    const matches = content.match(/crystallize_skill:/g);
    expect(matches).toHaveLength(1);
  });

  it('dry-run (apply: false) does NOT write files', async () => {
    setupAgent('agent1', 'actions:\n  save_skill: draft\n');
    const before = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    await runMigration({ agentsDir, apply: false });
    const after = fs.readFileSync(
      path.join(agentsDir, 'agent1', 'trust.yaml'),
      'utf-8',
    );
    expect(after).toBe(before);
  });
});
