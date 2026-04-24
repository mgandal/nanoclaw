# C3 + C20 — KG Group Provenance and Scoped Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `visibility` column to `entities` and `edges` in `store/knowledge-graph.db` stamped at ingest time, scope `kg_query` results by caller group in `src/kg.ts`, and confirm-or-refute the `state_freshness` concern in `src/dashboard-ipc.ts`, so that a non-main agent can no longer read KG data sourced from private lab content.

**Architecture:** Add `visibility TEXT NOT NULL DEFAULT 'main'` to both `entities` and `edges`. Plumb `callerGroup` from `handleKgIpc` (which already receives `sourceGroup`) into `queryKg`, and filter all entity/edge SELECTs by visibility. Backfill the live DB by marking every existing row `'main'` — all 479 current entities are sourced from Claire-vault contacts, i.e. main-only content. Update `scripts/kg/ingest_phase1.py` to stamp `visibility` at insert time using a per-source-doc classifier. Do NOT modify `state_freshness` behavior in `dashboard-ipc.ts` — the existing code comment's claim is independently verifiable and will be validated in Task 9 before deciding.

**Tech Stack:** TypeScript, Vitest, `bun:sqlite`, Python (ingest), existing `handleKgIpc` / `queryKg` primitives.

**Source:** Findings C3 and C20 in `docs/superpowers/specs/2026-04-18-hardening-audit-design.md` (lines 407 and 592). Prior pattern: `docs/superpowers/plans/2026-04-19-tier-b-trust-coverage.md`.

---

## Context the executing engineer needs

### Ground-truth findings from current code (2026-04-23)

1. **`src/kg-ipc.ts` already threads `sourceGroup`** into the handler. The plumbing is done. What's missing is that `queryKg(dbPath, input)` doesn't take a caller argument and doesn't filter. This plan only needs to (a) add a `visibility` column, (b) accept `callerGroup` in `queryKg`, (c) filter SELECTs.

2. **`src/dashboard-ipc.ts:147-163` (`state_freshness`) has an explicit code comment** arguing the exposure is not a leak because the state files are already injected into every group's context packet. Do not change this without first verifying the claim (Task 9). If the claim holds, C3's state_freshness half is a documentation task, not a code change.

3. **`src/dashboard-ipc.ts:65` shows the existing filter pattern** for the sibling `task_summary` case: `isMain ? getAllTasks() : getAllTasks().filter(t => t.group_folder === sourceGroup)`. The KG filter in Task 6 mirrors this shape — done in SQL for efficiency but semantically identical.

### Decisions this plan resolves

- **Nullable vs required visibility column:** required (`NOT NULL DEFAULT 'main'`). Nullability is a foot-gun — a forgotten stamp becomes a silent leak. Default of `'main'` is the safe side.
- **Shareable-across-groups concept:** Yes. The column takes three values: `'main'` (only main-group callers see it), `'public'` (all groups see it), or `<group_folder>` (only that specific group sees it).
- **Backfill strategy:** Mark-all-main. The current DB has 479 entities, all from `20-contacts/*.md` (Claire-vault). Marking them all `'main'` is both the safe default and factually correct.

### Schema changes summary

Applied to both `store/knowledge-graph.db` (live) and `scripts/kg/schema.sql` (canonical):

```
ALTER TABLE entities ADD COLUMN visibility TEXT NOT NULL DEFAULT 'main';
ALTER TABLE edges    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility);
CREATE INDEX IF NOT EXISTS idx_edges_visibility    ON edges(visibility);
```

Note: `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT '...'` works in SQLite without a table rewrite — the default fills existing rows.

### Test-placement conventions

- `src/kg.test.ts` — new `queryKg` visibility tests.
- `src/kg-ipc.test.ts` — new IPC-end-to-end visibility tests.
- `src/dashboard-ipc.test.ts` — state_freshness verification test (Task 9).
- Tests use the `seedMiniGraph(db)` helper pattern in `src/kg-ipc.test.ts` — extend it to accept an optional `visibility` per row.

