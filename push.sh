#!/bin/bash
#
# push.sh — stage, commit, and push 5Dice to GitHub.
#
#   ./push.sh                    -> commits with a timestamp message
#   ./push.sh "your message"     -> commits with your message
#
# Repo: https://github.com/JefParker/5Dice.git (branch: main)

set -euo pipefail

# Always run from the folder this script lives in, whatever directory you call it from.
cd "$(dirname "$0")"

BRANCH="main"

# --- sanity checks -----------------------------------------------------------

if [ ! -d .git ]; then
  echo "✗ No .git folder here. Is this the 5Dice project folder?"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "✗ No 'origin' remote configured."
  exit 1
fi

# --- anything to do? ---------------------------------------------------------

if [ -z "$(git status --porcelain)" ]; then
  echo "✓ Nothing to commit — working tree is clean."
  echo "  Pushing anyway in case local commits are ahead of GitHub..."
  git push origin "$BRANCH"
  exit 0
fi

# --- show what's about to go up ----------------------------------------------

echo "Changes to be pushed:"
git status --short
echo

MESSAGE="${1:-Update $(date '+%Y-%m-%d %H:%M')}"

# --- stage, commit, push -----------------------------------------------------

git add -A
git commit -m "$MESSAGE"

echo
echo "Pushing to $(git remote get-url origin) ($BRANCH)..."
git push origin "$BRANCH"

echo
echo "✓ Pushed: $MESSAGE"
