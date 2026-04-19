#!/usr/bin/env bun
// One-shot script that stamps `permitted_senders` on every registered group
// from the canonical persona roster. Idempotent: re-running overwrites with
// the same target state. Dry-run by default; pass `--apply` to write.
//
// Canonical roster (source: NanoClaw persona plan, 2026-04-18):
//   LAB-claw     → Marvin, Warren, Vincent, FranklinClaw
//   HOME-claw    → Marvin, Warren
//   CODE-claw    → Simon, Vincent
//   SCIENCE-claw → Einstein, Simon, Vincent
//   COACH-claw   → Freud
//   CLINIC-claw  → Steve
//   VAULT/OPS/CLAIRE/Claire DM/emacs → [] (main bot only; no personas)
//
// Groups whose folder isn't in the map are left untouched (permittedSenders
// remains undefined → allow any, legacy behavior).

import { getAllRegisteredGroups, initDatabase, setRegisteredGroup } from '../src/db.js';

const ROSTER: Record<string, string[]> = {
  'telegram_lab-claw': ['Marvin', 'Warren', 'Vincent', 'FranklinClaw'],
  'telegram_home-claw': ['Marvin', 'Warren'],
  'telegram_code-claw': ['Simon', 'Vincent'],
  'telegram_science-claw': ['Einstein', 'Simon', 'Vincent'],
  'telegram_coach-claw': ['Freud'],
  'telegram_clinic-claw': ['Steve'],
  'telegram_vault-claw': [],
  'telegram_ops-claw': [],
  telegram_claire: [],
  emacs: [],
};

const apply = process.argv.includes('--apply');

initDatabase();
const groups = getAllRegisteredGroups();

const rows: Array<{
  jid: string;
  name: string;
  folder: string;
  before: string;
  after: string;
  changed: boolean;
}> = [];

for (const [jid, group] of Object.entries(groups)) {
  const target = ROSTER[group.folder];
  const before =
    group.permittedSenders === undefined
      ? '(any)'
      : JSON.stringify(group.permittedSenders);
  if (target === undefined) {
    rows.push({
      jid,
      name: group.name,
      folder: group.folder,
      before,
      after: before,
      changed: false,
    });
    continue;
  }
  const after = JSON.stringify(target);
  const changed = before !== after;
  rows.push({
    jid,
    name: group.name,
    folder: group.folder,
    before,
    after,
    changed,
  });
  if (changed && apply) {
    setRegisteredGroup(jid, { ...group, permittedSenders: target });
  }
}

const header = apply ? '[APPLY] Writing persona roster:' : '[DRY RUN] Would apply:';
console.log(header);
console.log();
for (const r of rows) {
  const marker = r.changed ? (apply ? '✓' : '→') : '·';
  console.log(
    `  ${marker} ${r.folder.padEnd(24)} ${r.jid.padEnd(26)} ${r.before} ${r.changed ? '=>' : '=='} ${r.after}`,
  );
}
console.log();
const changed = rows.filter((r) => r.changed).length;
console.log(
  `Summary: ${changed} ${apply ? 'updated' : 'pending'}, ${rows.length - changed} unchanged. Rerun with --apply to write.`,
);