### Out of scope

- No changes to `review_queue` or `aliases` tables.
- No re-ingestion of existing content with per-doc classification.
- No trust-enforcement gate on `kg_query` (C13's territory, already closed).
- No changes to `scripts/kg/extractor.py` or `scripts/kg/parsers.py`.

---

## File Structure

| File | Role | Change |
|---|---|---|
| `scripts/kg/schema.sql` | Canonical schema | Add `visibility` column + indexes |
| `scripts/kg/ingest_phase1.py` | Ingest → INSERT | Stamp `visibility='main'` on every insert |
| `store/knowledge-graph.db` | Live DB | One-shot migration (Task 2) adds column + backfills |
| `src/kg.ts` | `queryKg` (read layer) | Accept `callerGroup`; filter SELECTs by visibility |
| `src/kg-ipc.ts` | IPC handler | Pass `sourceGroup` as `callerGroup` to `queryKg` |
| `src/dashboard-ipc.ts` | dashboard_query | Verified unchanged after Task 9 |
| `src/kg.test.ts` | `queryKg` unit tests | Add visibility cases |
| `src/kg-ipc.test.ts` | IPC integration tests | Add cross-group denial cases |
| `src/dashboard-ipc.test.ts` | Dashboard tests | Add state_freshness verification test |
| `scripts/kg/migrate_visibility.py` | One-shot migration | New file (Task 2) |


---

## Task 1: Update canonical schema

**Files:**
- Modify: `scripts/kg/schema.sql`

- [ ] **Step 1: Add visibility columns and indexes**

In the `entities` CREATE TABLE, add a column between `confidence` and `created_at`:

```
visibility TEXT NOT NULL DEFAULT 'main',  -- main|public|<group_folder>
```

Do the same inside `edges`. After the existing CREATE INDEX block, add:

```
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility);
CREATE INDEX IF NOT EXISTS idx_edges_visibility    ON edges(visibility);
```

- [ ] **Step 2: Verify a fresh DB from this schema has the new columns**

```
rm -f /tmp/kg-schema-test.db
sqlite3 /tmp/kg-schema-test.db < scripts/kg/schema.sql
sqlite3 /tmp/kg-schema-test.db ".schema entities" | grep visibility
sqlite3 /tmp/kg-schema-test.db ".schema edges" | grep visibility
```

Expected: two lines each showing `visibility TEXT NOT NULL DEFAULT 'main'`.

- [ ] **Step 3: Commit**

Commit message: `schema(kg): add visibility column to entities and edges`.
Body should cite plan file and the 'main' default rationale.

---

## Task 2: Write one-shot migration for live DB

**Files:**
- Create: `scripts/kg/migrate_visibility.py`

- [ ] **Step 1: Write the migration script**

The script should:
1. Accept `--db` argument (default `store/knowledge-graph.db`).
2. Use `sqlite3.connect()`.
3. For each of `entities` and `edges`, check whether the `visibility` column exists via `PRAGMA table_info(<table>)`. If absent, run `ALTER TABLE <table> ADD COLUMN visibility TEXT NOT NULL DEFAULT 'main'`.
4. Run the two `CREATE INDEX IF NOT EXISTS` statements.
5. Print entity counts grouped by visibility at the end (sanity check).
6. Be idempotent — re-running should be a no-op that prints `already exists` per table.

Use `conn.commit()` before close. Use `conn.execute(...)` for each statement (sqlite3 stdlib, not `db.run`).

- [ ] **Step 2: Dry-run migration on a copy**

```
cp store/knowledge-graph.db /tmp/kg-migrate-test.db
python3 scripts/kg/migrate_visibility.py --db /tmp/kg-migrate-test.db
```

Expected: `added entities.visibility`, `added edges.visibility`, count line showing all 479 entities as `main`.

- [ ] **Step 3: Verify idempotency**

Re-run the same command. Expected: both tables report `already exists`, exit 0.

- [ ] **Step 4: Run on live DB**

```
python3 scripts/kg/migrate_visibility.py
```

Entity count should match `sqlite3 store/knowledge-graph.db "SELECT COUNT(*) FROM entities"` (479 at plan-writing time; re-check before running).

- [ ] **Step 5: Commit**

Message: `migrate(kg): add visibility column to live knowledge-graph.db`.

---

## Task 3: Stamp visibility on new ingests

**Files:**
- Modify: `scripts/kg/ingest_phase1.py:229-241, 289-301`

- [ ] **Step 1: Read current insert blocks**

```
sed -n '225,305p' scripts/kg/ingest_phase1.py
```

Expected: two INSERT blocks — one for `entities`, one for `edges`.

- [ ] **Step 2: Add a classifier near the top of the file**

After the imports, define:

```python
def classify_visibility(source_doc: str | None) -> str:
    """Return the visibility tag for a given source_doc path.
    Current policy: every existing source directory is main-only.
    This function is the single extension point — when an ingester
    wants to mark content public or group-scoped, extend this
    classifier, do not sprinkle calls at insert sites.
    """
    return "main"
```

- [ ] **Step 3: Update the entities INSERT**

Add `visibility` to both the column list and the parameter tuple, using `classify_visibility(ent.get("source_doc"))` as the bound value. Preserve all other columns and any `ON CONFLICT` clause that may exist.

- [ ] **Step 4: Update the edges INSERT (same pattern)**

Add `visibility` to columns + params for the edges INSERT near line 289. Bind `classify_visibility(edge.get("source_doc"))`.

- [ ] **Step 5: Smoke-test: run ingest on a DB copy**

```
cp store/knowledge-graph.db /tmp/kg-ingest-test.db
python3 scripts/kg/ingest_phase1.py --db /tmp/kg-ingest-test.db 2>&1 | tail -20
```

(If the script does not accept `--db`, substitute whatever path argument it does take, or run against the default after backing it up.)

Expected: completes without schema errors. `sqlite3 /tmp/kg-ingest-test.db "SELECT visibility, COUNT(*) FROM entities GROUP BY visibility"` should show all rows as `main`.

- [ ] **Step 6: Commit**

Message: `ingest(kg): stamp visibility on every entity and edge insert`.


---

## Task 4: Extend test helper to accept visibility

**Files:**
- Modify: `src/kg-ipc.test.ts` (the `seedMiniGraph` helper)

- [ ] **Step 1: Read the current helper**

```
sed -n '13,80p' src/kg-ipc.test.ts
```

- [ ] **Step 2: Extend helper signature**

Define a new `SeedEntity` type with `{ id, canonical_name, type, visibility? }`. Change `seedMiniGraph(db)` to `seedMiniGraph(db, entities?: SeedEntity[])`.

Inside the helper:
- Add `visibility TEXT NOT NULL DEFAULT 'main'` to both the `entities` and `edges` CREATE TABLE strings.
- Default `entities` parameter to the existing two-row fixture when omitted, preserving backward compatibility.
- For each row, INSERT with `visibility ?? 'main'`.

For edge seeding, add `visibility TEXT NOT NULL DEFAULT 'main'` to the CREATE TABLE and add the column to any INSERT statements.

- [ ] **Step 3: Run existing tests to confirm no regressions**

```
bun --bun vitest run src/kg-ipc.test.ts
```

Expected: all pre-existing tests still pass (helper's default behavior is unchanged for existing callers).

- [ ] **Step 4: Commit**

Message: `test(kg): extend seedMiniGraph helper to accept visibility per row`.

---

## Task 5: Write failing queryKg visibility tests

**Files:**
- Modify: `src/kg.test.ts`

- [ ] **Step 1: Add three failing tests inside the existing top-level describe**

Test A — `main caller sees main + public + any group entities`:
- Seed three entities with same canonical_name `MainOnly` but visibilities `main`, `public`, `telegram_lab-claw`.
- Call `queryKg(dbPath, { query: 'MainOnly', callerGroup: 'telegram_claire', callerIsMain: true })`.
- Assert `matched` contains all three ids.

Test B — `non-main caller sees only public + own-group entities (no main)`:
- Seed four entities (same canonical name `Shared`) with visibilities `main`, `public`, `telegram_lab-claw`, `telegram_code-claw`.
- Call with `callerGroup: 'telegram_lab-claw', callerIsMain: false`.
- Assert `matched` contains only the `public` and `telegram_lab-claw` ids.

Test C — `neighbor traversal respects visibility`:
- Seed three entities: `seed` (public), `reachable` (public), `hidden` (main).
- Insert two edges: `seed -> reachable` (visibility `public`) and `seed -> hidden` (visibility `main`).
- Call with `hops: 1, callerGroup: 'telegram_lab-claw', callerIsMain: false`.
- Assert `result.neighbors` contains only `reachable` and `result.edges` contains only the `seed -> reachable` edge.

- [ ] **Step 2: Run tests to confirm they fail**

```
bun --bun vitest run src/kg.test.ts
```

Expected: the three new tests fail because `queryKg` does not yet accept `callerGroup` / `callerIsMain`, and the SQL does not filter by visibility.

- [ ] **Step 3: Commit the failing tests**

Message: `test(kg): add failing visibility tests (TDD red)`.

---

## Task 6: Implement visibility filtering in queryKg

**Files:**
- Modify: `src/kg.ts`

- [ ] **Step 1: Extend KgQueryInput type**

Add two optional fields to the `KgQueryInput` interface: `callerGroup?: string` and `callerIsMain?: boolean`.

- [ ] **Step 2: Add a visibility-clause helper**

Above `findMatched`, define:

```typescript
function visibilityClause(
  column: string,
  input: KgQueryInput,
): { clause: string; params: string[] } {
  if (input.callerIsMain) return { clause: '', params: [] };
  if (!input.callerGroup) {
    // Fail-safe: no caller context -> return only a sentinel-impossible value.
    // IPC call sites always supply callerGroup; direct in-process
    // callers must opt in explicitly.
    return { clause: `AND ${column} = ?`, params: ['__none__'] };
  }
  return {
    clause: `AND ${column} IN (?, ?)`,
    params: ['public', input.callerGroup],
  };
}
```

- [ ] **Step 3: Apply the clause to findMatched**

For the `from_entity_id` path, change the SELECT to include `${vis.clause}` and pass `...vis.params` alongside `input.from_entity_id`.

For the alias+canonical path, append `${vis.clause}` after the `${typeClause}` and before `LIMIT ?`, and splice `...vis.params` into the prepared-statement bindings after the type filter params but before `limit`.

- [ ] **Step 4: Apply the clause to traverse**

Change the `traverse` function signature to accept `input: KgQueryInput` as its final parameter. Inside:
1. Compute `edgeVis = visibilityClause('visibility', input)` and `entityVis = visibilityClause('visibility', input)`.
2. Append `${edgeVis.clause}` to both the `forward` and `reverse` prepared statements' WHERE clauses.
3. When calling `.all(...)` for forward/reverse, splice `...edgeVis.params` after the existing frontier + relation params.
4. When hydrating neighbors via the final `SELECT ... FROM entities`, append `${entityVis.clause}` to the WHERE and splice `...entityVis.params` into the `.all(...)` call.

- [ ] **Step 5: Update the queryKg call site**

Change the `traverse(db, seedIds, hops, input.relation_type)` call to `traverse(db, seedIds, hops, input.relation_type, input)`.

- [ ] **Step 6: Run the tests — expect green**

```
bun --bun vitest run src/kg.test.ts
```

Expected: all tests pass including the three new visibility cases.

- [ ] **Step 7: Commit**

Message: `feat(kg): scope queryKg results by caller visibility (C3/C20)`.


---

## Task 7: Wire callerGroup through the IPC handler

**Files:**
- Modify: `src/kg-ipc.ts`

- [ ] **Step 1: Pass sourceGroup into queryKg**

Rename the `_isMain` parameter of `handleKgIpc` to `isMain` (drop the leading underscore — it's now used). In the `KgQueryInput` construction, add two fields: `callerGroup: sourceGroup` and `callerIsMain: isMain`.

- [ ] **Step 2: Run kg-ipc tests**

```
bun --bun vitest run src/kg-ipc.test.ts
```

Expected: existing tests pass. If a test breaks because it was calling with `isMain=false` against a DB with `main`-visibility rows, update the test to pass `isMain=true` or add visibility setup — do this as a test correction, not by loosening the production filter.

- [ ] **Step 3: Commit**

Message: `feat(kg-ipc): pass sourceGroup+isMain into queryKg (C3/C20)`.

---

## Task 8: Write IPC-level cross-group isolation test

**Files:**
- Modify: `src/kg-ipc.test.ts`

- [ ] **Step 1: Add two end-to-end isolation tests inside the existing describe**

Test A — `non-main caller cannot read main-visibility entities via IPC`:
- Seed one entity `private-paper` with `canonical_name='PrivateGrant2025'`, `type='grant'`, `visibility='main'`.
- Call `handleKgIpc` with the query, `sourceGroup='telegram_lab-claw'`, `isMain=false`.
- Read the result file; assert `success=true` and `matched=[]`.

Test B — `main caller reads the same entity fine`:
- Same seed.
- Call `handleKgIpc` with `sourceGroup='telegram_claire'`, `isMain=true`.
- Read the result file; assert `matched` contains `private-paper`.

- [ ] **Step 2: Run and confirm pass**

```
bun --bun vitest run src/kg-ipc.test.ts
```

- [ ] **Step 3: Commit**

Message: `test(kg-ipc): verify cross-group isolation end-to-end (C20)`.

---

## Task 9: Verify state_freshness claim (C3 half)

**Files:**
- Modify: `src/dashboard-ipc.test.ts` (add verification test)

The existing code comment claims `state_freshness` is not a leak because every file in `groups/global/state/` is already injected into every group's context packet. Verify this directly. If true, pin the invariant. If false, escalate and amend this plan.

- [ ] **Step 1: Find the context packet builder**

```
grep -rn "groups/global/state\|GROUPS_DIR.*global.*state\|globalState" src/ | head -20
```

Expected: find the file that reads `groups/global/state/` during context-packet construction (likely `src/agent-context.ts` or `src/container-runner.ts`).

- [ ] **Step 2: Inspect what it injects**

Open the file(s). Confirm: does every file in `groups/global/state/` get surfaced to every group's agent? Or are some files main-only?

- [ ] **Step 3a: If the claim holds, add a pinning test**

Append to `src/dashboard-ipc.test.ts` a test that:
1. Lists files in `groups/global/state/` (skipping dotfiles).
2. Calls into the context-packet builder discovered in Step 1 (use the actual function name — do not ship the placeholder).
3. Asserts the two sets are equal.

The test's prose should state: "this test pins the C3 decision — state_freshness is intentionally unscoped because the files are already globally visible. If a future change splits global-state into per-group visibility, this test starts failing and forces a matching scope on state_freshness."

- [ ] **Step 3b: If the claim does NOT hold**

Stop. Add a Task 9.5 to this plan that scopes `state_freshness` by the caller's context-packet file list, mirroring the `task_summary` pattern in `src/dashboard-ipc.ts:65`. Do not proceed to Task 10 until the amendment is implemented and reviewed.

- [ ] **Step 4: Run the full dashboard test file**

```
bun --bun vitest run src/dashboard-ipc.test.ts
```

- [ ] **Step 5: Commit**

Message: `test(dashboard): pin state_freshness invariant (C3 confirmation)`.

---

## Task 10: Update audit-progress memory and spec

**Files:**
- Modify: `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/project_c_class_audit_progress.md`
- Modify: `docs/superpowers/specs/2026-04-18-hardening-audit-design.md`

- [ ] **Step 1: Annotate the spec**

After the `#### C3.` header block, add a "Status: resolved 2026-04-23" note matching the C6/C9 pattern. Cite the state_freshness pinning test and the KG visibility filter.

After `#### C20.`, add the same style of resolution note: cite `scripts/kg/migrate_visibility.py`, `classify_visibility` in `scripts/kg/ingest_phase1.py`, and the `visibility filtering` tests in `src/kg.test.ts` + cross-group isolation tests in `src/kg-ipc.test.ts`.

- [ ] **Step 2: Move C3 and C20 to the Closed list in the memory file**

Add two bullets in the Closed section with SHAs from Tasks 6, 2, and 9 commits. Remove C3 and C20 from the Tier B / Tier C open lists. Update the top-line count from 9/18 to 11/18 closed, and update the frontmatter `description` and progress blurb to reflect the new next-up item (C7/C12/C12b input-sanitization cluster).

- [ ] **Step 3: Commit the spec change**

Message: `docs(audit): mark C3 and C20 resolved 2026-04-23`.
(The memory file is outside the repo and is updated in Step 2 but not git-committed.)

---

## Task 11: Smoke test end-to-end against the live DB

**Files:** none (verification only)

- [ ] **Step 1: Confirm live DB has the column**

```
sqlite3 store/knowledge-graph.db ".schema entities" | grep visibility
sqlite3 store/knowledge-graph.db "SELECT visibility, COUNT(*) FROM entities GROUP BY visibility"
```

Expected: column present; all rows `main`.

- [ ] **Step 2: Run the full TS test suite for the touched files**

```
bun --bun vitest run src/kg.test.ts src/kg-ipc.test.ts src/dashboard-ipc.test.ts
```

Expected: all green.

- [ ] **Step 3: Restart NanoClaw so container agents pick up the new kg-ipc behavior**

```
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Expected: new pid, `state = running`.

- [ ] **Step 4: Manual IPC smoke test from a non-main group**

In a non-main agent session (e.g. LAB-claw), prompt the agent to run a `kg_query` for an entity known to be in `20-contacts/` (main-sourced). Confirm the response is `matched: []`. Then prompt the same query from CLAIRE (main) and confirm the entity is returned.

- [ ] **Step 5: Update memory hot-cache**

Note C3+C20 closed, new visibility column live, next audit item is C7/C12/C12b.

---

## Self-Review Results

**Spec coverage:**
- C3 "state_freshness leaks mtimes" → Task 9 (verification + pinning test).
- C3 "kg_query returns entities with no group provenance" → Tasks 5, 6, 7, 8.
- C20 "add source_collection / visibility field at ingest; scope queries by caller group" → Tasks 1, 2, 3, 6, 7.
- Backfill existing data → Task 2.
- Tests → Tasks 5, 8, 9.
- Documentation → Task 10.

No gap.

**Placeholder scan:** The only deliberate forward-reference is the context-packet lookup in Task 9 (the builder's function name is discovered in Step 1 and filled in before Step 3a's test is written). That's inherent — Step 1 is the discovery step.

**Type consistency:** `callerGroup` / `callerIsMain` used consistently in Tasks 5, 6, 7. `visibility` column type `TEXT NOT NULL DEFAULT 'main'` consistent across schema (Task 1), migration (Task 2), and ingest (Task 3). `classify_visibility(source_doc)` signature consistent between Task 3 and Task 10's memory update.

