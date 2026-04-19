# ppt-master — Library Probe & Integration Notes

**Upstream:** https://github.com/hugohe3/ppt-master (6,223 ⭐, 2026-04-18)
**Verdict:** STEAL — already installed as a Claude skill; wire into lab presentation workflow.
**Date probed:** 2026-04-19

## What it is

Multi-stage PPTX generator: source document (PDF / DOCX / URL / Markdown) →
multi-role pipeline (Strategist → Image_Generator → Executor) → natively editable
PPTX with real DrawingML shapes, not images.

Pipeline:
```
Source → Create Project → Template Option → Strategist Eight Confirmations
       → [Image_Generator] → Executor (SVG generation)
       → Post-processing → Export PPTX
```

## Probe findings

### Installation status

Already discoverable — `ppt-master` and `presenting-conference-talks` both appear in
the Skill tool catalog for this project. No additional install needed.

### Library access

**Not a Python library.** It's a workflow skill with invokable Python scripts living
alongside `SKILL.md` in its distribution. You drive it by:

1. Invoking the skill (`Skill ppt-master`)
2. The skill runs scripts in order — cannot be shortcut:
   - `source_to_md/pdf_to_md.py <file>` (convert)
   - `project_manager.py init <name> --format ppt169`
   - Strategist step (LLM-driven design spec, 8 confirmations, BLOCKING on user)
   - `image_gen.py` (optional)
   - Executor step: generates SVG pages sequentially in the main agent context
   - `finalize_svg.py <project>` → `svg_to_pptx.py <project> -s final`

### Hard constraints (from upstream AGENTS.md / SKILL.md)

- **Strict serial execution** — no step bundling, no parallelization
- **No sub-agent SVG generation** — must run in the main agent
- **No batched page generation** — pages generated one-by-one, sequentially
- **Eight Confirmations step BLOCKS** — user must approve design spec before SVG pass starts
- SVG constraints: no `<mask>`, `<style>`, `class`, `@font-face`, `<foreignObject>`,
  `textPath`, `<animate*>`, `<script>`, `<iframe>`

These constraints are strong and upstream-enforced. Trying to bypass them breaks the
pipeline, so our integration must respect them.

### Dependencies

From `requirements.txt`:
- `python-pptx>=0.6.21`
- `cairosvg` (preferred) or `svglib>=1.5.0` + `reportlab>=4.0.0`
- macOS: `brew install cairo`

## Lab integration plan

### Use cases

1. **Lab meeting slides** — drop markdown weekly-status summary → PPTX
2. **Grant progress reports** — convert NIH-style quarterly PDF into editable deck
3. **Conference talks** — can also use `presenting-conference-talks` (Beamer/PPTX from
   compiled paper) when the source is LaTeX-formatted; `ppt-master` better when source
   is markdown/prose

### Wiring

No new NanoClaw skill needed — both `ppt-master` and `presenting-conference-talks` are
already in the catalog. Two enablement steps:

1. **Mention in SCIENCE-claw CLAUDE.md** that these two skills exist and when to
   invoke each:
   - LaTeX/Overleaf compiled paper → `presenting-conference-talks`
   - Markdown summary, grant report, mixed source → `ppt-master`

2. **Verify system deps on the mac** before first use:
   ```bash
   brew install cairo          # for cairosvg (preferred over svglib)
   python3 -c "import pptx; import cairosvg; print('ok')"
   ```
   If it fails, install via: `pip install python-pptx cairosvg`.

### What NOT to build

- **Do not** wrap ppt-master as a NanoClaw `/make-pptx` skill. Upstream already ships
  the skill and its hard constraints would clash with a thin wrapper.
- **Do not** try to parallelize or batch SVG generation. Upstream forbids it and the
  pipeline is designed around the constraint.
- **Do not** attempt to call `svg_to_pptx.py` directly on arbitrary SVGs — the SVG
  constraints are enforced and failure mode is silent layout drift.

## Next steps

- [ ] Add a one-paragraph note to `groups/telegram_science-claw/CLAUDE.md` telling the
      SCIENCE-claw agent to use `ppt-master` for markdown-to-PPTX and
      `presenting-conference-talks` for LaTeX-to-PPTX
- [ ] First lab-meeting slide deck via `ppt-master` — confirm the end-to-end pipeline
      produces an editable PPTX on the mac before rolling out
- [ ] If cairosvg missing system-level, add to `/setup` skill or document under
      `docs/` as a dependency footnote
