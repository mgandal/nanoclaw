# Skill Evolution: Best-of-N v1 (GEPA-ready)

**Date:** 2026-05-23
**Status:** Spec (pre-implementation)
**Origin:** STEAL recommendation from `/eval-repo` on `NousResearch/hermes-agent-self-evolution` (the upstream is a 40KB plan document with empty `evolution/` subdirs — we are not porting code, we are translating the plan to NanoClaw with eval-source and optimizer corrections from a 3-reviewer audit).

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
- Liveness verified 2026-05-23 by counting wiki-path mentions in `data/sessions/*/.claude/projects/-workspace-group/*.jsonl`: **117 transcript files across 6 groups** mention `98-nanoKB/wiki` or `nanoKB/sources`. Primary user is `telegram_vault-claw` (95 files); secondary users are `telegram_claire` (10), `telegram_ops-claw` (6), `telegram_code-claw`/`lab-claw`/`science-claw` (2 each).
- Source-of-truth for edits is `container/skills/wiki/SKILL.md`. Container sync (`src/container-runner.ts:185-195`) does a raw byte copy via `fs.cpSync` — no transformation, but the destination dir is wiped on every container spawn (line 131-134). Variants must edit the source file and force a fresh container per evaluation.

## Architecture

A new top-level tool at `scripts/skill-evolve/` with an isolated `venv/` (following repo convention from `scripts/pageindex/venv/`, `scripts/paperpile-wiki/venv/`, `scripts/markitdown/venv/` — `venv/`, not `.venv/`).

