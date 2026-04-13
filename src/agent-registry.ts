import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { logger } from './logger.js';

export interface AgentIdentity {
  name: string;
  role: string;
  description: string;
  dirName: string;
  dirPath: string;
  model?: string;
  urgentTopics?: string[];
  routineTopics?: string[];
  bodyMarkdown: string;
}

export interface AgentTrust {
  actions: Record<string, string>;
}

export interface AgentRegistryRow {
  agent_name: string;
  group_folder: string;
  enabled: number;
}

const VALID_TRUST_LEVELS = new Set(['autonomous', 'notify', 'draft', 'ask']);

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Reads identity.md from dirPath, parses YAML frontmatter, validates required
 * fields. Returns null if the file is missing, frontmatter is invalid, or
 * required fields are absent.
 */
export function loadAgentIdentity(dirPath: string): AgentIdentity | null {
  const identityPath = path.join(dirPath, 'identity.md');
  if (!fs.existsSync(identityPath)) {
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(identityPath, 'utf-8');
  } catch (err) {
    logger.warn({ err, dirPath }, 'agent-registry: failed to read identity.md');
    return null;
  }

  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    logger.warn(
      { dirPath },
      'agent-registry: no YAML frontmatter found in identity.md',
    );
    return null;
  }

  const [, yamlBlock, body] = match;

  let fm: Record<string, unknown>;
  try {
    fm = YAML.parse(yamlBlock) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { err, dirPath },
      'agent-registry: invalid YAML frontmatter in identity.md',
    );
    return null;
  }

  if (!fm || typeof fm !== 'object') {
    logger.warn(
      { dirPath },
      'agent-registry: YAML frontmatter did not parse to an object',
    );
    return null;
  }

  const name = fm['name'];
  const role = fm['role'];
  const description = fm['description'];

  if (typeof name !== 'string' || !name.trim()) {
    logger.warn({ dirPath }, 'agent-registry: missing required field "name"');
    return null;
  }
  if (typeof role !== 'string' || !role.trim()) {
    logger.warn({ dirPath }, 'agent-registry: missing required field "role"');
    return null;
  }
  if (typeof description !== 'string' || !description.trim()) {
    logger.warn(
      { dirPath },
      'agent-registry: missing required field "description"',
    );
    return null;
  }

  const identity: AgentIdentity = {
    name: name.trim(),
    role: role.trim(),
    description: description.trim(),
    dirName: path.basename(dirPath),
    dirPath,
    bodyMarkdown: body,
  };

  const model = fm['model'];
  if (typeof model === 'string') {
    identity.model = model;
  }

  const urgentTopics = fm['urgent_topics'];
  if (Array.isArray(urgentTopics)) {
    identity.urgentTopics = urgentTopics.map(String);
  }

  const routineTopics = fm['routine_topics'];
  if (Array.isArray(routineTopics)) {
    identity.routineTopics = routineTopics.map(String);
  }

  return identity;
}

/**
 * Reads trust.yaml from dirPath. Returns {actions: {}} if the file is missing
 * or unparseable.
 */
export function loadAgentTrust(dirPath: string): AgentTrust {
  const trustPath = path.join(dirPath, 'trust.yaml');
  if (!fs.existsSync(trustPath)) {
    return { actions: {} };
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(trustPath, 'utf-8');
    raw = YAML.parse(content);
  } catch (err) {
    logger.warn({ err, dirPath }, 'agent-registry: failed to parse trust.yaml');
    return { actions: {} };
  }

  if (!raw || typeof raw !== 'object') {
    return { actions: {} };
  }

  const obj = raw as Record<string, unknown>;
  const actions = obj['actions'];
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    return { actions: {} };
  }

  // Coerce all values to strings
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    actions as Record<string, unknown>,
  )) {
    result[key] = String(value);
  }

  return { actions: result };
}

/**
 * Scans agentsDir for subdirectories. For each, attempts to load a valid
 * AgentIdentity. Skips invalid agents with a warning log.
 */
export function scanAgents(agentsDir: string): AgentIdentity[] {
  if (!fs.existsSync(agentsDir)) {
    logger.warn(
      { agentsDir },
      'agent-registry: agents directory does not exist',
    );
    return [];
  }

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const agents: AgentIdentity[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(agentsDir, entry.name);
    const identity = loadAgentIdentity(dirPath);
    if (identity) {
      agents.push(identity);
    } else {
      logger.warn(
        { dirPath },
        'agent-registry: skipping invalid agent directory',
      );
    }
  }

  return agents;
}

/**
 * Returns the trust level for the given action. Returns 'ask' for unknown
 * actions or invalid trust level values.
 */
export function getTrustLevel(trust: AgentTrust, actionType: string): string {
  const level = trust.actions[actionType];
  if (level === undefined || !VALID_TRUST_LEVELS.has(level)) {
    return 'ask';
  }
  return level;
}

/**
 * Returns the agents whose dirName appears in the registry for this group
 * (matching group_folder exactly or '*'), and where enabled=1.
 * Deduplicates by dirName in case multiple registry rows match the same agent.
 */
export function getAgentsForGroup(
  groupFolder: string,
  agents: AgentIdentity[],
  registry: AgentRegistryRow[],
): AgentIdentity[] {
  const enabledAgentNames = new Set<string>();

  for (const row of registry) {
    if (row.enabled !== 1) continue;
    if (row.group_folder === groupFolder || row.group_folder === '*') {
      enabledAgentNames.add(row.agent_name);
    }
  }

  const seen = new Set<string>();
  const result: AgentIdentity[] = [];

  for (const agent of agents) {
    if (enabledAgentNames.has(agent.dirName) && !seen.has(agent.dirName)) {
      seen.add(agent.dirName);
      result.push(agent);
    }
  }

  return result;
}
