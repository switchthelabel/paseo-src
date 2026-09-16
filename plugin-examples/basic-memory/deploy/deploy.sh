#!/usr/bin/env bash
# Deploy the plugin to its stable host path and install the paseo-memory skill.
# Run from anywhere: paths resolve relative to this script.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/home/ubuntu/paseo-plugins/basic-memory

rsync -a --delete --exclude node_modules --exclude .git "$SRC/" "$DEST/"

for d in ~/.agents/skills ~/.claude/skills ~/.codex/skills; do
  mkdir -p "$d/paseo-memory"
  cp "$SRC/deploy/skill.md" "$d/paseo-memory/SKILL.md"
done

echo "Deployed plugin to $DEST"
echo "Installed paseo-memory skill to ~/.agents/skills, ~/.claude/skills, ~/.codex/skills"

if paseo plugin reload basic-memory 2>/dev/null; then
  echo "Reloaded basic-memory plugin"
else
  echo "Plugin not installed yet; run: paseo plugin install $DEST"
fi