```
scripts/skill-evolve/
├── pyproject.toml              # anthropic, click, pydantic, pyyaml (no dspy, no gepa in v1)
├── requirements.txt            # frozen for reproducibility
├── README.md                    # how to run, how to read the report
├── venv/                        # isolated; NOT touched by container build
├── rubrics/
│   └── wiki.yaml                # per-skill rubric (5 axes, each with a feedback prompt)
├── runs/                        # one dir per evolve run; gitignored except report.md
└── skill_evolve/
    ├── __init__.py
    ├── __main__.py              # CLI entry (click)
    ├── config.py                # paths, env-var loading, OneCLI base URL
    ├── liveness.py              # confirm target skill actually fires before optimizing
    ├── harvest.py               # data/sessions/*/.claude/projects/*.jsonl → real prompts
    ├── synthesize.py            # Claude → synthetic prompts grounded on EXTERNAL spec
    ├── sandbox.py               # spawn `claude --print` against /tmp scratch vault
    ├── rubric.py                # deterministic checks on output files + (score, feedback) tuples
    ├── mutate.py                # Claude as mutator: produce N variants of SKILL.md
    ├── evolve.py                # main loop: baseline → variants → score → keep-best
    ├── deploy.py                # write variant + report → branch → gh pr create
    └── report.py                # render evolution-report.md with axis breakdown + diff
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

**Primary (optimization gradient): synthetic prompts grounded on external spec.**

Synthesizer reads three EXTERNAL spec sources (NOT the skill being tested — fixes R1 #5 tautology):
- `groups/global/CLAUDE.md` — folder routing rules (syntheses/, tools/, papers/, 10-daily/meetings/)
- `/Volumes/sandisk4TB/marvin-vault/98-nanoKB/wiki/index.md` — current page catalog (what counts as a duplicate)
- `/Volumes/sandisk4TB/marvin-vault/98-nanoKB/wiki/README.md` (if exists) — wiki conventions

Synthesizer generates 15 prompts spanning known failure modes:
- "Ingest this paper on prefrontal microcircuits" → must route to `papers/`
- "Notes from today's lab meeting with Liqing about Iso-Seq pipeline" → must route to `10-daily/meetings/`
- "How do colocalization and TWAS differ?" → must produce a `syntheses/` page if no current page covers it
- (12 more covering tool ingest, source vs wiki distinction, frontmatter completeness, duplicate avoidance)

Each synthetic case is `(user_prompt, expected_path_regex, expected_tags_subset)` — the **expected_path/tags come from the external spec, not the skill**. This is the deciding fix for the tautology problem.

**Secondary (realism sanity check, hand-included in PR): real prompts from session transcripts.**

`harvest.py` parses `data/sessions/telegram_vault-claw/.claude/projects/-workspace-group/*.jsonl`, extracts the first user message of each session that goes on to mention `98-nanoKB/wiki`. Picks the 3 most recent ones. These are NOT used in the optimization loop (too few for statistical signal), but the report runs baseline vs winning variant on them side-by-side, with the diff included in the PR for human reviewer judgment.

## Scoring: deterministic checks on sandbox-execution outputs

For each `(variant SKILL.md, prompt)` pair:

1. **`sandbox.run`**:
   - Create `/tmp/skill-evolve-{run-id}-{prompt-id}/scratch-vault/` mirroring the relevant `98-nanoKB/` folder structure (empty dirs: `wiki/syntheses/`, `wiki/tools/`, `wiki/papers/`, `wiki/concepts/`, `sources/`, `10-daily/meetings/`; copy current `wiki/index.md`).
   - Spawn `claude --print --append-system-prompt <(echo "$variant_SKILL_md")` with `cwd=scratch-vault` and the user prompt on stdin.
   - Capture all files created/modified under scratch-vault. Capture stderr.
   - Timeout 90s per case.
2. **`rubric.score`** evaluates 5 axes against `rubrics/wiki.yaml`. Each returns `(score: 0-1, feedback: str)`:
   - **Folder routing**: did the agent write to the expected folder? Score = path-match score against `expected_path_regex`. Feedback: "Expected `wiki/papers/`, got `wiki/syntheses/` — the prompt mentions a specific paper, which routes to `papers/` per global/CLAUDE.md."
   - **Frontmatter parse**: does the YAML frontmatter parse, contain all required keys, and have the required tag prefix `#wiki/<type>`?
   - **Tag set**: is the expected tag subset present?
   - **No duplicate collision**: did the agent create a new page when a matching index entry already exists?
   - **Body structure**: deterministic checks only — has `## Sources` section if `papers/`, has `## Related` section, no empty sections. (Body *quality* is explicitly NOT scored in v1; that's the unscoreable axis and it's better to be honest about that than to add an LLM-judge that calibrates against itself.)

Mean of 5 axes is the variant's score on that prompt. Variant's total score is mean across all 15 prompts.

## Deploy posture: PR-to-fork only

Hardcoded:

```python
# deploy.py
ALLOWED_REMOTES = {"git@github.com:mgandal/nanoclaw.git"}
TARGET_BRANCH = "main"
```

Per the `never-reference-upstream-prs` and `never-push-upstream` feedback memories (reviewer 2 verified `.git/config`: `origin = mgandal/nanoclaw`, `upstream = qwibitai/nanoclaw`). The deploy module **must** assert remote URL before push and refuse to operate against any non-mgandal remote. Hardcoded list, not env var.

Branch name: `skill-evolve/wiki-{run-id}` where `run-id = YYYYMMDD-HHMM-{sha8}` and `sha8` is the first 8 chars of `sha256(baseline_SKILL_md_bytes + seed)`. This pins the run to the exact baseline file content + RNG seed, so re-running with the same inputs is reproducible and distinguishable from runs against an updated baseline.

PR template includes mandatory sections (rendered by `report.py`):
1. **Eval-delta table**: per-axis score for baseline vs winner across all 15 synthetic prompts.
2. **Sample diff**: 3 hand-picked synthetic prompts where the variant beat baseline by ≥0.3 — show baseline output, variant output, axis-by-axis explanation.
3. **Realism check**: baseline vs variant on 3 real VAULT-claw prompts (from harvest). Side-by-side files written.
4. **Size delta**: bytes before/after. Hard fail at 15KB (PLAN.md guardrail).
5. **Semantic-preservation check**: a Claude call is given the baseline SKILL.md, the variant SKILL.md, and a fixed rubric: "Does the variant preserve all the procedures, folder rules, frontmatter requirements, and tag conventions of the baseline? Are any rules silently dropped or contradicted? Output a JSON score 1-5 and a list of any dropped/contradicted rules." Threshold ≥4/5 AND zero dropped rules. The judge prompt is checked into `scripts/skill-evolve/rubrics/semantic-preservation.md` so reviewers can see exactly what is asked.
6. **Rollback runbook**: one-line `git revert <merge-sha>` command + smoke test (re-run sandbox on 3 synthetic prompts).

## Credentials: route through OneCLI

Reviewer 2 corrected my draft: the canonical Python-helper pattern in this repo is **`ANTHROPIC_BASE_URL` pointing at OneCLI**, not `CLAUDE_CODE_OAUTH_TOKEN` directly. Reference: `scripts/paperpile-wiki/synthesizer.py:4`.

- All Claude calls (synthesize, mutate, semantic-preservation judge) go through OneCLI by setting `ANTHROPIC_BASE_URL` in the venv environment. The actual URL is read from the project `.env` (same key the live agent uses); no URL hardcoded in this spec or the codebase.
- Fixes R1's ToS concern: judge calls use the OneCLI metered API key, not the user's Claude Code subscription seat. The OAuth-token path is the secondary fallback only.
- Copy the credential-loading pattern from `synthesizer.py`; do not import (R2 hazard #5 — `paperpile-wiki/` is not a library).
- **Budget per run** (mutator returns all N variants in a single call):
  - 1 synthesizer call (generates 15 cases at once)
  - 1 mutator call (generates 5 variants at once)
  - 75 sandbox `claude --print` subprocess calls (5 variants × 15 cases)
  - 1 semantic-preservation judge call (on the winning variant only)
  - **Total: 3 large API calls + 75 sandbox subprocess calls. At Sonnet pricing, $3-10/run.**

## Sandbox isolation

Each evolve run gets `/tmp/skill-evolve-{run-id}/` (created by `sandbox.py` on first invocation, including a `home/` subdirectory for the subprocess `$HOME`):
- One `scratch-vault/` per prompt to prevent cross-prompt contamination.
- `claude --print` runs with `cwd=scratch-vault`, `CLAUDE_PROJECT_DIR=scratch-vault`, no inherited `.env` (subprocess env = explicit allowlist of `PATH`, `HOME=/tmp/skill-evolve-{run-id}/home`, `ANTHROPIC_BASE_URL`). Same restricted-env pattern as `scripts/pageindex/adapter.py`.
- Scratch vault is rmtree'd after each run; report.md keeps file diffs as text.

This protects the real vault at `/Volumes/sandisk4TB/marvin-vault/` from any harness bug.

## Error handling

| Failure | Detection | Response |
|---|---|---|
| `claude --print` timeout (>90s) | Subprocess timeout | Axis score = 0, feedback = "TIMEOUT", variant penalized but loop continues |
| `claude --print` non-zero exit | exit code | Same as timeout; report includes stderr |
| OneCLI unreachable | HTTPx error on first call | Hard fail entire run; do not silently fall through to OAuth token (R1 #1 ToS) |
| Variant exceeds 15KB | Size check pre-sandbox | Skip variant, log, continue (don't waste sandbox runs) |
| All variants score below baseline | After scoring | Write report, exit 0 with "no improvement", NO PR opened |
| Winning variant fails semantic-preservation | LLM-judge < 4/5 | Skip PR, log; report still written |
| Remote URL is not mgandal/nanoclaw | Pre-push check in deploy | Hard fail with clear error |
| Husky pre-commit hook fails on the deploy commit | git exit code | Hard fail; report saved, PR not opened, user must investigate |

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

- 9 Python modules listed above (~400 LOC total estimated; per-module ≤80 lines).
- 1 rubric YAML for wiki.
- `pyproject.toml`, `requirements.txt` (pinned), `README.md`.
- 7 unit-test files.
- Updated `scripts/CLAUDE.md` (if present) or root README pointer.

**Not in v1:** DSPy, GEPA, cron, launchd, IPC integration, multi-skill, tool-description optimization, A/B routing, auto-merge, code evolution.

## v2 hooks (deferred work)

The architecture leaves clean seams for:
1. **GEPA swap-in**: replace `mutate.py` with a `dspy.GEPA` or `gepa.optimize` call once we have data showing best-of-N plateaus. Rubric module already returns `(score, feedback)` matching `GEPAFeedbackMetric`.
2. **Multi-skill generalization**: CLI already takes `--skill <name>` and loads `rubrics/<name>.yaml`. Adding `qmd`/`paperpile` is mostly writing new rubric YAMLs.
3. **Tool-description optimization (PLAN.md Phase 2)**: swap `target_path` to `container/agent-runner/src/ipc-mcp-stdio.ts` tool descs; rubric becomes "did the agent pick the right tool for the prompt."
4. **Continuous loop (PLAN.md Phase 5)**: wrap `evolve.py` in a launchd plist on weekly cadence once Phase 1 has merged at least 3 winning variants without regression.

## Open questions deferred until after v1 ships

- **Real-prompt eval set growth**: 3 real prompts is enough for a realism check, not for optimization. If v1 shows the synthetic loop produces obviously good variants, we should harvest more transcripts and consider promoting real prompts to the optimization set in v2.
- **Body-structure scoring**: v1 explicitly does not score body quality (only structural sections). If v1 winners look correct on routing/frontmatter but produce mediocre bodies, v2 needs an LLM-judge axis with an external rubric (not derived from the skill itself).
- **Container hot-reload**: every evolve iteration that touches the real container would need a full respawn (R2 hazard #2). v1 sidesteps this by using `claude --print` outside the container. v2 may want a "real container shadow" mode for higher-fidelity scoring.
