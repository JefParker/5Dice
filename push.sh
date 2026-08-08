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
  # The admin uid is pinned in the rules, and the Dashboard is where you read
  # that uid off — so blocking the code push here would be a deadlock. Skip the
  # RULES deploy and let the code go: deploy the app, sign in, copy the uid from
  # the Dashboard header, paste it in, push again.
  if grep -q 'PASTE_ADMIN_UID_HERE' database.rules.json; then
    echo "⚠ database.rules.json still contains PASTE_ADMIN_UID_HERE — rules NOT deployed."
    echo "  Deploying it as-is would pin root read to a uid that matches nobody and lock"
    echo "  the Dashboard out of its own database."
    echo
    echo "  The code will still be pushed, so you can bootstrap: once this deploy is live,"
    echo "  sign in to the Dashboard and the header prints the uid beside your email."
    echo "  Paste it over both placeholders, then run ./push.sh again to deploy the rules."
    echo
    echo "  Until then the OLD rules stay live, including the loose root read."
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

# --- asset version sanity ----------------------------------------------------
# app.js's version lives in three places: the ?v= in index.html, the precache
# entry in sw.js, and the window.__appJsVersion stamp inside app.js itself (the
# stale-cache tripwire compares the first and the third at runtime). They have
# drifted before, which silently breaks offline. Catch it here instead.

check_app_version() {
  local in_html in_sw in_js
  in_html=$(grep -o 'app\.js?v=[0-9]\+' index.html | head -1 | grep -o '[0-9]\+' || true)
  in_sw=$(grep -o "app\.js?v=[0-9]\+" sw.js | head -1 | grep -o '[0-9]\+' || true)
  in_js=$(grep -o 'window\.__appJsVersion *= *[0-9]\+' app.js | grep -o '[0-9]\+' || true)

  if [ -z "$in_html" ] || [ -z "$in_sw" ] || [ -z "$in_js" ]; then
    echo "⚠ Could not read an app.js version from index.html / sw.js / app.js — skipping the check."
    return 0
  fi
  if [ "$in_html" != "$in_sw" ] || [ "$in_html" != "$in_js" ]; then
    echo "✗ app.js version mismatch:"
    echo "    index.html            v$in_html"
    echo "    sw.js precache        v$in_sw"
    echo "    window.__appJsVersion v$in_js"
    echo "  All three must agree, or offline breaks and the stale-cache tripwire misfires."
    echo "  Nothing was pushed."
    exit 1
  fi
  echo "✓ app.js v$in_html consistent across index.html, sw.js, and app.js."
}

check_app_version

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
