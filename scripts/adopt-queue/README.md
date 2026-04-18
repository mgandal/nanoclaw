# adopt-queue

Host-side runner and installer for the `/queue-adopt` Telegram command.

See `docs/superpowers/specs/2026-04-18-adopt-queue-design.md` for the full design.

## Setup

1. Add the mount-allowlist entry (see spec).
2. Run `./install.sh` from this directory.
3. From Telegram CLAIRE group, ask Claire to re-register CODE-claw with the printed payload.

## Usage

- `adopt-queue.sh list` — pending + recently archived items
- `adopt-queue.sh show <id>` — full plan for one item
- `adopt-queue.sh clone <id>` — git clone the repo to `~/src/adopt/<repo>`
- `adopt-queue.sh done <id>` — archive an item
