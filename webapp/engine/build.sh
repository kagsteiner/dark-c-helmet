#!/bin/sh
# Builds the WebAssembly modules into webapp/public/engine/:
#   dh-engine.js/.wasm      search engine, multi-threaded (needs cross-origin isolation)
#   dh-engine-st.js/.wasm   search engine, single-threaded fallback
#   dh-rules.js/.wasm       chess rules for the UI (no search, no net)
#   dh-human.js/.wasm       human-like opponent (human/, single-threaded, own nets)
# Needs emcc (Emscripten) on PATH. Run from anywhere.
set -e

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC="$ROOT/src"
OUT="$ROOT/webapp/public/engine"
mkdir -p "$OUT"

# Same version string as the native Makefile build.
GIT_COUNT=$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 0)
GIT_HASH=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)
GIT_DIRTY=$(git -C "$ROOT" diff --quiet HEAD -- src 2>/dev/null || echo +)
VERSION="build $GIT_COUNT$GIT_DIRTY ($GIT_HASH $(date '+%Y-%m-%d %H:%M'))"

CFLAGS="-O3 -flto -msimd128 -std=c11 -Wall -Wextra"
ENGINE_SRCS="$SRC/bitboard.c $SRC/datagen.c $SRC/eval.c $SRC/movegen.c $SRC/nnue.c $SRC/nnue_net.c
    $SRC/perft.c $SRC/position.c $SRC/search.c $SRC/tt.c $SRC/uci.c $ROOT/webapp/engine/wasm_io.c"
COMMON="-sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker -sEXIT_RUNTIME=0
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=8MB
    -sEXPORTED_RUNTIME_METHODS=ccall"
ENGINE_EXPORTS="-sEXPORTED_FUNCTIONS=_main,_wasm_send,_wasm_pump -sEXPORT_NAME=createEngine"

echo "engine (threads)"
# shellcheck disable=SC2086
emcc $CFLAGS -pthread -DENGINE_VERSION="\"$VERSION\"" $ENGINE_SRCS $COMMON $ENGINE_EXPORTS \
    -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency \
    -sINITIAL_MEMORY=192MB -o "$OUT/dh-engine.js"

echo "engine (single thread)"
# shellcheck disable=SC2086
emcc $CFLAGS -DENGINE_VERSION="\"$VERSION\"" $ENGINE_SRCS $COMMON $ENGINE_EXPORTS \
    -sINITIAL_MEMORY=128MB -o "$OUT/dh-engine-st.js"

echo "rules"
# shellcheck disable=SC2086
emcc $CFLAGS -I"$SRC" "$ROOT/webapp/engine/rules_api.c" "$SRC/bitboard.c" "$SRC/position.c" \
    "$SRC/movegen.c" "$SRC/eval.c" "$SRC/perft.c" $COMMON \
    -sEXPORTED_FUNCTIONS=_rules_init,_rules_set_fen,_rules_fen,_rules_play,_rules_undo,_rules_state,_rules_in_check,_rules_moves,_rules_perft,_rules_hanging,_rules_null_fen \
    -sEXPORT_NAME=createRules -o "$OUT/dh-rules.js"

echo "human player"
HUMAN="$ROOT/human"
# shellcheck disable=SC2086
emcc $CFLAGS -I"$SRC" -DENGINE_VERSION="\"$VERSION\"" "$HUMAN/huci.c" "$HUMAN/hsearch.c" "$HUMAN/hnet.c" \
    "$HUMAN/hnet_data.c" "$HUMAN/board_stubs.c" "$SRC/bitboard.c" "$SRC/position.c" "$SRC/movegen.c" "$SRC/eval.c" \
    "$ROOT/webapp/engine/wasm_io.c" $COMMON $ENGINE_EXPORTS -sINITIAL_MEMORY=64MB -o "$OUT/dh-human.js"

ls -l "$OUT"
