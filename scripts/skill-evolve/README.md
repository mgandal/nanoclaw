# skill-evolve

Best-of-N optimizer for NanoClaw container SKILL.md files. v1 targets `container/skills/wiki/SKILL.md`.

## Run

```bash
cd scripts/skill-evolve
venv/bin/python -m skill_evolve --skill wiki --num-variants 5 --max-budget 40
```

## What it does

1. Calibrates noise floor (runs baseline twice)
2. Generates N candidate variants via Claude mutator
3. Scores each variant by sandbox-executing `claude --print` against `/tmp` scratch vaults
4. Picks winner if it beats `max(0.3, 3 × noise_floor)` over baseline
5. Opens `gh pr create --draft --repo mgandal/nanoclaw` with diff + report

## Operator-authored files

Before first run, write:
- `rubrics/wiki-golden.yaml` — 5+ prompts with hand-pinned `expected_path_regex` and `expected_tags_subset`
- `rubrics/wiki-adversarial.yaml` — 5+ prompts where routing is non-obvious from prompt nouns

## Maintenance

Quarterly: `venv/bin/pip install -U -r requirements.txt && venv/bin/pytest` to catch SDK drift.

## Spec

See `docs/specs/2026-05-23-skill-evolve-gepa-design.md`.
