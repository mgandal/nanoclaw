# Context Engineering — Vendored Reference Material

Design-rubric documents from [muratcankoylan/Agent-Skills-for-Context-Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering), kept as reference material for architecture decisions.

Not wired as activatable Claude Code skills — these are design-time docs the humans (and occasionally an agent during deep planning) consult, not runtime skill files. See `docs/context-engineering/README.md:provenance` for how to refresh.

## Contents

| File | When to consult |
|------|-----------------|
| [tool-design.md](tool-design.md) | Before adding or changing an MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`. Five-criterion rubric for tool descriptions; Vercel 17→2 consolidation case study. |
| [multi-agent-patterns.md](multi-agent-patterns.md) | When evolving the swarm architecture (pool bots, lead/specialist split). Supervisor / P2P / hierarchical taxonomy; 15× token-cost multiplier for budgeting. |
| [filesystem-context.md](filesystem-context.md) | When deciding what to persist in vault vs `hot.md` vs agent `memory.md` vs QMD. Four-mode context-failure taxonomy (missing / under-retrieved / over-retrieved / buried). |
| [memory-systems.md](memory-systems.md) | Active input to `docs/agent-architecture-redesign.md`. Five-layer memory ladder (working → short-term → long-term → entity → temporal KG); LoCoMo / DMR benchmark tables for Honcho / Hindsight / Mem0 / Zep / Cognee tradeoffs. |

## Why vendor instead of `/plugin install`

The upstream repo ships 14 skills as a Claude Code plugin. We cherry-picked 4 because the other 10 either (a) overlap existing Claude priors (`context-fundamentals`, `context-degradation`, `evaluation`), (b) target a different runtime (`hosted-agents` assumes Modal), or (c) are premature for our architecture (`latent-briefing`, `bdi-mental-states`). Installing the full plugin would pollute skill activation and compete with our `superpowers:*` routing.

## Provenance

- **Source:** `https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering`
- **Upstream SHA at vendor time:** `7a95d94c364e25c869a86896a45791dfda6db8bf` (2026-04-14)
- **Vendored:** 2026-04-19
- **License:** MIT

## Refreshing

Run `/eval-repo https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering` every 3-6 months (or when you notice upstream has added a skill that solves a pain point you're actively hitting). If the rubrics in the 4 files have changed meaningfully, re-vendor by overwriting. Bump the SHA above.

```bash
for s in tool-design multi-agent-patterns filesystem-context memory-systems; do
  curl -sL "https://raw.githubusercontent.com/muratcankoylan/Agent-Skills-for-Context-Engineering/main/skills/$s/SKILL.md" \
    -o "docs/context-engineering/$s.md"
done
```
