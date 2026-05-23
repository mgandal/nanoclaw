# Skill Evolution: Best-of-N v1 (GEPA-ready)

**Date:** 2026-05-23
**Status:** Spec (pre-implementation, amended after 2 audit rounds)
**Origin:** STEAL recommendation from `/eval-repo` on `NousResearch/hermes-agent-self-evolution` (the upstream is a 40KB plan document with empty `evolution/` subdirs — we are not porting code, we are translating the plan to NanoClaw).

**Audit history:**
- **Round 1** (commit `4740acfc`): 3 reviewers found the original message-DB harvest premise empty, the rubric-without-execution circular, and the ToS posture broken. Pivoted to sandbox-execute + OneCLI routing + dropped DSPy/GEPA from v1.
- **Round 2** (this amendment): 3 reviewers found the sandbox-execute pivot introduced new flaws — `claude --print` won't auto-allow Write tools, the external-spec sources don't contain routing rules (re-creating the tautology), the noun-matching synthetic prompts under-discriminate, and the bad-merge-pollutes-real-vault rollback story is missing a blame trail. This amendment addresses all 8 Critical + 13 Important findings.

---

## Goal

Manually invoke a CLI that takes one container skill (`wiki` for v1), generates N candidate variants of its SKILL.md, scores each variant by actually executing the agent against a sandbox vault, and opens a PR against `mgandal/nanoclaw:main` with the winning variant if it beats the production baseline.

**v1 explicitly excludes:** DSPy, GEPA, cron automation, multi-skill runs, tool-description optimization, system-prompt optimization, code evolution, A/B traffic-splitting, auto-merge. All deferred to v2+.

## Non-goals

- No changes to `container/agent-runner/`, no new MCP tools, no IPC handlers.
- No instrumentation of the live agent path. The eval harness invokes a side-channel `claude --print` process against a scratch vault — production agents are untouched.
- No new launchd jobs or recurring schedules.
- No automated merge; every variant lands as a human-reviewable PR.

## Target skill: wiki

- File: `container/skills/wiki/SKILL.md` (4.6KB, well under the 15KB PLAN.md guardrail).
- **Liveness verified 2026-05-23** by counting wiki-path mentions in `data/sessions/*/.claude/projects/-workspace-group/*.jsonl`: **117 transcript files across 6 groups** mention `98-nanoKB/wiki` or `nanoKB/sources`. Primary user is `telegram_vault-claw` (95 files); secondary users are `telegram_claire` (10), `telegram_ops-claw` (6), `telegram_code-claw`/`lab-claw`/`science-claw` (2 each).
- **Caveat (R2-r2 audit):** the mention-count includes wiki-path mentions in scheduled-task prompt wrappers (`[SCHEDULED TASK ...]`) and inherited routing instructions, not just real wiki *writes*. `liveness.py` must count assistant-side `tool_use` events targeting paths under `wiki/`, not user-side path mentions. The 117 number is an upper bound; true write-invocations are lower (TBD by liveness module).
- Source-of-truth for edits is `container/skills/wiki/SKILL.md`. Container sync does a raw byte copy via `fs.cpSync`, and the destination dir is wiped on every container spawn — but v1 doesn't touch the live container (sandbox is `claude --print` outside the container; see Sandbox section). Container caching only matters for the rollback story.

### Skill split: separating data schema from procedural instructions

**R1-r2 #3 + R2-r2 #3 found that the synthesizer-from-external-spec design is broken** — `groups/global/CLAUDE.md` does not contain wiki folder-routing rules (only "check index.md first"), `wiki/index.md` is a flat page catalog with no schema, and `wiki/README.md` doesn't exist. The actual routing rules and conventions live IN the SKILL.md being optimized, which re-creates the original tautology.

**Fix:** v1 ships a one-time refactor extracting the *data schema* from `container/skills/wiki/SKILL.md` into a separate file:

- `container/skills/wiki/CONVENTIONS.md` (NEW, ~1KB) — the *invariant* parts the synthesizer reads: folder list, folder→tag mapping, frontmatter required keys, page-type list, the relationship between sources/wiki/index/log. This file is the ground truth the synthesizer is allowed to read.
- `container/skills/wiki/SKILL.md` (modified) — the *procedural* parts the optimizer can evolve: HOW to write a wiki page, in what order to do steps, what to check before writing. References CONVENTIONS.md by `@CONVENTIONS.md` link so live agents pick it up too.

This is the **schema-vs-instructions split**. The synthesizer reads CONVENTIONS.md (which it can't optimize against because it's stable). The mutator/sandbox use SKILL.md (which it can). The tautology breaks because the ground-truth for scoring is now in a file that doesn't change between baseline and variant.

This refactor is a *separate commit* before the first evolve run. The CONVENTIONS.md extraction itself is not optimized.

## Architecture

