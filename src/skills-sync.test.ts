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

    expect(fs.existsSync(path.join(sessionsDir, 'skills', 'bashskill'))).toBe(
      false,
    );
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

  // ─── Phase 1: agent crystallized-skill sync ───

  it('syncs crystallized skills from data/agents/{agent}/skills/crystallized/', () => {
    // Set up an agent with one crystallized skill.
    const agentsRoot = path.join(tmpRoot, 'data', 'agents');
    const skillDir = path.join(
      agentsRoot,
      'claire',
      'skills',
      'crystallized',
      'deadline-aggregation',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: deadline-aggregation\n---\n\nCrystallized body',
    );

    syncSkillsForGroup(groupDir, sessionsDir, {
      agentName: 'claire',
      agentsRoot,
    });

    const syncedMd = fs.readFileSync(
      path.join(sessionsDir, 'skills', 'deadline-aggregation', 'SKILL.md'),
      'utf-8',
    );
    expect(syncedMd).toContain('Crystallized body');
  });

  it('container > agent > group precedence on name collision', () => {
    // Group + agent both define `status`. Container builtin should still win.
    const groupStatus = path.join(groupDir, 'skills', 'status');
    fs.mkdirSync(groupStatus, { recursive: true });
    fs.writeFileSync(
      path.join(groupStatus, 'SKILL.md'),
      '---\nname: status\n---\n\nGROUP status',
    );
    const agentsRoot = path.join(tmpRoot, 'data', 'agents');
    const agentStatus = path.join(
      agentsRoot,
      'claire',
      'skills',
      'crystallized',
      'status',
    );
    fs.mkdirSync(agentStatus, { recursive: true });
    fs.writeFileSync(
      path.join(agentStatus, 'SKILL.md'),
      '---\nname: status\n---\n\nAGENT status',
    );

    syncSkillsForGroup(groupDir, sessionsDir, {
      agentName: 'claire',
      agentsRoot,
    });

    const synced = fs.readFileSync(
      path.join(sessionsDir, 'skills', 'status', 'SKILL.md'),
      'utf-8',
    );
    expect(synced).toContain('Builtin status skill'); // container wins
    expect(synced).not.toContain('GROUP');
    expect(synced).not.toContain('AGENT');
  });

  it('agent-crystallized skill overrides a same-name group skill', () => {
    // Without a container version of the name, agent > group.
    const groupOnly = path.join(groupDir, 'skills', 'deadline-aggregation');
    fs.mkdirSync(groupOnly, { recursive: true });
    fs.writeFileSync(
      path.join(groupOnly, 'SKILL.md'),
      '---\nname: deadline-aggregation\n---\n\nGROUP version',
    );
    const agentsRoot = path.join(tmpRoot, 'data', 'agents');
    const agentVer = path.join(
      agentsRoot,
      'claire',
      'skills',
      'crystallized',
      'deadline-aggregation',
    );
    fs.mkdirSync(agentVer, { recursive: true });
    fs.writeFileSync(
      path.join(agentVer, 'SKILL.md'),
      '---\nname: deadline-aggregation\n---\n\nAGENT version',
    );

    syncSkillsForGroup(groupDir, sessionsDir, {
      agentName: 'claire',
      agentsRoot,
    });

    const synced = fs.readFileSync(
      path.join(sessionsDir, 'skills', 'deadline-aggregation', 'SKILL.md'),
      'utf-8',
    );
    expect(synced).toContain('AGENT version');
    expect(synced).not.toContain('GROUP');
  });

  it('rejects an agent-crystallized skill with allowed-tools: Bash', () => {
    const agentsRoot = path.join(tmpRoot, 'data', 'agents');
    const skillDir = path.join(
      agentsRoot,
      'claire',
      'skills',
      'crystallized',
      'bashy',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: bashy\nallowed-tools: [Bash]\n---\n\nbody',
    );

    syncSkillsForGroup(groupDir, sessionsDir, {
      agentName: 'claire',
      agentsRoot,
    });

    expect(fs.existsSync(path.join(sessionsDir, 'skills', 'bashy'))).toBe(
      false,
    );
  });

  it('no-op when agentName is not provided (backwards compat)', () => {
    // Group skills only — agent sync should not run.
    syncSkillsForGroup(groupDir, sessionsDir);
    // Nothing to assert beyond "no throw"; existing tests cover the group+
    // container paths. Smoke test here is that the single-param call is
    // still accepted.
    expect(
      fs.existsSync(path.join(sessionsDir, 'skills', 'status', 'SKILL.md')),
    ).toBe(true);
  });

  it('no-op when the agent has no crystallized dir', () => {
    // agentName is passed but the crystallized dir does not exist — the
    // function should not throw and should behave identically to the
    // no-agent case.
    const agentsRoot = path.join(tmpRoot, 'data', 'agents');
    fs.mkdirSync(path.join(agentsRoot, 'claire'), { recursive: true });

    syncSkillsForGroup(groupDir, sessionsDir, {
      agentName: 'claire',
      agentsRoot,
    });

    // No crystallized skills synced, but container skills still there.
    expect(
      fs.existsSync(path.join(sessionsDir, 'skills', 'status', 'SKILL.md')),
    ).toBe(true);
  });
});
