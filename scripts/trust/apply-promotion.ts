#!/usr/bin/env bun
// Safely applies a trust promotion by editing data/agents/<agent>/trust.yaml.
//
// Safety guarantees:
//   - Promotion must be exactly one step up the ladder (ask → draft → notify → autonomous).
//   - Current level must match the expected level (prevents racing with a manual edit).
//   - Action must already exist in trust.yaml (never auto-adds unknown actions).
//   - Ceiling from data/trust-policy.yaml is enforced (same logic as analyzer).
//
// Usage:
//   bun scripts/trust/apply-promotion.ts <agent> <action>
//
// Exits non-zero on any rejection. Prints the diff-ready one-liner on success.

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { nextTrustLevel, type TrustLevel } from './analyze-promotions.js';
import { loadCeilings } from './run-analyzer.js';

const LADDER: TrustLevel[] = ['ask', 'draft', 'notify', 'autonomous'];

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionError';
  }
}

export interface PromotionResult {
  action: string;
  from: TrustLevel;
  to: TrustLevel;
  yamlPath: string;
}

export function applyPromotionToYaml(
  yamlPath: string,
  action: string,
  expectedFrom: TrustLevel,
  to: TrustLevel,
): PromotionResult {
  if (!fs.existsSync(yamlPath)) {
    throw new PromotionError(`trust.yaml not found: ${yamlPath}`);
  }

  const fromIdx = LADDER.indexOf(expectedFrom);
  const toIdx = LADDER.indexOf(to);
  if (fromIdx === -1) {
    throw new PromotionError(`unknown from-level: ${expectedFrom}`);
  }
  if (toIdx === -1) {
    throw new PromotionError(`unknown to-level: ${to}`);
  }
  if (toIdx - fromIdx !== 1) {
    throw new PromotionError(
      `promotion must move exactly one step up the ladder (got ${expectedFrom} → ${to})`,
    );
  }

  const raw = fs.readFileSync(yamlPath, 'utf8');
  const doc = YAML.parseDocument(raw);
  const actionsNode = doc.get('actions') as YAML.YAMLMap | undefined;
  if (!actionsNode) {
    throw new PromotionError(`trust.yaml has no 'actions' map`);
  }

  const currentLevel = actionsNode.get(action) as string | undefined;
  if (currentLevel === undefined) {
    throw new PromotionError(`action not found in trust.yaml: ${action}`);
  }
  if (currentLevel !== expectedFrom) {
    throw new PromotionError(
      `current level mismatch for ${action}: expected ${expectedFrom}, got ${currentLevel}`,
    );
  }

  actionsNode.set(action, to);
  fs.writeFileSync(yamlPath, String(doc));

  return { action, from: expectedFrom, to, yamlPath };
}

function main(): void {
  const [agent, action] = process.argv.slice(2);
  if (!agent || !action) {
    console.error(
      'Usage: bun scripts/trust/apply-promotion.ts <agent> <action>',
    );
    process.exit(2);
  }

  const repoRoot = process.cwd();
  const yamlPath = path.join(repoRoot, 'data/agents', agent, 'trust.yaml');
  const policyPath = path.join(repoRoot, 'data/trust-policy.yaml');

  if (!fs.existsSync(yamlPath)) {
    console.error(`Agent trust file not found: ${yamlPath}`);
    process.exit(3);
  }

  const raw = fs.readFileSync(yamlPath, 'utf8');
  const parsed = YAML.parse(raw) as
    | { actions?: Record<string, string> }
    | undefined;
  const currentLevel = parsed?.actions?.[action];
  if (!currentLevel) {
    console.error(
      `action '${action}' is not defined in ${yamlPath} — cannot promote`,
    );
    process.exit(4);
  }

  const to = nextTrustLevel(currentLevel);
  if (!to) {
    console.error(`${agent}::${action} is already at top of ladder (${currentLevel})`);
    process.exit(5);
  }

  const ceilings = loadCeilings(policyPath);
  const ceiling = ceilings[action];
  if (ceiling) {
    const ceilIdx = LADDER.indexOf(ceiling as TrustLevel);
    const toIdx = LADDER.indexOf(to);
    if (toIdx > ceilIdx) {
      console.error(
        `Refusing to promote ${action} past ceiling '${ceiling}' defined in ${policyPath}. Edit the policy file manually if this is intended.`,
      );
      process.exit(6);
    }
  }

  try {
    const result = applyPromotionToYaml(
      yamlPath,
      action,
      currentLevel as TrustLevel,
      to,
    );
    console.log(
      `OK: ${agent}::${result.action}  ${result.from} → ${result.to}  (${result.yamlPath})`,
    );
  } catch (err) {
    console.error(`FAIL: ${(err as Error).message}`);
    process.exit(7);
  }
}

if (import.meta.main) {
  main();
}
