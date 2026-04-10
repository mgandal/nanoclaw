import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  scanAgents,
  loadAgentIdentity,
  loadAgentTrust,
  getAgentsForGroup,
  getTrustLevel,
  type AgentIdentity,
  type AgentTrust,
  type AgentRegistryRow,
} from './agent-registry.js';

// Helper: write files in a temp agent dir
function makeAgentDir(
  baseDir: string,
  name: string,
  identityContent: string,
  trustContent?: string,
): string {
  const dirPath = path.join(baseDir, name);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'identity.md'), identityContent);
  if (trustContent !== undefined) {
    fs.writeFileSync(path.join(dirPath, 'trust.yaml'), trustContent);
  }
  return dirPath;
}

const VALID_IDENTITY = `---
name: TestAgent
role: Tester
description: A test agent
---

Body text.
`;

describe('loadAgentIdentity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid identity.md', () => {
    const dirPath = path.join(tmpDir, 'testagent');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, 'identity.md'), VALID_IDENTITY);

    const identity = loadAgentIdentity(dirPath);
    expect(identity).not.toBeNull();
    expect(identity!.name).toBe('TestAgent');
    expect(identity!.role).toBe('Tester');
    expect(identity!.description).toBe('A test agent');
    expect(identity!.dirName).toBe('testagent');
    expect(identity!.dirPath).toBe(dirPath);
    expect(identity!.bodyMarkdown.trim()).toBe('Body text.');
  });

  it('returns null when identity.md is missing', () => {
    const dirPath = path.join(tmpDir, 'nofile');
    fs.mkdirSync(dirPath);
    expect(loadAgentIdentity(dirPath)).toBeNull();
  });

  it('returns null when YAML frontmatter is missing required fields', () => {
    const dirPath = path.join(tmpDir, 'incomplete');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(
      path.join(dirPath, 'identity.md'),
      `---
name: Partial
---
Missing role and description.
`,
    );
    expect(loadAgentIdentity(dirPath)).toBeNull();
  });

  it('returns null for invalid YAML frontmatter', () => {
    const dirPath = path.join(tmpDir, 'badyaml');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(
      path.join(dirPath, 'identity.md'),
      `---
name: [unclosed bracket
role: bad
description: broken
---
body
`,
    );
    expect(loadAgentIdentity(dirPath)).toBeNull();
  });

  it('loads optional fields when present', () => {
    const dirPath = path.join(tmpDir, 'full');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(
      path.join(dirPath, 'identity.md'),
      `---
name: Full
role: Analyst
description: Full agent
model: gpt-4
urgent_topics:
  - emergency
routine_topics:
  - daily_check
---
Full body.
`,
    );
    const identity = loadAgentIdentity(dirPath);
    expect(identity).not.toBeNull();
    expect(identity!.model).toBe('gpt-4');
    expect(identity!.urgentTopics).toEqual(['emergency']);
    expect(identity!.routineTopics).toEqual(['daily_check']);
  });
});

describe('loadAgentTrust', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trust-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads actions from trust.yaml', () => {
    const dirPath = path.join(tmpDir, 'claire');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(
      path.join(dirPath, 'trust.yaml'),
      `actions:
  send_message: notify
  publish_to_bus: autonomous
`,
    );
    const trust = loadAgentTrust(dirPath);
    expect(trust.actions['send_message']).toBe('notify');
    expect(trust.actions['publish_to_bus']).toBe('autonomous');
  });

  it('returns empty actions when trust.yaml is missing', () => {
    const dirPath = path.join(tmpDir, 'nofile');
    fs.mkdirSync(dirPath);
    const trust = loadAgentTrust(dirPath);
    expect(trust).toEqual({ actions: {} });
  });

  it('returns empty actions when trust.yaml is invalid YAML', () => {
    const dirPath = path.join(tmpDir, 'badyaml');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, 'trust.yaml'), `actions: [broken`);
    const trust = loadAgentTrust(dirPath);
    expect(trust).toEqual({ actions: {} });
  });

  it('returns empty actions when actions key is missing', () => {
    const dirPath = path.join(tmpDir, 'noactions');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, 'trust.yaml'), `other: value\n`);
    const trust = loadAgentTrust(dirPath);
    expect(trust).toEqual({ actions: {} });
  });
});

