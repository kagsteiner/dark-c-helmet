#!/usr/bin/env bash
# Unattended NNUE round: self-play data generation -> training -> engine builds -> SPRT.
# Nothing is merged; results are written to $OUT/SUMMARY.txt.
#
#   tools/nnue/pipeline.sh <round-name> [older data files...]
#
# Environment (defaults in brackets):
#   PROCS [17]            datagen processes
#   GAMES [55000]         games per datagen process
#   NODES [5000]          nodes per move in self-play
#   DATAGEN_HOURS [5]     hard deadline for data generation
#   EPOCHS [20]           training epochs
#   SPRT_MINUTES [90]     time limit for the SPRT stage
#
# Run under caffeinate so the Mac does not sleep, e.g.
#   caffeinate -ims tools/nnue/pipeline.sh v4 data/v3/selfplay_*.txt
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ROUND="${1:?usage: pipeline.sh <round-name> [older data files...]}"
shift
OLD_DATA=("$@")
PROCS="${PROCS:-17}"
GAMES="${GAMES:-55000}"
NODES="${NODES:-5000}"
DATAGEN_HOURS="${DATAGEN_HOURS:-5}"
EPOCHS="${EPOCHS:-20}"
SPRT_MINUTES="${SPRT_MINUTES:-90}"
OUT="data/$ROUND"
SUMMARY="$OUT/SUMMARY.txt"
mkdir -p "$OUT" data/nnue

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$SUMMARY"; }

# Wait for a list of PIDs, killing them at a deadline (seconds since epoch).
wait_until() {
  local deadline=$1; shift
  local pids=("$@")
  while :; do
    local alive=0
    for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
    [[ $alive == 0 ]] && return 0
    if (( $(date +%s) >= deadline )); then
      log "deadline reached, stopping remaining processes"
      for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
      sleep 5
      return 1
    fi
    sleep 30
  done
}

log "=== NNUE round $ROUND: $PROCS procs x $GAMES games, $NODES nodes/move ==="

# ---------------------------------------------------------------- 1. data
make >/dev/null 2>&1 || { log "engine build failed"; exit 1; }
cp bin/darkhelmet "bin/datagen-$ROUND"
cp bin/darkhelmet "bin/base-$ROUND"
pids=()
for i in $(seq 1 "$PROCS"); do
  "./bin/datagen-$ROUND" datagen "$GAMES" "$NODES" $((RANDOM * 100 + i)) "$OUT/selfplay_$i.txt" 2>"$OUT/datagen_$i.log" &
  pids+=($!)
done
wait_until $(( $(date +%s) + DATAGEN_HOURS * 3600 )) "${pids[@]}"
positions=$(cat "$OUT"/selfplay_*.txt | wc -l | tr -d ' ')
log "data generation done: $positions new positions"

# ---------------------------------------------------------------- 2. training
cc -O3 -march=native -std=c11 -o bin/nnue-trainer tools/nnue/trainer.c -lm -lpthread
cc -O3 -march=native -std=c11 -DHIDDEN=512 -o bin/nnue-trainer-512 tools/nnue/trainer.c -lm -lpthread
./bin/nnue-trainer convert "data/nnue/train_$ROUND.bin" "${OLD_DATA[@]}" "$OUT"/selfplay_*.txt 2>>"$SUMMARY"
for h in 256 512; do
  trainer=./bin/nnue-trainer; [[ $h == 512 ]] && trainer=./bin/nnue-trainer-512
  $trainer train "data/nnue/train_$ROUND.bin" "data/nnue/net_${ROUND}_$h.nnue" "$EPOCHS" 0.001 0.75 \
    > "$OUT/train_$h.log" 2>&1
  log "net $h: $(tail -1 "$OUT/train_$h.log")"
done

# ---------------------------------------------------------------- 3. builds
build() {  # build <hidden> <net> <exe>
  python3 tools/nnue/embed.py "$2" >/dev/null
  local flags="-O3 -march=native -flto -Wall -Wextra -Wpedantic -std=c11"
  [[ $1 == 512 ]] && flags="$flags -DNNUE_HIDDEN=512"
  make EXE="$3" CFLAGS="$flags" >/dev/null 2>&1
  git checkout -q src/nnue_net.c
}
build 256 "data/nnue/net_${ROUND}_256.nnue" "bin/nnue_${ROUND}_256"
build 512 "data/nnue/net_${ROUND}_512.nnue" "bin/nnue_${ROUND}_512"
for h in 256 512; do
  log "engine $h bench: $("./bin/nnue_${ROUND}_$h" bench 12 | tail -1)"
done

# ---------------------------------------------------------------- 4. SPRT vs current engine
sprt_pids=()
for h in 256 512; do
  SPRT=1 ELO1=5 GAMES=20000 TC=8+0.08 CONCURRENCY=8 \
    tools/match.sh "bin/nnue_${ROUND}_$h" "bin/base-$ROUND" > "$OUT/sprt_$h.log" 2>&1 &
  sprt_pids+=($!)
done
wait_until $(( $(date +%s) + SPRT_MINUTES * 60 )) "${sprt_pids[@]}"
pkill -f "fastchess/fastchess" 2>/dev/null
for h in 256 512; do
  log "SPRT net $h vs current: $(grep -aE 'Elo:' "$OUT/sprt_$h.log" | tail -1)"
  log "                        $(grep -aE 'Games:' "$OUT/sprt_$h.log" | tail -1)"
  log "                        $(grep -aE 'LLR|accepted' "$OUT/sprt_$h.log" | tail -1)"
done
log "=== round $ROUND finished ==="
