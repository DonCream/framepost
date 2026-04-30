#!/bin/bash
# backup.sh - auto-commit and push FramePost changes to GitHub
# Run via cron every N minutes. Commits only when there are actual changes.
#
# Cron suggestion (every 15 min):
#   */15 * * * * /home/doncreamy/framepost/backup.sh >> /home/doncreamy/framepost/.backup.log 2>&1

set -e

# Always run from the repo directory regardless of cron's cwd
cd "$(dirname "$0")"

# Bail if not a git repo yet
if [ ! -d .git ]; then
  echo "[$(date)] Not a git repo, skipping" >&2
  exit 0
fi

# Stage everything (respects .gitignore)
git add -A

# If nothing changed, exit silently
if git diff --cached --quiet; then
  exit 0
fi

# Build a commit message that summarizes what changed
SUMMARY=$(git diff --cached --shortstat)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

git commit -m "auto-backup: ${TIMESTAMP}" -m "${SUMMARY}" >/dev/null

# Push, but don't fail loudly if no network — try again next run
if git push 2>&1; then
  echo "[$(date)] pushed: ${SUMMARY}"
else
  echo "[$(date)] push failed, will retry next run" >&2
fi
