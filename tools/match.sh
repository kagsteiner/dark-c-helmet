#!/usr/bin/env bash
# Engine-vs-engine testing with fastchess.
#
#   tools/match.sh <new-engine> <base-engine> [options]
#
# Options (environment variables):
#   TC=10+0.1        time control (seconds+increment)
#   GAMES=1000       number of games (pairs of games per opening, colors reversed)
#   CONCURRENCY=8    games played in parallel
#   SPRT=1           run an SPRT test instead of a fixed number of games
#   ELO0=0 ELO1=5    SPRT hypotheses (use ELO0=-5 ELO1=0 for "no regression" tests)
#   HASH=16          hash size (MB) for both engines
#   FASTCHESS=...    path to the fastchess binary
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NEW="$(cd "$(dirname "${1:?usage: match.sh <new-engine> <base-engine>}")" && pwd)/$(basename "$1")"
BASE="$(cd "$(dirname "${2:?usage: match.sh <new-engine> <base-engine>}")" && pwd)/$(basename "$2")"
TC="${TC:-10+0.1}"
GAMES="${GAMES:-1000}"
CONCURRENCY="${CONCURRENCY:-8}"
HASH="${HASH:-16}"
FASTCHESS="${FASTCHESS:-$ROOT/../fastchess/fastchess}"
BOOK="${BOOK:-$ROOT/tools/books/random8.epd}"
OUT="$ROOT/tools/games"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"

ARGS=(
  -engine "cmd=$NEW" "name=$(basename "$NEW")"
  -engine "cmd=$BASE" "name=$(basename "$BASE")-base"
  -each proto=uci "tc=$TC" "option.Hash=$HASH"
  -openings "file=$BOOK" format=epd order=random
  -repeat -games 2 -rounds $((GAMES / 2))
  -concurrency "$CONCURRENCY"
  -recover
  -ratinginterval 50
  -pgnout "file=$OUT/$STAMP.pgn"
)
if [[ "${SPRT:-0}" == "1" ]]; then
  ARGS+=(-sprt "elo0=${ELO0:-0}" "elo1=${ELO1:-5}" alpha=0.05 beta=0.05)
fi

# fastchess writes its resume file (config.json) into the working directory.
cd "$OUT"
exec "$FASTCHESS" "${ARGS[@]}"
