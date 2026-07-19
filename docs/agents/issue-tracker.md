# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on **`mgandal/nanoclaw`** (the
`origin` remote). Use the `gh` CLI for all operations.

> **Scope rule (load-bearing):** always pass `--repo mgandal/nanoclaw` explicitly.
> This clone has several remotes — `upstream`, `telegram`, `slack`, `gmail` — that
> point at the `qwibitai` / `nanocoai` forks. Those are READ-ONLY to us and there is
> a standing rule never to push, PR, comment on, or otherwise write to them. `gh`'s
> default-repo resolution has pointed at the upstream fork before; pinning `--repo`
> prevents writes from silently landing on the wrong repo (they 404, since we lack
> write access there).

## Conventions

- **Create an issue**: `gh issue create --repo mgandal/nanoclaw --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo mgandal/nanoclaw --comments`, also fetching labels.
- **List issues**: `gh issue list --repo mgandal/nanoclaw --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` / `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo mgandal/nanoclaw --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo mgandal/nanoclaw --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo mgandal/nanoclaw --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `mgandal/nanoclaw`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo mgandal/nanoclaw --comments`.