A new top-level tool at `scripts/skill-evolve/` with an isolated `venv/` (following repo convention from `scripts/pageindex/venv/`, `scripts/paperpile-wiki/venv/`, `scripts/markitdown/venv/` — `venv/`, not `.venv/`).

```
scripts/skill-evolve/
├── requirements.txt            # anthropic, click, pydantic, pyyaml, rapidfuzz (no dspy, no gepa, no pyproject.toml — matches paperpile-wiki/pageindex/markitdown convention per R2-r2 #4)
├── README.md                    # how to run, how to read the report
├── venv/                        # isolated; NOT touched by container build
├── rubrics/
│   ├── wiki.yaml                # per-skill rubric (4 scored axes + 1 pre-flight gate)
│   ├── wiki-golden.yaml         # human-pinned ground-truth: 5+ prompts with hand-written expected paths/tags (C7 fix)
│   ├── wiki-adversarial.yaml    # 5+ prompts where routing is non-obvious from prompt nouns (C5 fix)
│   └── semantic-preservation.md # full judge prompt for the preservation check
├── runs/                        # one dir per evolve run; under scripts/skill-evolve/ NOT /tmp (R3-r2 hazard: /tmp purged on reboot)
│   ├── .lock                    # file lock; prevents concurrent runs racing on scratch index.md (R3-r2)
│   └── _history.jsonl           # append-only: per-run id, baseline-score, winner-score, delta, cost, merged (R3-r2 #5)
└── skill_evolve/
    ├── __init__.py
    ├── __main__.py              # CLI entry (click); preflight: gh auth status, OneCLI reachability
    ├── config.py                # paths, env-var loading, OneCLI base URL, temperature=0 defaults
    ├── liveness.py              # count assistant-side tool_use events under wiki/, not user-side mentions (I8 fix)
    ├── harvest.py               # data/sessions/*/.claude/projects/*.jsonl → real prompts; filters [SCHEDULED TASK ...] wrappers (C8 fix); PII redaction before report.md publishes
    ├── synthesize.py            # Claude (temp=0) → synthetic prompts grounded on CONVENTIONS.md (not SKILL.md)
    ├── sandbox.py               # spawn `claude --print --permission-mode bypassPermissions --allowedTools "Write Edit Bash Read"` (C1 fix); writes variant to tempfile + passes as flag-arg (C2 fix); asyncio.gather concurrency=4 (I3 fix)
    ├── rubric.py                # deterministic checks; 4 scored axes (folder routing, frontmatter, tag set, body pre-flight); duplicate-collision deferred to v2 (C6)
    ├── mutate.py                # Claude (temp=0) as mutator; produces N variants in 1 call
    ├── evolve.py                # main loop; preflight noise-floor calibration (baseline-vs-baseline); merge-threshold = max(0.3, 3× observed baseline noise) (I2 fix)
    ├── escalate.py              # reads _history.jsonl; aborts if 3 consecutive no-PR runs OR $100 cumulative with 0 merges (I5 fix)
    ├── budget.py                # tallies tokens from OneCLI response headers; aborts mid-run at --max-budget; default $40 (I1 fix)
    ├── deploy.py                # writes variant + report → branch → `gh pr create --draft --repo mgandal/nanoclaw` (I4 + N8 fix); refuses if remote URL matches "qwibitai" (N9 negative-constraint fix)
    └── report.py                # render report.md with axis breakdown + diff + last-10-runs trend (I6 fix) + VAULT-claw delta panel (I7 fix)
```

### Module boundaries

Each unit answers "what does it do, how do you use it, what does it depend on" in one sentence:

