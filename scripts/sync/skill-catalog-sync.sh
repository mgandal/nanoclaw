#!/usr/bin/env bash
# Generates data/skill-catalog/*.md from .claude/skills/*/SKILL.md
# Run as part of sync-all.sh (before QMD update so entries are indexed same cycle)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILLS_DIR="$PROJECT_DIR/.claude/skills"
CATALOG_DIR="$PROJECT_DIR/data/skill-catalog"

mkdir -p "$CATALOG_DIR"

COUNT=0
SKIPPED=0

for skill_md in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$skill_md" ] || continue

  # Extract name and description from YAML frontmatter
  name=$(sed -n '/^---$/,/^---$/{ /^name:/{ s/^name: *//; s/^"//; s/"$//; p; }; }' "$skill_md")
  description=$(sed -n '/^---$/,/^---$/{ /^description:/{ s/^description: *//; s/^"//; s/"$//; p; }; }' "$skill_md")

  if [ -z "$name" ]; then
    echo "  SKIP: $skill_md (no name in frontmatter)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Body = everything after the closing --- of frontmatter
  body=$(sed '1,/^---$/d; 1,/^---$/d' "$skill_md")

  # Generate install command from name
  install_command="/$name"

  # Write catalog entry
  cat > "$CATALOG_DIR/${name}.md" <<ENTRY
---
name: ${name}
description: ${description}
installed: true
install_command: "${install_command}"
---

${body}
ENTRY

  COUNT=$((COUNT + 1))
done

echo "  Skill catalog: $COUNT entries written, $SKIPPED skipped"
