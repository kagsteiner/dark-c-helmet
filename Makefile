# Builds the engine (src/).
CC ?= cc
EXE ?= bin/darkhelmet
CFLAGS ?= -O3 -march=native -flto -Wall -Wextra -Wpedantic -std=c11
SRCS = $(wildcard src/*.c)

# Version shown to the GUI ("id name"): running commit count, "+" for uncommitted changes
# in src/, short hash and build time. Kept separate from CFLAGS so overriding CFLAGS keeps it.
GIT_COUNT := $(shell git rev-list --count HEAD 2>/dev/null || echo 0)
GIT_HASH  := $(shell git rev-parse --short HEAD 2>/dev/null || echo nogit)
GIT_DIRTY := $(shell git diff --quiet HEAD -- src 2>/dev/null || echo +)
BUILD_TIME = $(shell date '+%Y-%m-%d %H:%M')
VERSION_DEF = -DENGINE_VERSION='"build $(GIT_COUNT)$(GIT_DIRTY) ($(GIT_HASH) $(BUILD_TIME))"'

all: $(EXE)

$(EXE): $(SRCS) $(wildcard src/*.h)
	@mkdir -p $(dir $(EXE))
	$(CC) $(CFLAGS) $(VERSION_DEF) -o $(EXE) $(SRCS) -lm -lpthread

# Texel tuner (hand-crafted eval), see tools/tune/tuner.c
tuner: tools/tune/tuner.c $(wildcard src/*.c) $(wildcard src/*.h)
	@mkdir -p bin
	$(CC) -O3 -march=native -std=c11 -DTUNE -Isrc -o bin/tuner tools/tune/tuner.c \
		src/bitboard.c src/position.c src/movegen.c src/eval.c -lm -lpthread

# Profile-guided build (clang): an instrumented binary runs `bench 14`, the recorded profile
# guides inlining and branch layout of the final bin/darkhelmet. Same moves, ~3% faster.
PROFDATA ?= $(shell xcrun -f llvm-profdata 2>/dev/null || command -v llvm-profdata)
PGO_DIR = bin/pgo
pgo: $(SRCS) $(wildcard src/*.h)
	@mkdir -p $(PGO_DIR) $(dir $(EXE))
	@rm -f $(PGO_DIR)/*.profraw $(PGO_DIR)/darkhelmet.profdata
	$(CC) $(CFLAGS) $(VERSION_DEF) -fprofile-instr-generate -o $(PGO_DIR)/darkhelmet-gen $(SRCS) -lm -lpthread
	LLVM_PROFILE_FILE=$(PGO_DIR)/run-%p.profraw $(PGO_DIR)/darkhelmet-gen bench 14 > /dev/null
	$(PROFDATA) merge -o $(PGO_DIR)/darkhelmet.profdata $(PGO_DIR)/*.profraw
	$(CC) $(CFLAGS) $(VERSION_DEF) -fprofile-instr-use=$(PGO_DIR)/darkhelmet.profdata -o $(EXE) $(SRCS) -lm -lpthread

# Engine with the search constants of src/tune.h exposed as UCI options (for tools/spsa)
spsa: $(SRCS) $(wildcard src/*.h)
	@mkdir -p bin
	$(CC) $(CFLAGS) -DSPSA $(VERSION_DEF) -o bin/darkhelmet-spsa $(SRCS) -lm -lpthread

# Human-like player (human/, see human/README.md). Uses the board code of src/ but none of
# its search or net, so the main engine is unaffected.
HUMAN_BOARD = src/bitboard.c src/position.c src/movegen.c src/eval.c human/board_stubs.c
human-tools: human/convert.c human/train.c human/hnet.h $(HUMAN_BOARD)
	@mkdir -p bin
	$(CC) -O3 -march=native -std=c11 -Wall -Wextra -Isrc -o bin/human-convert human/convert.c $(HUMAN_BOARD) -lm
	$(CC) -O3 -march=native -std=c11 -Wall -Wextra -Isrc -DACCELERATE_NEW_LAPACK -o bin/human-train human/train.c -framework Accelerate -lm -lpthread

human: $(wildcard human/*.c) $(wildcard human/*.h) $(HUMAN_BOARD)
	@mkdir -p bin
	$(CC) -O3 -march=native -std=c11 -Wall -Wextra -Isrc $(VERSION_DEF) -o bin/humanplayer \
		human/hnet.c human/hsearch.c human/huci.c human/hnet_data.c $(HUMAN_BOARD) -lm

clean:
	rm -f $(EXE)

.PHONY: all clean tuner spsa pgo human human-tools
