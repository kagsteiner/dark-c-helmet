#!/usr/bin/env bash
# Test feature branches one after another against the current branch (SPRT, 8+0.08) and merge
# each one that passes, so later candidates are tested on top of earlier gains.
#
#   tools/sprt_queue.sh <branch> [<branch> ...]
#
# Options (environment variables):
#   ELO0=0 ELO1=5    SPRT bounds (ELO0=-5 ELO1=0 for a no-regression test)
#   MERGE=1          0: only test and report, merge nothing (e.g. to compare two candidates)
#   FRC_GAMES=2000   Chess960 match (fixed games) for every branch that passes the SPRT;
#                    a clear loss (Elo + error < -10) blocks the merge. 0 skips it.
#
# Run it with a clean working tree. bin/darkhelmet is only rebuilt (make pgo) after a merge.
# Results are appended to data/sprt_queue.log.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="data/sprt_queue.log"
TEST_TREE="$ROOT/../$(basename "$ROOT")-sprt"
ELO0="${ELO0:-0}" ELO1="${ELO1:-5}" MERGE="${MERGE:-1}" FRC_GAMES="${FRC_GAMES:-2000}"
mkdir -p data
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
bench() { "$1" bench | tail -1 | cut -d' ' -f1; }

for branch in "$@"; do
  name="${branch//\//_}"
  log "=== $branch (SPRT [$ELO0, $ELO1], merge=$MERGE) ==="
  make EXE=bin/queue-base >/dev/null 2>&1 || { log "build of base failed"; exit 1; }
  log "base: $(git rev-parse --short HEAD), bench $(bench bin/queue-base)"

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
  cp bin/queue-cand "bin/cand-$name"
  log "candidate bench $(bench bin/queue-cand) (kept as bin/cand-$name)"

  SPRT=1 ELO0="$ELO0" ELO1="$ELO1" GAMES=60000 TC=8+0.08 CONCURRENCY=16 tools/match.sh bin/queue-cand bin/queue-base \
    > "data/sprt_$name.log" 2>&1
  elo=$(grep -aE 'Elo:' "data/sprt_$name.log" | tail -1)
  games=$(grep -aE 'Games:' "data/sprt_$name.log" | tail -1)
  verdict=$(grep -aE 'accepted' "data/sprt_$name.log" | tail -1)
  log "$elo"
  log "$games"
  log "$verdict"
  [[ "$verdict" == *"H1 was accepted"* ]] || { log "not merged"; continue; }

  frc=""
  if [[ "$FRC_GAMES" != "0" ]]; then
    VARIANT=fischerandom BOOK="$ROOT/tools/books/frc960.epd" GAMES="$FRC_GAMES" TC=8+0.08 CONCURRENCY=16 \
      tools/match.sh bin/queue-cand bin/queue-base > "data/frc_$name.log" 2>&1
    frc=$(grep -aE 'Elo:' "data/frc_$name.log" | tail -1)
    log "Chess960 ($FRC_GAMES games): $frc"
    if [[ -z "$frc" ]]; then
      log "Chess960 check did not run (see data/frc_$name.log), not merged"
      continue
    fi
    if awk -v l="$frc" 'BEGIN { split(l, a, " "); exit !(a[2] + a[4] < -10) }'; then
      log "Chess960 clear loss, not merged"
      continue
    fi
  fi

  if [[ "$MERGE" == "1" ]]; then
    git merge -q --no-edit -m "Merge $branch: $elo (SPRT [$ELO0,$ELO1] accepted, ${games#Games: })

Chess960: ${frc:-not run}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" "$branch"
    make pgo >/dev/null 2>&1
    log "merged $branch -> $(git rev-parse --short HEAD), bench $(bench bin/darkhelmet)"
  else
    log "passed, not merged (MERGE=0)"
  fi
done
log "=== queue finished ==="
