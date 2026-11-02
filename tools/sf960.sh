#!/usr/bin/env bash
# Chess960 yardstick: our engine against Stockfish with time odds.
#
#   tools/sf960.sh [engine]          (default bin/darkhelmet)
#
# Stockfish gets 1/ODDS of our time control, so the match stays near 50% and every
# new build or net gets an absolute Chess960 number against the same fixed opponent.
#
# Options (environment variables):
#   ODDS=8           Stockfish's time is TC divided by this
#   TC=20+0.2        our time control (seconds+increment)
#   GAMES=200        number of games (pairs per opening, colors reversed)
#   CONCURRENCY=8    games played in parallel
#   HASH=64          hash size (MB) for both engines
#   VARIANT=fischerandom   standard chess: VARIANT=standard BOOK=tools/books/random8.epd
#   STOCKFISH=...    path to the Stockfish binary
#   OUT=...          output folder (default tools/games/sf960/<engine>-odds<ODDS>-<stamp>)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_ARG="${1:-$ROOT/bin/darkhelmet}"
ENGINE="$(cd "$(dirname "$ENGINE_ARG")" && pwd)/$(basename "$ENGINE_ARG")"
ODDS="${ODDS:-8}"
TC="${TC:-20+0.2}"
GAMES="${GAMES:-200}"
CONCURRENCY="${CONCURRENCY:-8}"
HASH="${HASH:-64}"
VARIANT="${VARIANT:-fischerandom}"
BOOK="${BOOK:-$ROOT/tools/books/frc960.epd}"
BOOK="$(cd "$(dirname "$BOOK")" && pwd)/$(basename "$BOOK")"
STOCKFISH="${STOCKFISH:-$(command -v stockfish)}"
FASTCHESS="${FASTCHESS:-$ROOT/../fastchess/fastchess}"

base="${TC%+*}"
inc="${TC#*+}"
SF_TC="$(awk -v b="$base" -v i="$inc" -v o="$ODDS" 'BEGIN { printf "%g+%g", b / o, i / o }')"
NAME="$(basename "$ENGINE")"
OUT="${OUT:-$ROOT/tools/games/sf960/$NAME-odds$ODDS-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

ARGS=(
  -engine "cmd=$ENGINE" "name=$NAME" "tc=$TC" option.Threads=1
  -engine "cmd=$STOCKFISH" "name=Stockfish-odds$ODDS" "tc=$SF_TC" option.Threads=1
  -each proto=uci "option.Hash=$HASH"
  -openings "file=$BOOK" format=epd order=random
  -repeat -games 2 -rounds $((GAMES / 2))
  -concurrency "$CONCURRENCY"
  -recover
  -ratinginterval 20
  -pgnout "file=$OUT/games.pgn"
)
[[ "$VARIANT" != "standard" ]] && ARGS=(-variant "$VARIANT" "${ARGS[@]}")

echo "$NAME ($TC) vs Stockfish ($SF_TC), $VARIANT, $GAMES games -> $OUT"
# fastchess writes its resume file (config.json) into the working directory.
cd "$OUT"
exec "$FASTCHESS" "${ARGS[@]}"
