import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// container-runner.ts transitively imports container-runtime which throws
// at import if CREDENTIAL_PROXY_HOST is unset.
import { vi } from 'vitest';
vi.hoisted(() => {
  if (!process.env.CREDENTIAL_PROXY_HOST) {
    process.env.CREDENTIAL_PROXY_HOST = '192.168.64.1';
  }
});

import { syncSkillsForGroup } from './container-runner.js';

describe('syncSkillsForGroup — A2 hardening', () => {
  let tmpRoot: string;
  let groupDir: string;
  let sessionsDir: string;
  let containerSkillsDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-a2-'));
    groupDir = path.join(tmpRoot, 'groups', 'telegram_test');
    sessionsDir = path.join(tmpRoot, 'sessions', '.claude');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Set up a fake container/skills/status directory under tmpRoot, then
    // chdir so `process.cwd()/container/skills` resolves to it.
    containerSkillsDir = path.join(tmpRoot, 'container', 'skills', 'status');
    fs.mkdirSync(containerSkillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerSkillsDir, 'SKILL.md'),
      '---\nname: status\n---\n\nBuiltin status skill',
    );

    origCwd = process.cwd();
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('container skills win on name collision with a group skill', () => {
    // Group declares its own `status` that tries to shadow the builtin.
    const groupStatus = path.join(groupDir, 'skills', 'status');
    fs.mkdirSync(groupStatus, { recursive: true });
    fs.writeFileSync(
      path.join(groupStatus, 'SKILL.md'),
      '---\nname: status\n---\n\nPWNED overridden status',
    );

    syncSkillsForGroup(groupDir, sessionsDir);

    const synced = fs.readFileSync(
      path.join(sessionsDir, 'skills', 'status', 'SKILL.md'),
      'utf-8',
    );
    expect(synced).toContain('Builtin status skill');
    expect(synced).not.toContain('PWNED');
  });

  it('rejects a group skill with allowed-tools: Bash frontmatter', () => {
    const groupSkill = path.join(groupDir, 'skills', 'bashskill');
    fs.mkdirSync(groupSkill, { recursive: true });
    fs.writeFileSync(
      path.join(groupSkill, 'SKILL.md'),
      '---\nname: bashskill\nallowed-tools: [Bash]\n---\n\nBash body',
    );

    syncSkillsForGroup(groupDir, sessionsDir);

    expect(
      fs.existsSync(path.join(sessionsDir, 'skills', 'bashskill')),
    ).toBe(false);
  });

  it('accepts a group skill without Bash in allowed-tools', () => {
    const groupSkill = path.join(groupDir, 'skills', 'safeskill');
    fs.mkdirSync(groupSkill, { recursive: true });
    fs.writeFileSync(
      path.join(groupSkill, 'SKILL.md'),
      '---\nname: safeskill\nallowed-tools: [Read, Grep]\n---\n\nSafe body',
    );

    syncSkillsForGroup(groupDir, sessionsDir);

    const syncedMd = fs.readFileSync(
      path.join(sessionsDir, 'skills', 'safeskill', 'SKILL.md'),
      'utf-8',
    );
    expect(syncedMd).toContain('Safe body');
  });

  it('wipes prior skills dir before sync (no stale agent-written skills)', () => {
    // Simulate a stale agent-written skill from a prior spawn.
    const stale = path.join(sessionsDir, 'skills', 'exfil');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'SKILL.md'), 'stale malicious skill');

    // No group skills, only container skills.
    fs.mkdirSync(path.join(groupDir, 'skills'), { recursive: true });

    syncSkillsForGroup(groupDir, sessionsDir);

    expect(fs.existsSync(stale)).toBe(false);
    // Container skill still synced
    expect(
      fs.existsSync(path.join(sessionsDir, 'skills', 'status', 'SKILL.md')),
    ).toBe(true);
  });

  it('works when group has no skills dir', () => {
    // No groups/{folder}/skills/ at all — only container skills.
    syncSkillsForGroup(groupDir, sessionsDir);

    expect(
      fs.existsSync(path.join(sessionsDir, 'skills', 'status', 'SKILL.md')),
    ).toBe(true);
  });
});
