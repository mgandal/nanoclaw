#!/usr/bin/env bun
// C13 task 14: add missing action defaults to every agent's trust.yaml.
// Preserves existing keys (including those that contradict defaults —
// those are intentional per-agent customizations). Idempotent.
//
// Run: `bun scripts/c13-trust-defaults.ts`

import fs from 'fs';
import path from 'path';

const C13_DEFAULTS: Record<string, string> = {
  publish_to_bus: 'notify',
  schedule_task: 'draft',
  knowledge_publish: 'autonomous',
  write_agent_memory: 'autonomous',
  write_agent_state: 'autonomous',
  save_skill: 'draft',
  deploy_mini_app: 'draft',
  kg_query: 'autonomous',
  dashboard_query: 'autonomous',
  update_task: 'notify',
  pause_task: 'notify',
  resume_task: 'notify',
  cancel_task: 'notify',
};

const agentsRoot = path.join(process.cwd(), 'data', 'agents');
const agentDirs = fs
  .readdirSync(agentsRoot)
  .filter((n) => fs.statSync(path.join(agentsRoot, n)).isDirectory());

let totalAdded = 0;
for (const agent of agentDirs) {
  const yamlPath = path.join(agentsRoot, agent, 'trust.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.log(`  · ${agent} — no trust.yaml, skipping`);
    continue;
  }
  const original = fs.readFileSync(yamlPath, 'utf-8');

  // Minimal parser: find lines of shape `  <key>: <value>` under `actions:`.
  // Everything else (comments, blank lines) is left untouched.
  const lines = original.split('\n');
  const existingKeys = new Set<string>();
  let inActions = false;
  for (const raw of lines) {
    if (/^actions:\s*$/.test(raw)) {
      inActions = true;
      continue;
    }
    if (inActions && /^\S/.test(raw)) {
      inActions = false; // left the actions block
    }
    if (inActions) {
      const m = raw.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (m) existingKeys.add(m[1]);
    }
  }

  const toAdd = Object.entries(C13_DEFAULTS).filter(
    ([k]) => !existingKeys.has(k),
  );
  if (toAdd.length === 0) {
    console.log(`  · ${agent} — already has all C13 keys`);
    continue;
  }

  // Find the last line of the `actions:` block to insert before any trailing
  // comment/blank. Simpler: append to the end of the file if it ends with
  // `actions:` block (which every existing file does). Keep original
  // comments intact.
  const addBlock = [
    '  # === C13 additions (2026-04-19) ===',
    ...toAdd.map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n');

  // Insert before any trailing comment block that's attached to an absent
  // key (Freud, Steve, Warren have "fall through" comments at the end).
  // Safer to just append — YAML doesn't care about comment order.
  const trimmed = original.replace(/\n+$/, '');
  const updated = `${trimmed}\n${addBlock}\n`;

  fs.writeFileSync(yamlPath, updated);
  totalAdded += toAdd.length;
  console.log(
    `  ✓ ${agent} — added ${toAdd.length} keys: ${toAdd.map(([k]) => k).join(', ')}`,
  );
}

console.log(`\nTotal: ${totalAdded} keys added across ${agentDirs.length} agents.`);
