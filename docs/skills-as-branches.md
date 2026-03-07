# Skills as Branches

## Overview

NanoClaw skills are distributed as git branches on the upstream repository. Applying a skill is a `git merge`. Updating core is a `git merge`. Everything is standard git.

This replaces the previous `skills-engine/` system (three-way file merging, `.nanoclaw/` state, manifest files, replay, backup/restore) with plain git operations and Claude for conflict resolution.

## How It Works

### Repository structure

The upstream repo (`qwibitai/nanoclaw`) maintains:

- `main` — core NanoClaw (no skill code)
- `skill/discord` — main + Discord integration
- `skill/telegram` — main + Telegram integration
- `skill/slack` — main + Slack integration
- `skill/gmail` — main + Gmail integration
- etc.

Each skill branch contains all the code changes for that skill: new files, modified source files, updated `package.json` dependencies, `.env.example` additions — everything. No manifest, no structured operations, no separate `add/` and `modify/` directories.

### Skill discovery via marketplace

SKILL.md files (setup instructions) live in a separate marketplace repo (`qwibitai/nanoclaw-skills`), not on `main`. Users discover and install skills through Claude Code's plugin marketplace system.

NanoClaw's `.claude/settings.json` includes:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

When users fork and clone NanoClaw, Claude Code automatically prompts them to add this marketplace. From there they can browse and install skills via `/plugin`.

The marketplace repo structure:

```
qwibitai/nanoclaw-skills/
  add-discord/
    skills/
      add-discord/
        SKILL.md          # Setup instructions; step 1 is "merge the branch"
  add-telegram/
    skills/
      add-telegram/
        SKILL.md
  add-slack/
    skills/
      add-slack/
        SKILL.md
  ...
```

Each SKILL.md tells Claude to merge the corresponding skill branch as step 1, then walks through interactive setup (env vars, bot creation, etc.).

### Applying a skill

User runs `/add-discord` (discovered via marketplace). Claude follows the SKILL.md:

1. `git fetch upstream skill/discord`
2. `git merge upstream/skill/discord`
3. Interactive setup (create bot, get token, configure env vars, etc.)

