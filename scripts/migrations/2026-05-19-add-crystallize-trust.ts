/**
 * One-off migration: add `crystallize_skill: draft` to every agent's
 * trust.yaml under data/agents/. Idempotent, validates-all-before-write,
 * dry-run-by-default.
 *
 * Usage:
 *   bun run scripts/migrations/2026-05-19-add-crystallize-trust.ts           # dry-run
 *   bun run scripts/migrations/2026-05-19-add-crystallize-trust.ts --apply   # write
 *
 * Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md (D8)
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export interface MigrationOpts {
  agentsDir: string;
  apply: boolean;
}

interface ParsedAgent {
  name: string;
  trustPath: string;
  doc: YAML.Document;
  needsWrite: boolean;
}

export async function runMigration(opts: MigrationOpts): Promise<{
  scanned: number;
  needsWrite: string[];
  alreadyDone: string[];
}> {
  const { agentsDir, apply } = opts;

  if (!fs.existsSync(agentsDir)) {
    throw new Error(`agentsDir does not exist: ${agentsDir}`);
  }

  // Phase 1 (validate-all): parse every trust.yaml. If any fails to parse,
  // throw without writing any. Spec D8 (validates parse before write).
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const parsed: ParsedAgent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const trustPath = path.join(agentsDir, entry.name, 'trust.yaml');
    if (!fs.existsSync(trustPath)) continue;

    const raw = fs.readFileSync(trustPath, 'utf-8');
    const doc = YAML.parseDocument(raw);
    if (doc.errors.length > 0) {
      throw new Error(
        `Malformed YAML in ${trustPath}: ${doc.errors[0].message}`,
      );
    }
    const json = doc.toJS();
    if (
      typeof json !== 'object' ||
      json === null ||
      typeof json.actions !== 'object' ||
      json.actions === null
    ) {
      throw new Error(`${trustPath} missing top-level "actions:" map`);
    }
    const needsWrite = json.actions.crystallize_skill === undefined;
    parsed.push({ name: entry.name, trustPath, doc, needsWrite });
  }

  const needsWrite = parsed.filter((p) => p.needsWrite).map((p) => p.name);
  const alreadyDone = parsed.filter((p) => !p.needsWrite).map((p) => p.name);

  if (!apply) {
    return { scanned: parsed.length, needsWrite, alreadyDone };
  }

  // Phase 2 (write): all parses passed. Now mutate + serialize.
  for (const p of parsed) {
    if (!p.needsWrite) continue;
    // YAML.Document mutation preserves comments + formatting.
    const actionsNode = p.doc.get('actions', true) as YAML.YAMLMap;
    actionsNode.set('crystallize_skill', 'draft');
    fs.writeFileSync(p.trustPath, p.doc.toString());
  }

  return { scanned: parsed.length, needsWrite, alreadyDone };
}

// CLI entrypoint
if (import.meta.main) {
  const apply = process.argv.includes('--apply');
  const agentsDir = path.resolve(process.cwd(), 'data', 'agents');
  runMigration({ agentsDir, apply }).then(
    (result) => {
      console.log(`Scanned: ${result.scanned} agent dirs`);
      console.log(
        `Already migrated (skipped): ${result.alreadyDone.join(', ') || '(none)'}`,
      );
      console.log(
        `${apply ? 'Wrote' : 'Would write'}: ${result.needsWrite.join(', ') || '(none)'}`,
      );
      if (!apply && result.needsWrite.length > 0) {
        console.log('\nDry-run only. Re-run with --apply to commit.');
      }
    },
    (err) => {
      console.error('Migration failed (no files written):', err.message);
      process.exit(1);
    },
  );
}
