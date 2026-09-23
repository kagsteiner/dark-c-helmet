# Builds the new engine (src/). The old reference engine is engine_c.c.
CC ?= cc
EXE ?= bin/darkhelmet
CFLAGS ?= -O3 -march=native -flto -Wall -Wextra -Wpedantic -std=c11
SRCS = $(wildcard src/*.c)

all: $(EXE)

$(EXE): $(SRCS) $(wildcard src/*.h)
	@mkdir -p $(dir $(EXE))
	$(CC) $(CFLAGS) -o $(EXE) $(SRCS) -lm -lpthread

reference: engine_c.c
	@mkdir -p bin
	$(CC) -O3 -o bin/reference engine_c.c

# Texel tuner (hand-crafted eval), see tools/tune/tuner.c
tuner: tools/tune/tuner.c $(wildcard src/*.c) $(wildcard src/*.h)
	@mkdir -p bin
	$(CC) -O3 -march=native -std=c11 -DTUNE -Isrc -o bin/tuner tools/tune/tuner.c \
		src/bitboard.c src/position.c src/movegen.c src/eval.c -lm -lpthread

clean:
	rm -f $(EXE)

.PHONY: all clean reference tuner