Or manually:

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
```

### Applying multiple skills

```bash
git merge upstream/skill/discord
git merge upstream/skill/telegram
```

Git handles the composition. If both skills modify the same lines, it's a real conflict and Claude resolves it.

### Updating core

```bash
git fetch upstream main
git merge upstream/main
```

Since skill branches are kept merged-forward with main (see CI section), the user's merged-in skill changes and upstream changes have proper common ancestors.

### Checking for skill updates

Users who previously merged a skill branch can check for updates. For each `upstream/skill/*` branch, check whether the branch has commits that aren't in the user's HEAD:

```bash
git fetch upstream
for branch in $(git branch -r | grep 'upstream/skill/'); do
  # Check if user has merged this skill at some point
  merge_base=$(git merge-base HEAD "$branch" 2>/dev/null) || continue
  # Check if the skill branch has new commits beyond what the user has
  if ! git merge-base --is-ancestor "$branch" HEAD 2>/dev/null; then
    echo "$branch has updates available"
  fi
done
```

This requires no state — it uses git history to determine which skills were previously merged and whether they have new commits.

This logic is available in two ways:
- Built into `/update-nanoclaw` — after merging main, optionally check for skill updates
- Standalone `/update-skills` — check and merge skill updates independently

### Conflict resolution

At any merge step, conflicts may arise. Claude resolves them — reading the conflicted files, understanding the intent of both sides, and producing the correct result. This is what makes the branch approach viable at scale: conflict resolution that previously required human judgment is now automated.

### Skill dependencies

Some skills depend on other skills. E.g., `skill/telegram-swarm` requires `skill/telegram`. Dependent skill branches are branched from their parent skill branch, not from `main`.

This means `skill/telegram-swarm` includes all of telegram's changes plus its own additions. When a user merges `skill/telegram-swarm`, they get both — no need to merge telegram separately.

The dependency graph is recorded in `skill-deps.yaml` in the upstream repo:

```yaml
skill/discord: main
skill/telegram: main
skill/telegram-swarm: skill/telegram
skill/slack: main
skill/gmail: main
```

### Uninstalling a skill

```bash
# Find the merge commit
git log --merges --oneline | grep discord

# Revert it
git revert -m 1 <merge-commit>
```

This creates a new commit that undoes the skill's changes. Claude can handle the whole flow.

If the user has modified the skill's code since merging (custom changes on top), the revert might conflict — Claude resolves it.

If the user later wants to re-apply the skill, they need to revert the revert first (git treats reverted changes as "already applied and undone"). Claude handles this too.

## CI: Keeping Skill Branches Current

A GitHub Action runs on every push to `main`:

1. Read `skill-deps.yaml` to get the dependency graph
2. Topological sort — process skills in dependency order
3. For each skill branch, merge its parent (`main` or another skill branch) into it (merge-forward, not rebase)
4. If conflicts arise, Claude (Haiku) resolves them automatically
5. Run tests on the merged result
6. If tests pass, push the updated skill branch
7. If a skill fails, skip its dependents and flag for review

**Why merge-forward instead of rebase:**
- No force-push — preserves history for users who already merged the skill
- Users can re-merge a skill branch to pick up skill updates (bug fixes, improvements)
- Git has proper common ancestors throughout the merge graph

**Why this scales:** With a few hundred skills and a few commits to main per day, the CI cost is trivial. Haiku is fast and cheap. The approach that wouldn't have been feasible a year or two ago is now practical because Claude can resolve conflicts at scale.

## Installation Flow

### New users (recommended)

1. Fork `qwibitai/nanoclaw` on GitHub (click the Fork button)
2. Clone your fork:
   ```bash
   git clone https://github.com/<you>/nanoclaw.git
   cd nanoclaw
   ```
3. Run Claude Code:
   ```bash
   claude
   ```
4. Run `/setup` — Claude handles dependencies, authentication, container setup, service configuration, and adds `upstream` remote if not present

Forking is recommended because it gives users a remote to push their customizations to. Clone-only works for trying things out but provides no remote backup.

### Existing users migrating from clone

Users who previously ran `git clone https://github.com/qwibitai/nanoclaw.git` and have local customizations:

1. Fork `qwibitai/nanoclaw` on GitHub
2. Reroute remotes:
   ```bash
   git remote rename origin upstream
   git remote add origin https://github.com/<you>/nanoclaw.git
   git push --force origin main
   ```
   The `--force` is needed because the fresh fork's main is at upstream's latest, but the user wants their (possibly behind) version. The fork was just created so there's nothing to lose.
3. From this point, `origin` = their fork, `upstream` = qwibitai/nanoclaw

### Existing users migrating from the old skills engine

Users who previously applied skills via the `skills-engine/` system have skill code in their tree but no merge commits linking to skill branches. Git doesn't know these changes came from a skill, so merging a skill branch on top would conflict or duplicate.

**For new skills going forward:** just merge skill branches as normal. No issue.

**For existing old-engine skills**, two migration paths:

**Option A: Per-skill reapply (keep your fork)**
1. For each old-engine skill: identify and revert the old changes, then merge the skill branch fresh
2. Claude assists with identifying what to revert and resolving any conflicts
3. Custom modifications (non-skill changes) are preserved

**Option B: Fresh start (cleanest)**
1. Create a new fork from upstream
2. Merge the skill branches you want
3. Manually re-apply your custom (non-skill) changes
4. Claude assists by diffing your old fork against the new one to identify custom changes

In both cases:
- Delete the `.nanoclaw/` directory (no longer needed)
- The `skills-engine/` code will be removed from upstream once all skills are migrated
- `/update-skills` only tracks skills applied via branch merge — old-engine skills won't appear in update checks

## User Workflows

### Custom changes

Users make custom changes directly on their main branch. This is the standard fork workflow — their `main` IS their customized version.

```bash
# Make changes
vim src/config.ts
git commit -am "change trigger word to @Bob"
git push origin main
```

Custom changes, skills, and core updates all coexist on their main branch. Git handles the three-way merging at each merge step because it can trace common ancestors through the merge history.

### Applying a skill

Run `/add-discord` in Claude Code (discovered via the marketplace plugin), or manually:

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
# Follow setup instructions for configuration
git push origin main
```

If the user is behind upstream's main when they merge a skill branch, the merge might bring in some core changes too (since skill branches are merged-forward with main). This is generally fine — they get a compatible version of everything.

### Updating core

```bash
git fetch upstream main
git merge upstream/main
git push origin main
```

This is the same as the existing `/update-nanoclaw` skill's merge path.

### Updating skills

Run `/update-skills` or let `/update-nanoclaw` check after a core update. For each previously-merged skill branch that has new commits, Claude offers to merge the updates.

### Contributing back to upstream

Users who want to submit a PR to upstream:

```bash
git fetch upstream main
git checkout -b my-fix upstream/main
# Make changes
git push origin my-fix
# Create PR from my-fix to qwibitai/nanoclaw:main
```

Standard fork contribution workflow. Their custom changes stay on their main and don't leak into the PR.

## Contributing a Skill

### Contributor flow

1. Fork `qwibitai/nanoclaw`
2. Branch from `main`
3. Make the code changes (new channel file, modified integration points, updated package.json, .env.example additions, etc.)
4. Open a PR to `main`

The contributor opens a normal PR — they don't need to know about skill branches or marketplace repos. They just make code changes and submit.

### Maintainer flow

When a skill PR is reviewed and approved:

1. Create a `skill/<name>` branch from the PR's commits:
   ```bash
   git fetch origin pull/<PR_NUMBER>/head:skill/<name>
   git push origin skill/<name>
   ```
2. Force-push to the contributor's PR branch, replacing it with a single commit that adds the contributor to `CONTRIBUTORS.md` (removing all code changes)
3. Merge the slimmed PR into `main` (just the contributor addition)
4. Add the skill's SKILL.md to the marketplace repo (`qwibitai/nanoclaw-skills`)

This way:
- The contributor gets merge credit (their PR is merged)
- They're added to CONTRIBUTORS.md automatically by the maintainer
- The skill branch is created from their work
- `main` stays clean (no skill code)
- The contributor only had to do one thing: open a PR with code changes

**Note:** GitHub PRs from forks have "Allow edits from maintainers" checked by default, so the maintainer can push to the contributor's PR branch.

### Skill SKILL.md

The contributor can optionally provide a SKILL.md (either in the PR or separately). This goes into the marketplace repo and contains:

1. Frontmatter (name, description, triggers)
2. Step 1: Merge the skill branch
3. Steps 2-N: Interactive setup (create bot, get token, configure env vars, verify)

If the contributor doesn't provide a SKILL.md, the maintainer writes one based on the PR.

## Community Marketplaces

Anyone can maintain their own fork with skill branches and their own marketplace repo. This enables a community-driven skill ecosystem without requiring write access to the upstream repo.

### How it works

A community contributor:

1. Maintains a fork of NanoClaw (e.g., `alice/nanoclaw`)
2. Creates `skill/*` branches on their fork with their custom skills
3. Creates a marketplace repo (e.g., `alice/nanoclaw-skills`) with SKILL.md files that point to their fork's branches

### Adding a community marketplace

If the community contributor is trusted, they can open a PR to add their marketplace to NanoClaw's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    },
    "alice-nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "alice/nanoclaw-skills"
      }
    }
  }
}
```

Once merged, all NanoClaw users automatically discover the community marketplace alongside the official one.

### Properties of this system

- **No gatekeeping required.** Anyone can create skills on their fork without permission. They only need approval to be listed in the auto-discovered marketplaces.
- **Multiple marketplaces coexist.** Users see skills from all trusted marketplaces in `/plugin`.
- **Community skills use the same merge pattern.** The SKILL.md just points to a different remote:
  ```bash
  git remote add alice https://github.com/alice/nanoclaw.git
  git fetch alice skill/my-cool-feature
  git merge alice/skill/my-cool-feature
  ```
- **Users can also add marketplaces manually.** Even without being listed in settings.json, users can run `/plugin marketplace add alice/nanoclaw-skills` to discover skills from any source.
- **CI is per-fork.** Each community maintainer runs their own CI to keep their skill branches merged-forward. They can use the same GitHub Action as the upstream repo.

## Flavors

A flavor is a curated fork of NanoClaw — a combination of skills, custom changes, and configuration tailored for a specific use case (e.g., "NanoClaw for Sales," "NanoClaw Minimal," "NanoClaw for Developers").

### Creating a flavor

1. Fork `qwibitai/nanoclaw`
2. Merge in the skills you want
3. Make custom changes (trigger word, prompts, integrations, etc.)
4. Your fork's `main` IS the flavor

### Installing a flavor

During `/setup`, users are offered a choice of flavors before any configuration happens. The setup skill reads `flavors.yaml` from the repo (shipped with upstream, always up to date) and presents options:

AskUserQuestion: "Start with a flavor or default NanoClaw?"
- Default NanoClaw
- NanoClaw for Sales — Gmail + Slack + CRM (maintained by alice)
- NanoClaw Minimal — Telegram-only, lightweight (maintained by bob)

If a flavor is chosen:

```bash
git remote add <flavor-name> https://github.com/alice/nanoclaw.git
git fetch <flavor-name> main
git merge <flavor-name>/main
```

Then setup continues normally (dependencies, auth, container, service).

**This choice is only offered on a fresh fork** — when the user's main matches or is close to upstream's main with no local commits. If `/setup` detects significant local changes (re-running setup on an existing install), it skips the flavor selection and goes straight to configuration.

After installation, the user's fork has three remotes:
- `origin` — their fork (push customizations here)
- `upstream` — `qwibitai/nanoclaw` (core updates)
- `<flavor-name>` — the flavor fork (flavor updates)

### Updating a flavor

```bash
git fetch <flavor-name> main
git merge <flavor-name>/main
```

The flavor maintainer keeps their fork updated (merging upstream, updating skills). Users pull flavor updates the same way they pull core updates.

### Flavors registry

`flavors.yaml` lives in the upstream repo:

```yaml
flavors:
  - name: NanoClaw for Sales
    repo: alice/nanoclaw
    description: Gmail + Slack + CRM integration, daily pipeline summaries
    maintainer: alice

  - name: NanoClaw Minimal
    repo: bob/nanoclaw
    description: Telegram-only, no container overhead
    maintainer: bob
```

Anyone can PR to add their flavor. The file is available locally when `/setup` runs since it's part of the cloned repo.

### Discoverability

- **During setup** — flavor selection is offered as part of the initial setup flow
- **`/browse-flavors` skill** — reads `flavors.yaml` and presents options at any time
- **GitHub topics** — flavor forks can tag themselves with `nanoclaw-flavor` for searchability
- **Discord / website** — community-curated lists

## Migration

The migration from the old skills engine to branches can be done gradually. The two systems coexist — old-format skills (with `add/`, `modify/`, manifest) continue to work alongside branch-based skills. Each skill is migrated independently.

### Phase 1: Infrastructure

Set up the new system without touching any existing skills.

1. Create the marketplace repo (`qwibitai/nanoclaw-skills`)
2. Add `extraKnownMarketplaces` to `.claude/settings.json`
3. Set up the CI GitHub Action for merge-forwarding skill branches
4. Add `flavors.yaml` (can start empty)
5. Update `/setup` to configure `upstream` remote and offer fork migration
6. Create `/update-skills` skill

At this point the new system is ready but has no skills in it. All existing skills continue to work via the old engine.

### Phase 2: Migrate one skill (proof of concept)

Pick a simple skill (e.g., add-discord) and migrate it end-to-end.

**Creating the skill branch:**

```bash
# Start from main
git checkout -b skill/discord main

# Apply the skill's file additions
cp .claude/skills/add-discord/add/src/channels/discord.ts src/channels/discord.ts
cp .claude/skills/add-discord/add/src/channels/discord.test.ts src/channels/discord.test.ts

# Apply the skill's file modifications
cp .claude/skills/add-discord/modify/src/index.ts src/index.ts
cp .claude/skills/add-discord/modify/src/config.ts src/config.ts

# Apply structured operations manually
# - Add discord.js to package.json
# - Add DISCORD_BOT_TOKEN and DISCORD_ONLY to .env.example

# Commit and push
git add -A
git commit -m "skill/discord: Discord channel integration"
git push origin skill/discord
```

Alternatively, this can be scripted — read each skill's manifest, apply the changes, commit, push.

**Creating the marketplace entry:**

Add a SKILL.md to the marketplace repo that instructs Claude to merge the branch and then walk through interactive setup.

**Cleaning up main:**

Remove the old skill's `add/` and `modify/` directories from main. The SKILL.md on main can be removed too (it now lives in the marketplace repo), or kept temporarily with a note pointing to the new system.

**Validate:**

- Verify the CI action successfully merges main into `skill/discord`
- Test applying the skill on a fresh fork via branch merge
- Verify `/update-skills` detects the branch

### Phase 3: Migrate remaining skills

Migrate remaining skills one at a time, in any order. Each migration follows the same pattern as Phase 2. This can be done over days or weeks — there's no pressure to do them all at once.

Existing skills on main:
- `add-discord`
- `add-telegram`
- `add-slack`
- `add-gmail`
- `add-voice-transcription`
- `add-telegram-swarm`
- `convert-to-apple-container`
- `x-integration`

### Phase 4: Remove the skills engine

Once all feature skills are migrated to branches:

1. Remove `skills-engine/` directory
2. Remove `scripts/apply-skill.ts`, `scripts/uninstall-skill.ts`, `scripts/fix-skill-drift.ts`, `scripts/validate-all-skills.ts`
3. Remove `.nanoclaw/` directory
4. Remove `add/` and `modify/` subdirectories from any remaining skill directories on main
5. Update README contributing guidelines

Core operational skills (`setup`, `debug`, `update-nanoclaw`, `customize`) remain on main in `.claude/skills/` — they don't have code changes and are just instruction files.

### Migration script (optional)

A script can automate the branch creation for each skill:

```bash
#!/bin/bash
# migrate-skill.sh <skill-name>
SKILL=$1
SKILL_DIR=".claude/skills/$SKILL"
MANIFEST="$SKILL_DIR/manifest.yaml"

# Create branch from main
git checkout -b "skill/$SKILL" main

# Copy added files
if [ -d "$SKILL_DIR/add" ]; then
  cp -r "$SKILL_DIR/add/"* .
fi

# Copy modified files
if [ -d "$SKILL_DIR/modify" ]; then
  cp -r "$SKILL_DIR/modify/"* .
fi

# Apply npm dependencies from manifest (requires yq or similar)
# Apply env additions from manifest
# Run npm install

git add -A
git commit -m "skill/$SKILL: initial branch creation"
git push origin "skill/$SKILL"
git checkout main
```

This is a starting point — each skill may need manual adjustments (e.g., resolving differences between the modify files and current main).

## What Changes

### README Quick Start

Before:
```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
claude
```

After:
```
1. Fork qwibitai/nanoclaw on GitHub
2. git clone https://github.com/<you>/nanoclaw.git
3. cd nanoclaw
4. claude
5. /setup
```

### Setup skill (`/setup`)

Add a step early in setup:

- Check if `upstream` remote exists
- If not, add it: `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- Check if `origin` points to the user's fork (not qwibitai). If it points to qwibitai, guide them through the fork migration.

### `.claude/settings.json`

Add marketplace configuration so users automatically discover the skills marketplace:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

### Skills directory on main

The `.claude/skills/` directory on `main` retains only core operational skills (setup, debug, update-nanoclaw, customize). All feature skills (add-discord, add-telegram, etc.) move to the marketplace repo.

### Skills engine removal

The following can be removed:

- `skills-engine/` — entire directory (apply, merge, replay, state, backup, etc.)
- `scripts/apply-skill.ts`
- `scripts/uninstall-skill.ts`
- `scripts/fix-skill-drift.ts`
- `scripts/validate-all-skills.ts`
- `.nanoclaw/` — state directory
- `add/` and `modify/` subdirectories from all skill directories

### New infrastructure

- **Marketplace repo** (`qwibitai/nanoclaw-skills`) — contains SKILL.md files for each skill
- **CI GitHub Action** — merge-forward `main` into all `skill/*` branches on every push to `main`, using Claude (Haiku) for conflict resolution
- **`/update-skills` skill** — checks for and applies skill branch updates using git history
- **`CONTRIBUTORS.md`** — tracks skill contributors

### Update skill (`/update-nanoclaw`)

The update skill gets simpler with the branch-based approach. The old skills engine required replaying all applied skills after merging core updates — that entire step disappears. Skill changes are already in the user's git history, so `git merge upstream/main` just works.

**What stays the same:**
- Preflight (clean working tree, upstream remote)
- Backup branch + tag
- Preview (git log, git diff, file buckets)
- Merge/cherry-pick/rebase options
- Conflict preview (dry-run merge)
- Conflict resolution
- Build + test validation
- Rollback instructions

**What's removed:**
- Skill replay step (was needed by the old skills engine to re-apply skills after core update)
- Re-running structured operations (npm deps, env vars — these are part of git history now)

**What's added:**
- Optional step at the end: "Check for skill updates?" which runs the `/update-skills` logic
- This checks whether any previously-merged skill branches have new commits (bug fixes, improvements to the skill itself — not just merge-forwards from main)

**Why users don't need to re-merge skills after a core update:**
When the user merged a skill branch, those changes became part of their git history. When they later merge `upstream/main`, git performs a normal three-way merge — the skill changes in their tree are untouched, and only core changes are brought in. The merge-forward CI ensures skill branches stay compatible with latest main, but that's for new users applying the skill fresh. Existing users who already merged the skill don't need to do anything.

Users only need to re-merge a skill branch if the skill itself was updated (not just merged-forward with main). The `/update-skills` check detects this.

## Discord Announcement

### For existing users

> **Skills are now git branches**
>
> We've simplified how skills work in NanoClaw. Instead of a custom skills engine, skills are now git branches that you merge in.
>
> **What this means for you:**
> - Applying a skill: `git fetch upstream skill/discord && git merge upstream/skill/discord`
> - Updating core: `git fetch upstream main && git merge upstream/main`
> - Checking for skill updates: `/update-skills`
> - No more `.nanoclaw/` state directory or skills engine
>
> **We now recommend forking instead of cloning.** This gives you a remote to push your customizations to.
>
> **If you currently have a clone with local changes**, migrate to a fork:
> 1. Fork `qwibitai/nanoclaw` on GitHub
> 2. Run:
>    ```
>    git remote rename origin upstream
>    git remote add origin https://github.com/<you>/nanoclaw.git
>    git push --force origin main
>    ```
>    This works even if you're way behind — just push your current state.
>
> **If you previously applied skills via the old system**, your code changes are already in your working tree — nothing to redo. You can delete the `.nanoclaw/` directory. Future skills and updates use the branch-based approach.
>
> **Discovering skills:** Skills are now available through Claude Code's plugin marketplace. Run `/plugin` in Claude Code to browse and install available skills.

### For skill contributors

> **Contributing skills**
>
> To contribute a skill:
> 1. Fork `qwibitai/nanoclaw`
> 2. Branch from `main` and make your code changes
> 3. Open a regular PR
>
> That's it. We'll create a `skill/<name>` branch from your PR, add you to CONTRIBUTORS.md, and add the SKILL.md to the marketplace. CI automatically keeps skill branches merged-forward with `main` using Claude to resolve any conflicts.
>
> **Want to run your own skill marketplace?** Maintain skill branches on your fork and create a marketplace repo. Open a PR to add it to NanoClaw's auto-discovered marketplaces — or users can add it manually via `/plugin marketplace add`.
