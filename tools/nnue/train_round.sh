#!/usr/bin/env bash
# Train and test candidate networks on existing self-play data (no data generation).
#
#   tools/nnue/train_round.sh <round-name> <data.txt files...>
#
# Candidates (all 512 hidden, 8 output buckets):
#   plain  - no king buckets (like net v4)
#   kb8    - 8 king buckets with mirroring
# Each is trained, built into an engine and SPRT-tested against the current bin/darkhelmet.
# Nothing is merged; results go to data/<round>/SUMMARY.txt.
#
# Environment: EPOCHS [12], SPRT_MINUTES [120], CANDIDATES ["plain kb8"]
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ROUND="${1:?usage: train_round.sh <round-name> <data files...>}"
shift
EPOCHS="${EPOCHS:-12}"
SPRT_MINUTES="${SPRT_MINUTES:-120}"
CANDIDATES="${CANDIDATES:-plain kb8}"
OUT="data/$ROUND"
SUMMARY="$OUT/SUMMARY.txt"
mkdir -p "$OUT" data/nnue

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$SUMMARY"; }

kb_of() { [[ $1 == plain ]] && echo 1 || echo "${1#kb}"; }

log "=== training round $ROUND: candidates $CANDIDATES, $EPOCHS epochs ==="
make >/dev/null 2>&1 || { log "engine build failed"; exit 1; }
cp bin/darkhelmet "bin/base-$ROUND"

for c in $CANDIDATES; do
  cc -O3 -march=native -std=c11 -DHIDDEN=512 -DKING_BUCKETS="$(kb_of "$c")" \
     -o "bin/nnue-trainer-$c" tools/nnue/trainer.c -lm -lpthread
done

if [[ ! -f "$OUT/train.bin" ]]; then
  first=${CANDIDATES%% *}
  "./bin/nnue-trainer-$first" convert "$OUT/train.bin" "$@" 2>>"$SUMMARY"
fi

for c in $CANDIDATES; do
  "./bin/nnue-trainer-$c" train "$OUT/train.bin" "data/nnue/net_${ROUND}_$c.nnue" "$EPOCHS" 0.001 0.75 \
    > "$OUT/train_$c.log" 2>&1
  log "net $c: $(tail -1 "$OUT/train_$c.log")"
  python3 tools/nnue/embed.py "data/nnue/net_${ROUND}_$c.nnue" >/dev/null
  make EXE="bin/nnue_${ROUND}_$c" >/dev/null 2>&1
  git checkout -q src/nnue_net.c
  log "engine $c bench: $("./bin/nnue_${ROUND}_$c" bench 12 | tail -1)"
done

pids=()
n=$(echo $CANDIDATES | wc -w | tr -d ' ')
conc=$(( 16 / n ))
for c in $CANDIDATES; do
  SPRT=1 ELO1=5 GAMES=20000 TC=8+0.08 CONCURRENCY=$conc \
    tools/match.sh "bin/nnue_${ROUND}_$c" "bin/base-$ROUND" > "$OUT/sprt_$c.log" 2>&1 &
  pids+=($!)
done
deadline=$(( $(date +%s) + SPRT_MINUTES * 60 ))
while :; do
  alive=0
  for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
  [[ $alive == 0 ]] && break
  if (( $(date +%s) >= deadline )); then log "SPRT time limit reached"; pkill -f "fastchess/fastchess"; sleep 5; break; fi
  sleep 30
done
for c in $CANDIDATES; do
  log "SPRT $c vs current: $(grep -aE 'Elo:' "$OUT/sprt_$c.log" | tail -1)"
  log "                    $(grep -aE 'Games:' "$OUT/sprt_$c.log" | tail -1)"
  log "                    $(grep -aE 'LLR|accepted' "$OUT/sprt_$c.log" | tail -1)"
done
log "=== training round $ROUND finished ==="
