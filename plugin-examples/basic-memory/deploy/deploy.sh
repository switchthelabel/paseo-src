#!/usr/bin/env bash
# Deploy the plugin to its stable host path and install the paseo-memory skill.
# Run from anywhere: paths resolve relative to this script.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/home/ubuntu/paseo-plugins/basic-memory

# Dependencies stay out of the rsync: npm ci installs them in the deployed
# directory from the rsynced lockfile. The daemon's compiler resolves
# type-only imports such as @getpaseo/protocol/agent-types from there.
rsync -a --delete --exclude node_modules --exclude .git "$SRC/" "$DEST/"
if [ ! -d "$DEST/node_modules" ]; then
  npm ci --prefix "$DEST" --silent
fi

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