describe('scanAgents', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds valid agents in the directory', () => {
    makeAgentDir(tmpDir, 'claire', VALID_IDENTITY);
    makeAgentDir(
      tmpDir,
      'einstein',
      VALID_IDENTITY.replace('TestAgent', 'Einstein'),
    );

    const agents = scanAgents(tmpDir);
    expect(agents.length).toBe(2);
    const names = agents.map((a) => a.dirName);
    expect(names).toContain('claire');
    expect(names).toContain('einstein');
  });

  it('skips subdirectory with missing identity.md', () => {
    makeAgentDir(tmpDir, 'claire', VALID_IDENTITY);
    // Create dir with no identity.md
    fs.mkdirSync(path.join(tmpDir, 'ghost'));

    const agents = scanAgents(tmpDir);
    expect(agents.length).toBe(1);
    expect(agents[0].dirName).toBe('claire');
  });

  it('skips agent with invalid YAML', () => {
    makeAgentDir(tmpDir, 'claire', VALID_IDENTITY);
    makeAgentDir(
      tmpDir,
      'broken',
      `---
name: [bad
role: broken
description: yes
---
`,
    );

    const agents = scanAgents(tmpDir);
    expect(agents.length).toBe(1);
    expect(agents[0].dirName).toBe('claire');
  });

  it('skips agent with missing required fields', () => {
    makeAgentDir(tmpDir, 'claire', VALID_IDENTITY);
    makeAgentDir(
      tmpDir,
      'partial',
      `---
name: Partial
---
No role or description.
`,
    );

    const agents = scanAgents(tmpDir);
    expect(agents.length).toBe(1);
    expect(agents[0].dirName).toBe('claire');
  });

  it('returns empty array when agentsDir does not exist', () => {
    const agents = scanAgents(path.join(tmpDir, 'nonexistent'));
    expect(agents).toEqual([]);
  });
});

describe('getTrustLevel', () => {
  const trust: AgentTrust = {
    actions: {
      send_message: 'notify',
      publish_to_bus: 'autonomous',
      write_vault: 'draft',
      schedule_task: 'ask',
    },
  };

  it('returns the configured trust level', () => {
    expect(getTrustLevel(trust, 'send_message')).toBe('notify');
    expect(getTrustLevel(trust, 'publish_to_bus')).toBe('autonomous');
    expect(getTrustLevel(trust, 'write_vault')).toBe('draft');
    expect(getTrustLevel(trust, 'schedule_task')).toBe('ask');
  });

  it('returns ask for unknown action', () => {
    expect(getTrustLevel(trust, 'unknown_action')).toBe('ask');
  });

  it('returns ask for invalid trust level value', () => {
    const badTrust: AgentTrust = {
      actions: { do_something: 'superuser' },
    };
    expect(getTrustLevel(badTrust, 'do_something')).toBe('ask');
  });

  it('returns ask when actions is empty', () => {
    expect(getTrustLevel({ actions: {} }, 'send_message')).toBe('ask');
  });
});

describe('getAgentsForGroup', () => {
  const makeIdentity = (dirName: string, name: string): AgentIdentity => ({
    name,
    role: 'Test',
    description: 'A test agent',
    dirName,
    dirPath: `/tmp/${dirName}`,
    bodyMarkdown: '',
  });

  const claire = makeIdentity('claire', 'Claire');
  const einstein = makeIdentity('einstein', 'Einstein');
  const jennifer = makeIdentity('jennifer', 'Jennifer');
  const allAgents = [claire, einstein, jennifer];

  it('returns agents that match the specific group', () => {
    const registry: AgentRegistryRow[] = [
      { agent_name: 'claire', group_folder: 'telegram_claire', enabled: 1 },
      { agent_name: 'einstein', group_folder: 'telegram_claire', enabled: 1 },
    ];

    const result = getAgentsForGroup('telegram_claire', allAgents, registry);
    expect(result.length).toBe(2);
    const names = result.map((a) => a.dirName);
    expect(names).toContain('claire');
    expect(names).toContain('einstein');
    expect(names).not.toContain('jennifer');
  });

  it('includes agents with wildcard group_folder *', () => {
    const registry: AgentRegistryRow[] = [
      { agent_name: 'claire', group_folder: '*', enabled: 1 },
    ];

    const result = getAgentsForGroup('telegram_any_group', allAgents, registry);
    expect(result.length).toBe(1);
    expect(result[0].dirName).toBe('claire');
  });

  it('excludes disabled agents (enabled=0)', () => {
    const registry: AgentRegistryRow[] = [
      { agent_name: 'claire', group_folder: 'telegram_claire', enabled: 1 },
      { agent_name: 'einstein', group_folder: 'telegram_claire', enabled: 0 },
    ];

    const result = getAgentsForGroup('telegram_claire', allAgents, registry);
    expect(result.length).toBe(1);
    expect(result[0].dirName).toBe('claire');
  });

  it('returns empty array when no agents match', () => {
    const registry: AgentRegistryRow[] = [
      { agent_name: 'claire', group_folder: 'telegram_other', enabled: 1 },
    ];

    const result = getAgentsForGroup('telegram_claire', allAgents, registry);
    expect(result).toEqual([]);
  });

  it('does not duplicate agents matched by both specific and wildcard entries', () => {
    const registry: AgentRegistryRow[] = [
      { agent_name: 'claire', group_folder: 'telegram_claire', enabled: 1 },
      { agent_name: 'claire', group_folder: '*', enabled: 1 },
    ];

    const result = getAgentsForGroup('telegram_claire', allAgents, registry);
    expect(result.filter((a) => a.dirName === 'claire').length).toBe(1);
  });

  it('skips registry entries whose agent_name does not exist in agents list', () => {
    const registry: AgentRegistryRow[] = [
      {
        agent_name: 'nonexistent',
        group_folder: 'telegram_claire',
        enabled: 1,
      },
    ];

    const result = getAgentsForGroup('telegram_claire', allAgents, registry);
    expect(result).toEqual([]);
  });
});
