#!/bin/bash
#
# push.sh — stage, commit, and push 5Dice to GitHub, and deploy Firebase
# database rules when they changed.
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

# --- firebase rules ----------------------------------------------------------
# Pushing to GitHub does NOT update the live database security rules. If
# database.rules.json differs from the last push, deploy it with the Firebase
# CLI — or warn loudly when the CLI isn't available.

deploy_rules_if_changed() {
  local changed
  changed=$( (git status --porcelain database.rules.json; git diff --name-only "origin/$BRANCH"..HEAD -- database.rules.json 2>/dev/null) | grep -c . || true)
  if [ "$changed" -eq 0 ]; then
    return 0
  fi
  if command -v firebase >/dev/null 2>&1; then
    echo "database.rules.json changed — deploying database rules..."
    if firebase deploy --only database; then
      echo "✓ Database rules deployed."
    else
      echo "⚠ firebase deploy failed. The LIVE rules are NOT updated — run 'firebase deploy --only database' manually."
    fi
  else
    echo "⚠ database.rules.json changed but the Firebase CLI is not installed."
    echo "  The LIVE database rules are NOT updated by a git push!"
    echo "  Install it (npm i -g firebase-tools), then run: firebase deploy --only database"
  fi
}

deploy_rules_if_changed

# --- anything to do? ---------------------------------------------------------

if [ -z "$(git status --porcelain)" ]; then
  echo "✓ Nothing to commit — working tree is clean."
  if [ -n "$(git log "origin/$BRANCH"..HEAD --oneline 2>/dev/null)" ]; then
    echo "  Local commits are ahead of GitHub — pushing..."
    git pull --rebase origin "$BRANCH"
    git push origin "$BRANCH"
  else
    echo "  Nothing to push either — GitHub is up to date."
  fi
  exit 0
fi

# --- show what's about to go up ----------------------------------------------

echo "Changes to be pushed:"
git status --short
echo

MESSAGE="${1:-Update $(date '+%Y-%m-%d %H:%M')}"

# --- stage, commit, pull --rebase, push --------------------------------------

git add -A
git commit -m "$MESSAGE"

# Integrate any remote commits first so the push can't be rejected.
git pull --rebase origin "$BRANCH"

echo
echo "Pushing to $(git remote get-url origin) ($BRANCH)..."
git push origin "$BRANCH"

echo
echo "✓ Pushed: $MESSAGE"