| Module | What it does | Inputs | Outputs | Depends on |
|---|---|---|---|---|
| `liveness` | Confirms the target skill fires in production | skill name | bool + count of recent invocations | session JSONL transcripts |
| `harvest` | Extracts real user prompts from transcripts | skill name, lookback days | `list[RealPrompt]` | session JSONL transcripts |
| `synthesize` | Generates synthetic prompts grounded on an EXTERNAL spec (not the skill being tested — fixes R1 #5 tautology) | external_spec_paths, target_count | `list[SyntheticPrompt]` | Claude via OneCLI |
| `sandbox` | Runs `claude --print --append-system-prompt <variant>` against a scratch vault, returns files-written | variant SKILL.md text, prompt, scratch_vault_path | `list[FileWritten]` + stderr | `claude` CLI, `/tmp` |
| `rubric` | Scores sandbox output against rubric YAML, returns `(score, feedback)` per axis | sandbox output, rubric_path, prompt | `RubricResult` | YAML, regex, frontmatter parser |
| `mutate` | Asks Claude to rewrite SKILL.md given baseline scores + axis feedback | current SKILL.md, RubricResult, N | `list[VariantText]` | Claude via OneCLI |
| `evolve` | Orchestrates: score baseline → mutate → score variants → pick best | skill name, num_variants, num_iters | `EvolveResult` | all above |
| `deploy` | Writes winning variant + report.md, opens PR | EvolveResult | PR URL | `git`, `gh` |
| `report` | Renders human-readable comparison | EvolveResult | report.md | nothing |

### Data flow

```
container/skills/wiki/SKILL.md ──baseline──┐
                                            │
data/sessions/.../*.jsonl ──harvest──► real prompts (≥3, for realism check)
                                            │
groups/global/CLAUDE.md (routing rules)     │
98-nanoKB/wiki/index.md (schema)            │
container/skills/wiki/SKILL.md (read-only) ─┴──synthesize──► synthetic prompts (15)
                                            │
                                            ▼
                                    ┌── sandbox.run(baseline_SKILL, prompt) ──► files_written
                                    │
                                    ▼
                                    rubric.score(files_written, prompt) ──► (score, feedback) × 5 axes
                                            │
                                            ▼
                                    mutate(SKILL, baseline_feedback, N=5) ──► variants[]
                                            │
                              for each variant:
                                    sandbox.run → rubric.score
                                            │
                                            ▼
                                    pick variant with highest mean score
                                    AND mean ≥ baseline + 0.3 (configurable)
                                    AND no axis regressed by more than 0.5
                                    AND variant size ≤ 15KB (PLAN.md guardrail)
                                    AND semantic-preservation check passes (LLM-judge)
                                            │
                                            ▼
                                    deploy: branch skill-evolve/wiki-{run-id}
                                    │── container/skills/wiki/SKILL.md (modified)
                                    └── scripts/skill-evolve/runs/{run-id}/report.md
                                    gh pr create → mgandal/nanoclaw:main
```

### Why best-of-N, not GEPA, in v1

Reviewer 3 confirmed `dspy.GEPA` exists in DSPy 3.2.1 and supports whole-file optimization via the standalone `gepa` package's `optimize(seed_candidate={"skill": text}, ...)` API. **We do not use it in v1** because:

1. **GEPA's load-bearing edge is its `(score, feedback_string)` metric protocol feeding a reflection LM.** With our offline harness, the "trace" GEPA sees is `(prompt, variant text, output files, rubric score, axis feedback)` — exactly what a plain Claude mutator can also see via prompting. No privileged module-level trace exists because the agent is executed as a black-box subprocess.
2. **Heavy dep tree.** DSPy + GEPA + litellm + optuna + their transitive deps add maintenance surface for what is a ~50-line best-of-N loop.
3. **The module boundaries above are GEPA-ready.** When v2 wants to swap `mutate.py` for a GEPA-driven mutator, only that file changes. `rubric.py` already returns `(score, feedback)` tuples — exactly GEPA's `GEPAFeedbackMetric` shape.

The cost: best-of-N is less sample-efficient than GEPA's reflective search. For v1's single-skill, single-run cadence, that's acceptable.

## Eval source

The eval set has **three components**, all required:

### A. Human-pinned golden set (5+ cases) — `rubrics/wiki-golden.yaml`

Hand-authored before the first evolve run. Each case has a `user_prompt`, `expected_path_regex`, `expected_tags_subset`, all written by the operator (Mike). These are the **ground-truth anchor** — they exist because Tier-1 finding C7 noted that LLM-synthesizer-generated `expected_path_regex` makes "deterministic check against non-deterministic ground truth" — the golden set breaks that loop by having the regex come from a human, not an LLM.

Examples (to be written by operator):
- `prompt: "Add Tang et al 2024 on cortical microcircuit GWAS"` → `expected_path_regex: ^wiki/papers/.*tang.*\.md$`, `expected_tags_subset: ["wiki/papers"]`
- `prompt: "Summarize today's meeting with Connor about Iso-Seq isoform clustering"` → `expected_path_regex: ^10-daily/meetings/.*\.md$`, `expected_tags_subset: ["meetings"]`

### B. Adversarial set (5+ cases) — `rubrics/wiki-adversarial.yaml`

Hand-authored prompts where **routing is non-obvious from the prompt's nouns**. These exist because Tier-1 finding C5 showed that "paper on prefrontal microcircuits" → `papers/` is determined by the English word "paper" — even an empty SKILL.md routes it correctly. The adversarial set discriminates skill quality, not noun-matching.

Examples:
- `prompt: "Thoughts on yesterday's chat with Liqing about iso-seq"` → ambiguous between `10-daily/meetings/` and `syntheses/`; correct routing depends on whether the SKILL.md treats informal mentions as meetings or syntheses
- `prompt: "Quick summary of three GWAS findings I want to compare"` → ambiguous between `papers/` (multi-paper) and `syntheses/` (cross-paper comparison); correct routing depends on the skill's heuristic
- `prompt: "The mTOR paper everyone is talking about"` → underspecified; should the skill ask for more info, infer the latest mTOR paper from index, or punt to `syntheses/`?

### C. Synthetic set (15 cases) — generated each run by `synthesize.py`

Generated by Claude reading two inputs:
- `container/skills/wiki/CONVENTIONS.md` (folder list, schema, tag conventions) — provides the **rules**, so the `expected_path_regex` is derived from rules independent of SKILL.md (breaking the tautology).
- `rubrics/wiki-golden.yaml` (operator-pinned prompts from set A) — provides the **prompt topic distribution**, so the synthesizer generates more prompts in the topical style the operator considers important. The synthesizer does NOT copy the golden prompts (those are reserved for set A); it generates new ones in the same domains (papers, meetings, syntheses, tools).

The synthesizer never reads `container/skills/wiki/SKILL.md`. Less reliable than A+B (`expected_path_regex` is still LLM-generated for these 15 cases), but cheap and covers breadth. Per the score-aggregation note below, synthetic-set scores are weighted equally with golden+adversarial in the final mean — if the operator distrusts the synthesizer's regex generation, they should expand the golden set.

### D. Realism check (10 real prompts from transcripts) — `harvest.py` output

`harvest.py` parses `data/sessions/telegram_vault-claw/.claude/projects/-workspace-group/*.jsonl`. Per R2-r2 #1 it **must filter `[SCHEDULED TASK ...]` wrappers** (cron prompts mention wiki paths by construction). It then extracts the first non-scheduled user message of each session that subsequently triggers an assistant `tool_use` writing to `wiki/`. Picks 10 most recent: 8 from VAULT-claw, 2 from secondary groups (per I7 — bumped from 3 to 10 because VAULT-claw concentration risks idiosyncratic conventions being mistaken for general improvements).

PII redaction (N5): before any real prompt appears in `runs/{id}/report.md`, `harvest.py` runs regex redaction for emails, phone numbers, and any sender_name that isn't on a hardcoded allowlist (lab roster + operator). Attachment paths preserved as filenames only.

These 10 prompts are **not in the optimization loop** (statistical noise floor too high at n=10). Report.md runs baseline-vs-variant on them side-by-side and surfaces a "VAULT-claw delta" panel for the human reviewer. If any axis regresses by >0.2 on this set, the PR is auto-tagged `needs-VAULT-claw-review`.

### Score aggregation

Variant's score on a prompt = mean of the scored axes (4, not 5 — duplicate-collision is deferred to v2 per C6). Variant's total score = mean across all (golden ∪ adversarial ∪ synthetic) = 25+ prompts. Realism check is reported separately, never aggregated into the optimization score.

## Scoring: deterministic checks on sandbox-execution outputs

For each `(variant SKILL.md, prompt)` pair:

### 1. `sandbox.run`

- Create `/tmp/skill-evolve-{run-id}/scratch-vaults/{prompt-id}/` mirroring the relevant `98-nanoKB/` folder structure (empty dirs: `wiki/syntheses/`, `wiki/tools/`, `wiki/papers/`, `wiki/concepts/`, `sources/`, `10-daily/meetings/`; copy current `wiki/index.md` and `wiki/CONVENTIONS.md`). The `scratch-vaults/` dir lives in `/tmp`; only this is allowed to be ephemeral. `runs/` data lives under `scripts/skill-evolve/runs/` for reboot-survival (R3-r2 hazard).
- **C1 + C2 fix:** write variant SKILL.md to `/tmp/skill-evolve-{run-id}/variants/{variant-id}.md`, then spawn:
  ```
  claude --print \
    --permission-mode bypassPermissions \
    --allowedTools "Write Edit Bash Read" \
    --append-system-prompt "$(cat /tmp/.../variant.md)" \
    --append-system-prompt-flag-source
  ```
  (the `cat` substitution happens in Python before subprocess.run; no bash `<(...)` process substitution because that won't work without `shell=True`; no `shell=True` because of escaping fragility with multi-KB SKILL.md content).
- Subprocess env = allowlist of `PATH=/usr/bin:/bin`, `HOME=/tmp/skill-evolve-{run-id}/home`, `ANTHROPIC_BASE_URL` (from project `.env`), `ANTHROPIC_API_KEY=placeholder` (real key comes via OneCLI). Same pattern as `src/pageindex.ts:332-341` (N7 citation fix — pageindex's restriction is in the TS caller, not adapter.py).
- **Pre-flight MCP check (I11):** before sandbox run, grep variant SKILL.md for `mcp__` references. If any found, hard-fail with: "Variant references MCP tool X; v1 sandbox doesn't support MCPs (Tier-1 finding C6). Either drop the MCP reference or defer to v2-with-mock-MCP." Better to fail loudly than silently score 0.
- Capture all files created/modified under scratch-vault. Capture stderr. Timeout 90s per case.
- **SANDBOX_DEGENERATE abort (I6):** if a variant produces zero files for >50% of prompts, abort the whole run (the sandbox itself is broken, not the variant). Don't score; emit "SANDBOX_DEGENERATE: 9/15 prompts produced no files; check `claude` CLI args / OneCLI / permissions."

### 2. `rubric.score`

Evaluates **4 scored axes + 1 pre-flight gate** against `rubrics/wiki.yaml`. Each scored axis returns `(score: 0-1, feedback: str)` where the feedback is a one-paragraph explanation that could be fed into a reflection LM (GEPA-ready):

**Pre-flight gate (variant must pass to be eligible at all; not scored):**
- **Body structure**: has minimum sections required by CONVENTIONS.md for the routed page type. If failing, variant gets `eligible=False` and is skipped. Per N1 — saturates at 1.0 for all LLM output, contributes no signal as a scored axis.

**Scored axes (4):**
1. **Folder routing**: did the agent write to the expected folder? Score = 1.0 if `actual_path` matches `expected_path_regex` exactly, 0.5 if only the parent folder matches, 0.0 otherwise. Feedback names the expected and actual folder and the prompt cue that should have triggered the correct route.
2. **Frontmatter parse**: does the YAML frontmatter parse, contain all required keys (per CONVENTIONS.md), and have the required tag prefix `#wiki/<type>`?
3. **Tag set**: is the expected_tags_subset present in the frontmatter `tags:` list?
4. **(Future: duplicate collision)** — **DEFERRED to v2** per C6. Real wiki workflow is QMD-search-then-maybe-write; sandbox has no MCPs to do the search, so a sandbox agent will always write where a real agent might have found a dupe and stopped. Scoring this in v1 measures the wrong decision process.

Variant's score on a prompt = mean of the 4 scored axes (eligibility-gated by body-structure pre-flight). Variant's total score = mean across all golden + adversarial + synthetic prompts. Realism check is reported separately.

### 3. Noise-floor calibration (I2 fix)

Before scoring any variants, `evolve.py` runs the **baseline twice** on the full eval set. Measured run-to-run variance on the mean score becomes the `noise_floor`. The merge threshold is `max(0.3, 3 × noise_floor)` — the +0.3 constant in the original spec was theater; this version requires the variant to beat baseline by enough to be outside the rubric's intrinsic noise. If `noise_floor > 0.15`, hard-fail with "rubric is too noisy to discriminate variants; review temperature pinning or rubric design."

All Claude calls (synthesize, mutate, judge) use **temperature=0**; sandbox `claude --print` does not expose a temperature flag, so its randomness is the dominant contributor to `noise_floor`.

## Deploy posture: draft PR with vault-blame trail

### Remote check: negative constraint, not positive allowlist (N9 reframe)

```python
# deploy.py
FORBIDDEN_REMOTE_SUBSTRINGS = ("qwibitai",)
TARGET_BRANCH = "main"
```

Per the `never-reference-upstream-prs` and `never-push-upstream` feedback memories. Verified 2026-05-23 via `git remote -v`: `origin = git@github.com:mgandal/nanoclaw.git`, `upstream = git@github.com:qwibitai/nanoclaw.git`, plus skill-specific remotes `gmail`/`slack`/`telegram` all pointing at `qwibitai/nanoclaw-*`. The rule is "never push to qwibitai" — a negative constraint that survives clones, worktrees, and skill-fork remotes. A positive allowlist (`origin == mgandal/nanoclaw.git`) hard-fails the first time the tool runs from a clone with a different origin name. The deploy module asserts no remote URL it intends to push to matches any forbidden substring; refuses otherwise.

Push command uses explicit `--repo mgandal/nanoclaw` (N8 fix — `gh pr create` default base-detection prefers upstream when commits are shared between remotes; explicit is safer).

### Branch + run-id

Branch name: `skill-evolve/wiki-{run-id}` where `run-id = YYYYMMDD-HHMM-{sha8}` and `sha8` is the first 8 chars of `sha256(baseline_SKILL_md_bytes + seed)`. **Caveat:** reproducibility holds only for the synthesizer/mutator/judge calls (`temperature=0`). The sandbox `claude --print` calls are not seedable; the run-id pins **inputs**, not outputs.

### Vault-blame frontmatter stamp (C4 — critical)

**The most important pre-merge change to the wiki SKILL.md itself.** Modify `container/skills/wiki/SKILL.md` to instruct the agent: every wiki page write MUST include a `skill_version:` key in the YAML frontmatter. The value is `production` for hand-written/manually-deployed SKILL.md, and `skill-evolve/wiki-{run-id}` for any SKILL.md deployed via this tool. The deploy module patches the variant SKILL.md's instruction text to include its own run-id before writing the branch.

This converts the open-ended "did this bad SKILL.md pollute the real vault" rollback problem into a finite ripgrep:
```
rg "skill_version: skill-evolve/wiki-{run-id}" /Volumes/sandisk4TB/marvin-vault/98-nanoKB/
```
The rollback runbook lists every page touched by the bad variant. Manual review then decides revert-page, edit-page, or leave-as-is per page.

### `--draft` + 24h soak (I4)

`gh pr create --draft --repo mgandal/nanoclaw ...`. PR template body includes a `[ ] Soaked for 24h` checkbox. The operator manually flips draft→ready after the soak interval. No automation around this in v1 — it's a discipline, not a gate.

### PR template (rendered by `report.py`)

1. **Eval-delta table**: per-axis score for baseline vs winner across **golden + adversarial + synthetic** prompts (split into 3 sub-tables so the operator can see if the variant won on the noun-matching synthetics but lost on the adversarial set).
2. **Sample diff**: 3 hand-picked prompts where the variant beat baseline by ≥`noise_floor × 3` — show baseline output, variant output, axis-by-axis explanation.
3. **Realism check**: baseline vs variant on 10 real VAULT-claw prompts (8+2 per I7). Side-by-side files written; per-axis VAULT-claw delta panel. If any axis regresses by >0.2 on this set, PR is auto-tagged `needs-VAULT-claw-review`.
4. **Size delta**: bytes before/after. Hard fail at 15KB (PLAN.md guardrail).
5. **Semantic-preservation check**: a Claude call (temp=0) is given the baseline SKILL.md, the variant SKILL.md, and a fixed rubric stored at `scripts/skill-evolve/rubrics/semantic-preservation.md`: "Does the variant preserve all the procedures, folder rules, frontmatter requirements, and tag conventions of the baseline? Are any rules silently dropped or contradicted? Output a JSON score 1-5 and a list of any dropped/contradicted rules." Threshold ≥4/5 AND zero dropped rules. The variant submission may include an `intentional_drops:` allowlist (per R1-r2 add #3) — the judge sees this allowlist and won't penalize listed drops; the operator sees the allowlist in the PR for sanity check.
6. **Last-10-runs trend** (I6): per-axis history from `runs/_history.jsonl`. If the trend shows monotonic drift in any axis score (e.g., folder routing baseline keeps drifting upward run-over-run), surfaces "RUBRIC DRIFT SUSPECTED" warning.
7. **Rollback runbook**:
   - `git revert <merge-sha>` to undo the SKILL.md change
   - `rg "skill_version: skill-evolve/wiki-{run-id}" /Volumes/sandisk4TB/marvin-vault/98-nanoKB/` to enumerate vault pages touched by the variant
   - Smoke test: re-run sandbox on 3 golden prompts post-revert; confirm baseline scores hold

## Credentials & budget: OneCLI-routed with hard killswitch

Reviewer 2 (round 1) corrected the original draft: the canonical Python-helper pattern is **`ANTHROPIC_BASE_URL` pointing at OneCLI**, not `CLAUDE_CODE_OAUTH_TOKEN` directly. Reference: `scripts/paperpile-wiki/synthesizer.py:4`.

- All Claude calls (synthesize, mutate, semantic-preservation judge) go through OneCLI by setting `ANTHROPIC_BASE_URL` in the venv environment. The actual URL is read from the project `.env`.
- Fixes R1's ToS concern: judge calls use the OneCLI metered API key, not the user's Claude Code subscription seat. The OAuth-token path is the secondary fallback only.
- Copy the credential-loading pattern from `synthesizer.py`; do not import (R2-r1 hazard #5 — `paperpile-wiki/` is not a library).
- **R3-r2 retry hardening (I12):** OneCLI calls retry once with 60s backoff on 5xx/timeout before hard-failing the run.

### Budget recompute (I1 fix — original $3-10 was wrong)

Original estimate ignored the agent's tool-calling rounds during sandbox execution. Each of 75 sandbox `claude --print` calls loads variant SKILL.md (~5KB ≈ 1.5K tok input) + scratch vault context exposure + user prompt + system prompt, and the agent typically does 3-8 tool-calling rounds writing a wiki page (5-20K output tokens). Realistic per-sandbox-call: ~8K input + ~12K output = $0.024 + $0.18 = **$0.20**.

| Stage | Calls | Per-call cost | Subtotal |
|---|---|---|---|
| Synthesizer (15 cases in 1 call) | 1 | $0.20 | $0.20 |
| Mutator (5 variants in 1 call) | 1 | $0.10 | $0.10 |
| Sandbox `claude --print` | 75 | $0.20 | $15.00 |
| Semantic-preservation judge | 1 | $0.05 | $0.05 |
| Noise-floor baseline-2nd-run (I2) | 25 prompts × 1 | $0.20 | $5.00 |
| **Realistic total per run** | | | **$20-25** |
| **Upper bound (heavy tool-calling)** | | | **$40** |

`--max-budget USD` flag (default $40) hardcaps the run. `budget.py` tallies tokens from OneCLI response headers after every call; if cumulative cost > budget, abort mid-run with partial report.

### Wall-clock (I3 fix)

75 sandbox calls × 30s typical = ~37 min sequential. With `asyncio.gather(concurrency=4)` in `sandbox.py`, ~10 min wall-clock. Plus baseline second-run (12 min serial / 3 min parallel) + synthesizer + mutator + judge (~2 min). **Total wall-clock: ~15-20 min per evolve run with concurrency=4.** OneCLI may throttle parallel requests — if rate-limit errors > 10% of calls, halve concurrency and retry. CLI flag `--max-wall-clock-minutes` (default 60) provides an additional hard cap.

## Sandbox isolation

Each evolve run gets:
- **Ephemeral**: `/tmp/skill-evolve-{run-id}/` for `scratch-vaults/{prompt-id}/`, `variants/{variant-id}.md`, and `home/`. May be lost on reboot — that's fine, these are intermediate.
- **Persistent** (R3-r2 hazard): `scripts/skill-evolve/runs/{run-id}/` for `report.md`, `_history.jsonl`, `trace.jsonl`. These survive reboot. Run-completion writes a summary to `_history.jsonl` (parent of all runs, append-only).

Subprocess settings:
- `cwd=scratch-vault`, `CLAUDE_PROJECT_DIR=scratch-vault`
- No inherited `.env`; subprocess env = explicit allowlist: `PATH=/usr/bin:/bin`, `HOME=/tmp/skill-evolve-{run-id}/home`, `ANTHROPIC_BASE_URL` (from project `.env`), `ANTHROPIC_API_KEY=placeholder`. Same pattern as `src/pageindex.ts:332-341` (N7 citation fix).
- Per-prompt scratch-vault rmtree'd after each run; only file-diff text persists in report.md.

**File lock (I9):** `scripts/skill-evolve/runs/.lock` (POSIX fcntl). Prevents two concurrent evolve runs from racing on the shared `wiki/index.md` snapshot. The second concurrent invocation gets "another run in progress, exiting" without doing any work.

This protects the real vault at `/Volumes/sandisk4TB/marvin-vault/` from any harness bug.

## Error handling

| Failure | Detection | Response |
|---|---|---|
| `claude --print` timeout (>90s per case) | Subprocess timeout | Axis score = 0, feedback = "TIMEOUT", variant penalized but loop continues |
| `claude --print` non-zero exit | exit code | Same as timeout; report includes stderr |
| **SANDBOX_DEGENERATE: variant produces zero files for >50% of prompts** (I6) | After scoring loop | Abort run; emit "sandbox harness broken, not variant; check claude CLI + OneCLI + permissions" |
| **MCP reference in variant SKILL.md** (I11) | Pre-flight grep for `mcp__` | Hard fail variant pre-sandbox; "v1 sandbox doesn't support MCPs; defer to v2 or drop MCP reference" |
| OneCLI unreachable | HTTPx error on first call | Retry once with 60s backoff (I12); then hard-fail entire run; do NOT fall through to OAuth token (ToS) |
| Variant exceeds 15KB | Size check pre-sandbox | Skip variant, log, continue (don't waste sandbox runs) |
| **Noise floor > 0.15** (I2) | After baseline-vs-baseline calibration | Hard fail; "rubric too noisy to discriminate; review temperature pinning or rubric design" |
| All variants score below `baseline + max(0.3, 3 × noise_floor)` | After scoring | Write report, exit 0 with "no improvement", NO PR opened |
| Winning variant fails semantic-preservation (LLM-judge < 4/5 OR dropped-rules not in `intentional_drops:` allowlist) | Pre-deploy | Skip PR, log; report still written |
| Winning variant regresses VAULT-claw realism check by >0.2 on any axis (I7) | Pre-deploy | PR still opens but auto-tagged `needs-VAULT-claw-review` |
| Remote URL matches `qwibitai` substring (N9 negative-constraint) | Pre-push check in deploy | Hard fail with clear error |
| `gh auth status` fails preflight (N2) | At CLI startup | Hard fail; "gh CLI not authenticated; run `gh auth login`" |
| Husky pre-commit hook fails on the deploy commit | git exit code | Hard fail; report saved, PR not opened, user must investigate |
| **`runs/_history.jsonl` shows 3 consecutive no-PR runs OR $100 cumulative cost with 0 merges** (I5) | At CLI startup via `escalate.py` | Hard fail with `STOP: optimizer not delivering; review rubric or disable` |
| **Concurrent run already in progress** (I9) | At CLI startup via fcntl lock | Exit cleanly with "another run in progress" |

Per the `failsafe-sentinel-default` feedback memory: every guard denies (no PR) on missing/invalid signal rather than bypassing.

## Testing

Unit tests at `scripts/skill-evolve/tests/`:
- `test_liveness.py` — given a fixture session dir with N wiki mentions, returns N.
- `test_harvest.py` — given fixture JSONL, extracts expected prompts.
- `test_synthesize.py` — mock Claude returns canned response, verify shape.
- `test_sandbox.py` — fake `claude` shim (a bash script writing predetermined files) to verify sandbox capture without real Claude calls.
- `test_rubric.py` — given fixture file-trees, all 5 axes produce expected `(score, feedback)`.
- `test_mutate.py` — mock Claude, verify variant-count & basic shape.
- `test_deploy.py` — fake git repo in `/tmp`, verify branch naming, remote check, refusal on non-mgandal remote.

Integration test (manual, not CI): full run against the live `wiki` skill with `--num-variants 2 --max-budget 5usd`, end-to-end, verifying a `runs/{id}/report.md` lands and a draft PR (with `--draft` flag) opens. Run before declaring v1 done.

## Verification per CLAUDE.md "Testing Policy"

The user's repo CLAUDE.md mandates: *"ALWAYS run tests and verify fixes before declaring them done."* v1 is not done until:
1. All unit tests pass under `scripts/skill-evolve/venv/bin/pytest`.
2. One full evolve run against `wiki` produces a report.md with either a PR URL or "no improvement" justified by the scores.
3. The 3-real-prompt realism check shows baseline vs variant outputs that a human reviewer can sanity-check.

## What ships in v1

**Pre-evolve refactor (separate commit before any optimization run):**
- Extract data schema from `container/skills/wiki/SKILL.md` into `container/skills/wiki/CONVENTIONS.md` (~1KB). SKILL.md references CONVENTIONS.md by `@CONVENTIONS.md`.
- Modify SKILL.md to instruct agent: stamp `skill_version: <version>` frontmatter on every wiki page write.

**Evolve tool:**
- 12 Python modules at `scripts/skill-evolve/skill_evolve/` (~500-600 LOC total, per-module ≤100 lines).
- 4 rubric files at `scripts/skill-evolve/rubrics/`: `wiki.yaml`, `wiki-golden.yaml` (operator-authored), `wiki-adversarial.yaml` (operator-authored), `semantic-preservation.md`.
- `requirements.txt` (pinned), `README.md`. **No `pyproject.toml`** (N6 — repo convention).
- 10 unit-test files (added: `test_budget.py`, `test_escalate.py`, `test_harvest_scheduled_filter.py`).
- Updated root README pointer.

**Not in v1:** DSPy, GEPA, cron, launchd, IPC integration, multi-skill, tool-description optimization, A/B routing, auto-merge, code evolution, duplicate-collision scoring (deferred to v2 with mock-MCP).

## v2 hooks (deferred work)

The architecture leaves clean seams for:
1. **GEPA swap-in**: replace `mutate.py` with a `dspy.GEPA` or `gepa.optimize` call once we have data showing best-of-N plateaus. Rubric module already returns `(score, feedback)` matching `GEPAFeedbackMetric`.
2. **Multi-skill generalization**: CLI already takes `--skill <name>` and loads `rubrics/<name>.yaml`. Adding `qmd`/`paperpile` is mostly writing new rubric YAMLs.
3. **Tool-description optimization (PLAN.md Phase 2)**: swap `target_path` to `container/agent-runner/src/ipc-mcp-stdio.ts` tool descs; rubric becomes "did the agent pick the right tool for the prompt."
4. **Continuous loop (PLAN.md Phase 5)**: wrap `evolve.py` in a launchd plist on weekly cadence once Phase 1 has merged at least 3 winning variants without regression.

## Open questions deferred until after v1 ships

- **Real-prompt eval set growth**: 10 real prompts is enough for a realism check, not for optimization. If v1 shows the synthetic loop produces obviously good variants, harvest more transcripts and consider promoting real prompts to the optimization set in v2.
- **Body-quality scoring**: v1 explicitly does not score body quality (only structural pre-flight gate). If v1 winners look correct on routing/frontmatter but produce mediocre bodies, v2 needs an LLM-judge axis with an external rubric (not derived from the skill itself).
- **Duplicate-collision axis**: deferred to v2 with a mock-QMD MCP for the sandbox; v1's sandbox can't faithfully measure it because real workflow is QMD-search-then-maybe-write.
- **Container hot-reload / real-container shadow**: every evolve iteration that touches the real container would need a full respawn. v1 sidesteps this with `claude --print` outside the container. v2 may want a "real container shadow" mode for higher-fidelity scoring.
- **PR-iteration story**: v1's PR is one-shot. If the human reviewer says "drop change X, keep change Y," they must hand-edit; no re-evolve workflow. v2 could support `--continue-from PR#N` to fork a previous run's variant.
- **Pinned-dep rot (N3)**: `requirements.txt` is frozen for reproducibility, but anthropic SDK changes will break it in ~12 months. README notes a manual quarterly `pip install -U && pytest` smoke test.

## Punch-list deferred to writing-plans phase (Tier-3 audit findings)

These are addressed but in the implementation plan, not this spec:
- Per-stage structured JSON logging to `runs/{id}/trace.jsonl` (I6 implementation)
- `gh auth status` preflight in `__main__.py` (N2)
- Manual quarterly pip-upgrade smoke test in README (N3)
- PII redaction allowlist for `harvest.py` (N5 implementation detail)
