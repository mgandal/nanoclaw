#!/usr/bin/env bun
// Dry-run analyzer for trust promotions.
//
// Reads all rows from agent_actions, loads ceilings from data/trust-policy.yaml,
// and prints promotion proposals to stdout. Does not mutate anything.
//
// Usage:
//   bun scripts/trust/run-analyzer.ts
//   bun scripts/trust/run-analyzer.ts --window 14 --min 20
//   bun scripts/trust/run-analyzer.ts --json

import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import {
  analyzePromotions,
  type ActionRow,
  type PolicyCeilings,
  type PromotionProposal,
} from './analyze-promotions.js';
import { formatProposal } from './format-proposal.js';

interface CliArgs {
  windowDays: number;
  minActions: number;
  minApprovalRate: number;
  json: boolean;
  dbPath: string;
  policyPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    windowDays: 30,
    minActions: 30,
    minApprovalRate: 0.95,
    json: false,
    dbPath: path.resolve(process.cwd(), 'store/messages.db'),
    policyPath: path.resolve(process.cwd(), 'data/trust-policy.yaml'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window') args.windowDays = Number(argv[++i]);
    else if (a === '--min') args.minActions = Number(argv[++i]);
    else if (a === '--rate') args.minApprovalRate = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--db') args.dbPath = path.resolve(argv[++i]);
    else if (a === '--policy') args.policyPath = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/trust/run-analyzer.ts [opts]

Options:
  --window N      Days of history to consider (default: 30)
  --min N         Minimum rows at current level to propose (default: 30)
  --rate F        Minimum approval rate 0-1 (default: 0.95)
  --json          Emit JSON instead of Telegram-formatted text
  --db PATH       Path to SQLite DB (default: store/messages.db)
  --policy PATH   Path to trust-policy.yaml (default: data/trust-policy.yaml)
`);
}

export function loadCeilings(policyPath: string): PolicyCeilings {
  if (!fs.existsSync(policyPath)) return {};
  const parsed = YAML.parse(fs.readFileSync(policyPath, 'utf8'));
  return (parsed?.ceilings as PolicyCeilings) ?? {};
}

function loadRows(dbPath: string): ActionRow[] {
  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    return [];
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        'SELECT agent_name, action_type, trust_level, outcome, created_at FROM agent_actions',
      )
      .all() as ActionRow[];
  } finally {
    db.close();
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadRows(args.dbPath);
  const ceilings = loadCeilings(args.policyPath);

  const proposals = analyzePromotions(rows, ceilings, {
    windowDays: args.windowDays,
    minActions: args.minActions,
    minApprovalRate: args.minApprovalRate,
  });

  if (args.json) {
    console.log(JSON.stringify(proposals, null, 2));
    return;
  }

  if (proposals.length === 0) {
    console.log(
      `No promotion candidates. (${rows.length} total rows in agent_actions, window=${args.windowDays}d, min=${args.minActions}, rate=${args.minApprovalRate})`,
    );
    return;
  }

  console.log(
    `Found ${proposals.length} promotion candidate(s) — review before applying:`,
  );
  console.log();
  for (const p of proposals) {
    console.log(formatProposal(p));
    console.log();
  }
  console.log(
    `To apply a promotion: bun scripts/trust/apply-promotion.ts <agent> <action>`,
  );
}

if (import.meta.main) {
  main();
}

export { parseArgs, main, type CliArgs, type PromotionProposal };
