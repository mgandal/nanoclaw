# Triage Labels

The skills speak in terms of five canonical triage **state** roles plus two
**category** roles. This file maps those roles to the actual label strings on
`mgandal/nanoclaw`.

## State roles

| Canonical role     | Label on our repo   | Meaning                                  |
| ------------------ | ------------------- | ---------------------------------------- |
| `needs-triage`     | `needs-triage`      | Maintainer needs to evaluate this issue  |
| `needs-info`       | `needs-info`        | Waiting on reporter for more information |
| `ready-for-agent`  | `ready-for-agent`   | Fully specified, ready for an AFK agent  |
| `ready-for-human`  | `ready-for-human`   | Requires human implementation            |
| `wontfix`          | `wontfix`           | Will not be actioned                     |

## Category roles

| Canonical role  | Label on our repo | Meaning                    |
| --------------- | ----------------- | -------------------------- |
| `bug`           | `bug`             | Something is broken        |
| `enhancement`   | `enhancement`     | New feature or improvement |

All seven labels exist on `mgandal/nanoclaw` (created / confirmed during
`/setup-matt-pocock-skills` on 2026-05-29). The mapping is 1:1 with the canonical
names — no overrides.

Every triaged issue should carry exactly one category label and one state label.
