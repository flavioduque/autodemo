#!/usr/bin/env bash
set -euo pipefail
REPO_NAME="${1:-demomotion-mcp}"
VISIBILITY="${2:-public}"
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Run gh auth login first." >&2
  exit 1
fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init
  git add .
  git commit -m "feat: initial DemoMotion MCP release"
  git branch -M main
fi
gh repo create "$REPO_NAME" --"$VISIBILITY" --source=. --remote=origin --push
