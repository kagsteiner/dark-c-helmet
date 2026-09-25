#!/usr/bin/env bash
# Test feature branches one after another against the current branch (SPRT [0,5], 8+0.08)
# and merge each one that passes, so later candidates are tested on top of earlier gains.
#
#   tools/sprt_queue.sh <branch> [<branch> ...]
#
# Run it on the integration branch (e.g. strength-improvements) with a clean working tree.
# Results are appended to data/sprt_queue.log.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="data/sprt_queue.log"
TEST_TREE="$ROOT/../$(basename "$ROOT")-sprt"
mkdir -p data
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

for branch in "$@"; do
  log "=== $branch ==="
  make >/dev/null 2>&1 || { log "build of base failed"; exit 1; }
  cp bin/darkhelmet bin/queue-base
  log "base: $(git rev-parse --short HEAD), bench $(./bin/queue-base bench | tail -1 | cut -d' ' -f1)"

  # Candidate = current branch + feature branch, built in a separate worktree.
  rm -rf "$TEST_TREE"; git worktree prune
  git worktree add -q --detach "$TEST_TREE" HEAD
  if ! (cd "$TEST_TREE" && git merge -q --no-edit "$branch" >/dev/null 2>&1); then
    log "merge conflict with $branch, skipped"
    git worktree remove --force "$TEST_TREE"
    continue
  fi
  (cd "$TEST_TREE" && make EXE="$ROOT/bin/queue-cand" >/dev/null 2>&1) || { log "candidate build failed"; git worktree remove --force "$TEST_TREE"; continue; }
  git worktree remove --force "$TEST_TREE"
  log "candidate bench $(./bin/queue-cand bench | tail -1 | cut -d' ' -f1)"

  SPRT=1 GAMES=60000 TC=8+0.08 CONCURRENCY=16 tools/match.sh bin/queue-cand bin/queue-base \
    > "data/sprt_${branch//\//_}.log" 2>&1
  elo=$(grep -aE 'Elo:' "data/sprt_${branch//\//_}.log" | tail -1)
  games=$(grep -aE 'Games:' "data/sprt_${branch//\//_}.log" | tail -1)
  verdict=$(grep -aE 'accepted' "data/sprt_${branch//\//_}.log" | tail -1)
  log "$elo"
  log "$games"
  log "$verdict"

  if [[ "$verdict" == *"H1 was accepted"* ]]; then
    git merge -q --no-edit -m "Merge $branch: $elo (SPRT [0,5] accepted, ${games#Games: })

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" "$branch"
    make >/dev/null 2>&1
    log "merged $branch -> $(git rev-parse --short HEAD), bench $(./bin/darkhelmet bench | tail -1 | cut -d' ' -f1)"
  else
    log "not merged"
  fi
done
log "=== queue finished ==="
