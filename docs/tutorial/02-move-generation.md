# Chapter 2 — Move generation, legality, make/unmake, hashing and perft

> **Files:** [`src/types.h`](../../src/types.h), [`src/movegen.c`](../../src/movegen.c),
> [`src/position.c`](../../src/position.c), [`src/perft.c`](../../src/perft.c),
> [`tools/perft_suite.py`](../../tools/perft_suite.py)

Chapter 1 gave us fast answers to "which squares does this piece attack?". This chapter
turns that into moves, and — just as important — into a *correct* board that can go forward
and backward millions of times per second without ever drifting out of sync. Everything
the search does later rests on this layer, and its bugs are the nastiest kind: an engine
with a move-generation bug does not crash, it just plays slightly strange chess once in a
few thousand games.

## 2.1 Encoding a move in 16 bits

[`src/types.h:43`](../../src/types.h#L43):

```
 bits 15..12   11..6   5..0
      flags     to     from
```

```c
static inline Move make_move(int from, int to, int flags) { return from | (to << 6) | (flags << 12); }
static inline int move_from(Move m)       { return m & 63; }
static inline int move_to(Move m)         { return (m >> 6) & 63; }
static inline int move_is_capture(Move m) { return (m >> 12) & FLAG_CAPTURE; }   // flag bit 2
static inline int move_is_promo(Move m)   { return (m >> 12) & FLAG_PROMO; }     // flag bit 3
```

The four flag bits follow a well-known scheme (from the Chess Programming Wiki):

| flags | meaning | flags | meaning |
|---|---|---|---|
| 0 | quiet move | 8–11 | promotion to N, B, R, Q |
| 1 | double pawn push | 12–15 | promotion **with capture** to N, B, R, Q |
| 2, 3 | castling (king side, queen side) | | |
| 4 | capture | | |
| 5 | en passant capture | | |

Why bother, when the old engine happily used a `struct { int from, to, promo, flags, score; }`
of 20 bytes?

* **The transposition table stores a move per entry** (chapter 3). Two bytes instead of
  twenty is the difference between 5 entries per cache line and 1.
* **Moves become integers.** Comparing `m == tt_move` or `m == killer` is one instruction,
  and a move can index a table (`history[from][to]`).
* **The flags answer the important questions without looking at the board**: "is this a
  capture?", "is this a promotion?". The move carries its own meaning.

What the move does *not* store is the moving or captured piece — those are read from the
board when needed, and the captured piece is remembered in the state stack (2.5).

## 2.2 Pseudo-legal generation, split by type

A move is **pseudo-legal** if it obeys the piece's movement rules, and **legal** if in
addition it does not leave the own king in check. There are two classic strategies:

1. Generate pseudo-legal moves, *make* each one, test "is my king attacked?", *unmake*.
   This is what the old engine did for every single move, before searching any of them.
2. Generate pseudo-legal moves and check legality with a cheap test **only when the move is
   actually about to be searched**.

We use the second. The key insight is that the search usually *does not look at most
moves*: a good move ordering (chapter 5) finds a refutation early, the node is cut off,
and the remaining moves are never needed. Checking their legality in advance is wasted work.

Moves are generated in two groups ([`src/movegen.c:86`](../../src/movegen.c#L86)):

```c
enum { GEN_NOISY = 1, GEN_QUIET = 2, GEN_ALL = 3 };
void generate_moves(const Position* pos, MoveList* list, int type);
```

* **Noisy** = captures, en passant and **queen** promotions — the moves that change the
  material balance.
* **Quiet** = everything else, *including all under-promotions* (to knight, bishop, rook).

The split exists because the quiescence search (chapter 3) only looks at noisy moves: at the
end of the main search, it resolves captures so that the evaluation is not taken in the
middle of an exchange. Under-promotions are classified as quiet on purpose — they almost
never matter tactically, and including them would blow up the quiescence search.

The heart of piece-move generation is one loop for all non-pawn pieces:

```c
Bitboard targets = 0;
if (type & GEN_NOISY) targets |= pos->by_color[them];   // captures
if (type & GEN_QUIET) targets |= ~pos->occupied;        // moves to empty squares

for (int pt = KNIGHT; pt <= KING; ++pt) {
    Bitboard pieces = pieces_of(pos, us, pt);
    while (pieces) {
        int from = pop_lsb(&pieces);
        Bitboard attacks = piece_attacks(pt, from, pos->occupied) & targets;
        while (attacks) {
            int to = pop_lsb(&attacks);
            add(list, from, to, pos->board[to] != NO_PIECE ? FLAG_CAPTURE : FLAG_QUIET);
        }
    }
}
```

Notice that "only captures" and "only quiet moves" are not two code paths, just two
different `targets` masks. Pawns get their own function with the set-wise shifts from
chapter 1.

### Castling

Castling is the move with the most conditions ([`src/movegen.c:64`](../../src/movegen.c#L64)).
For white king side:

```c
if ((rights & WHITE_OO)                                  // right not lost yet
    && !(occ & (BB(F1) | BB(G1)))                        // f1 and g1 empty
    && !square_attacked(pos, F1, them, occ)              // king does not pass through check
    && !square_attacked(pos, G1, them, occ))             // ... or land in check
    add(list, E1, G1, FLAG_KING_CASTLE);
```

plus "not currently in check", tested once before. Because the generator already checks
every condition, the later legality test can accept castling moves as they are. Queen side
is the classic trap: **b1 must be empty, but it may be attacked** — the king never crosses
it.

## 2.3 The legality test

[`src/position.c:385`](../../src/position.c#L385) decides "does this pseudo-legal move leave
my king safe?" without making the move. It uses two pieces of information computed after
every move (chapter 1, section 1.8): `checkers` (enemy pieces giving check) and `pinned`
(own pieces pinned to the king).

```c
int pos_is_legal(const Position* pos, Move m) {
    // 1. En passant: remove both pawns, add ours on the target, and look again.
    if (flags == FLAG_EP) {
        Bitboard occ = (pos->occupied ^ BB(from) ^ BB(cap_sq)) | BB(to);
        return !(attackers_to(pos, ksq, occ) & their_pieces & ~BB(cap_sq));
    }
    // 2. King moves: is the destination attacked? (King removed from the occupancy!)
    if (from == ksq)
        return is_castle(m) || !square_attacked(pos, to, them, pos->occupied ^ BB(from));

    // 3. In check: a double check allows only king moves; a single check must be
    //    captured or blocked.
    if (checkers) {
        if (more_than_one(checkers)) return 0;
        if (!((BETWEEN_BB[ksq][lsb(checkers)] | checkers) & BB(to))) return 0;
    }
    // 4. A pinned piece may only move along the line through king and pinner.
    if (pinned & BB(from)) return (LINE_BB[from][ksq] & BB(to)) != 0;
    return 1;
}
```

For the common case — a non-king move by an unpinned piece when not in check — this is two
bit tests. Each branch encodes a real chess rule:

* **Why is en passant special?** Because it removes *two* pieces from the same rank. In this
  position, white's `exd6` en passant would be illegal although the e5 pawn is not pinned in
  the usual sense:

  ```
  8 . . . . . . . .
  7 . . . . . . . .
  6 . . . . . . . .
  5 K . . p P . . r      after ...d7-d5: exd6 e.p. removes d5 AND e5 from rank 5,
  4 . . . . . . . .      and the rook on h5 suddenly attacks the king on a5.
  ```

  No pin logic catches that, so en passant simply recomputes the attackers with the modified
  occupancy. This case is a famous perft trap (position 3 of the standard suite contains it).
* **Why remove the king from the occupancy in step 2?** Otherwise a king in check from a
  rook on the same rank would "block" the rook's ray with its own body and conclude that
  stepping one square away along the rank is safe.

## 2.4 The position state and make/unmake

A move changes the board, but also a surprising amount of *state*: castling rights, the
en-passant square, the 50-move counter, the hash key, the incremental evaluation, the
checkers and pinned pieces. The old engine stored an "undo record" and restored each field
by hand. We use a **state stack** ([`src/position.h`](../../src/position.h)):

```c
typedef struct {
    uint64_t key, pawn_key;       // Zobrist hashes of the whole position / pawns only
    int castling, ep_sq, rule50, plies_from_null;
    int captured;                 // what the move that led here captured
    Move move;                    // the move that led here
    Bitboard checkers, pinned;
    int psq_mg, psq_eg, phase;    // incremental evaluation terms
    DirtyPieces dirty;            // which pieces moved (for NNUE, chapter 7)
} State;

typedef struct {
    ...bitboards and board[64]...
    State states[MAX_GAME_PLY + MAX_PLY + 8];
    State* st;                    // current state
} Position;
```

`pos_make_move` ([`src/position.c:247`](../../src/position.c#L247)) **copies** the current
state to the next slot and modifies the copy; `pos_unmake_move` moves the pieces back and
simply **decrements the pointer**:

```c
void pos_make_move(Position* pos, Move m) {
    State* prev = pos->st;
    State* st = prev + 1;
    *st = *prev;                  // start from the old state
    pos->st = st;
    ... move pieces, update st->key, st->castling, st->ep_sq, ...
}

void pos_unmake_move(Position* pos, Move m) {
    ... move the pieces back (the only thing that is not in the state) ...
    pos->st--;                    // every other field is restored for free
}
```

This design has three advantages over hand-written undo records:

1. **Unmake cannot forget a field.** Everything in `State` is restored by the pointer
   decrement. Adding a new incrementally-updated value later (we did: the NNUE dirty-piece
   list) needs no unmake code at all.
2. **The history is free.** `states[]` *is* the list of all previous positions, which is
   exactly what repetition detection needs (2.7).
3. **The search can read the parent state**, e.g. "what did the opponent just capture?".

### Castling rights with one mask

Castling rights change when the king or a rook moves, *or when a rook is captured on its
home square*. Instead of special cases, one table does it
([`src/position.c:35`](../../src/position.c#L35)):

```c
CASTLE_MASK[A1] = ~WHITE_OOO;   CASTLE_MASK[H1] = ~WHITE_OO;   CASTLE_MASK[E1] = ~(WHITE_OO | WHITE_OOO);
CASTLE_MASK[A8] = ~BLACK_OOO;   CASTLE_MASK[H8] = ~BLACK_OO;   CASTLE_MASK[E8] = ~(BLACK_OO | BLACK_OOO);
// all other squares: 15 (keep everything)

st->castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
```

Any move *from or to* a1 kills white's queen-side right — which covers "the rook moved"
and "the rook was captured" in one line. Forgetting the capture case is a classic bug that
perft finds.

### The en-passant square, stored only when it matters

After a double pawn push the en-passant square is recorded **only if an enemy pawn can
actually capture there** ([`src/position.c:298`](../../src/position.c#L298)):

```c
int ep = (from + to) / 2;
if (PAWN_ATTACKS[us][ep] & pieces_of(pos, them, PAWN)) {
    st->ep_sq = ep;
    st->key ^= ZOBRIST_EP[file_of(ep)];
}
```

This looks like a detail, but it matters for hashing: otherwise `1.e4 Nf6 2.Nf3 Ng8 3.Ng1`
would reach the starting position (plus e4) with a *different* hash key than after
`1.e4` with no ep capture possible — and the engine would fail to see repetitions.

## 2.5 Zobrist hashing

The search needs to recognise positions it has seen before — for the transposition table
(chapter 3) and for repetition detection. Comparing whole boards is far too slow, so each
position gets a 64-bit **Zobrist key**:

* At start-up, fill tables with random 64-bit numbers
  ([`src/position.c:20`](../../src/position.c#L20)): one per (piece, square), one per
  castling-rights combination, one per en-passant file, one for "black to move".
* The key of a position is the **XOR** of the numbers of everything that is true in it.

Because XOR is its own inverse (`x ^ r ^ r == x`), moving a piece is two XORs:

```c
st->key ^= ZOBRIST_PIECE[pc][from] ^ ZOBRIST_PIECE[pc][to];   // piece leaves from, arrives at to
st->key ^= ZOBRIST_SIDE;                                       // other side to move
```

— the key is updated **incrementally** in make-move and never recomputed from scratch
during search. (It is recomputed from scratch in the perft self-test, see 2.8.)

A second key, `pawn_key`, only hashes pawns. The classical pawn-structure evaluation uses it
as a cache index, because pawn structures change rarely.

**Collisions.** Two different positions can share a key. With 64 bits and a table of a few
million entries it is rare, but over billions of probes it happens — so every consumer must
tolerate a wrong hit. The transposition table, for instance, never *trusts* a stored move:
it is only used to order the moves the generator produced, so a colliding entry can make
the search slower, never illegal.

## 2.6 Repetition and the 50-move rule

The old engine had no repetition detection at all — it could not steer into a perpetual
check to save a lost game, and would walk into threefold repetitions when winning.
[`src/position.c:410`](../../src/position.c#L410) compares keys in the state stack:

```c
int pos_is_repetition(const Position* pos, int ply_from_root) {
    int end = min(st->rule50, st->plies_from_null);   // earlier positions cannot repeat
    for (int i = 4; i <= end; i += 2) {                // same side to move: every 2nd ply
        if ((st - i)->key == st->key) {
            if (i < ply_from_root) return 1;            // repetition inside the search tree
            if (++count >= 2) return 1;                 // before the root: needs a 3rd occurrence
        }
    }
    return 0;
}
```

Three optimisations hide in that loop:

* A capture or pawn move (`rule50` reset) makes all earlier positions unreachable — stop
  there.
* A null move (chapter 4) is not a real move — positions across it are not repetitions.
* Only positions with the same side to move can be equal, and the earliest possible
  repetition is 4 plies back.

The two-branch rule at the end is a standard subtlety: **inside the search, one repetition
already counts as a draw** (if the engine can repeat once, it can repeat again), but a
position that only occurred before the search started needs two earlier occurrences,
because that is what the rules of chess say.

## 2.7 Null moves

Chapter 4 introduces null-move pruning: "what if I passed my turn?". The state stack makes
that trivial ([`src/position.c:353`](../../src/position.c#L353)): copy the state, flip the
side to move, clear the en-passant square, XOR `ZOBRIST_SIDE`, set `plies_from_null = 0`.
No piece moves, so unmake is only the pointer decrement.

## 2.8 Perft: the single most valuable test

**Perft** ("performance test") counts the leaf nodes of the full move tree to a fixed depth:

```c
uint64_t perft(Position* pos, int depth) {
    MoveList list;
    generate_moves(pos, &list, GEN_ALL);
    uint64_t nodes = 0;
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        if (!pos_is_legal(pos, m)) continue;
        if (depth == 1) { nodes++; continue; }     // "bulk counting": no make/unmake at the leaves
        pos_make_move(pos, m);
        nodes += perft(pos, depth - 1);
        pos_unmake_move(pos, m);
    }
    return nodes;
}
```

The correct numbers for many positions are known exactly, so perft tests the entire
move-generation layer against ground truth. From
[`tools/perft_suite.py`](../../tools/perft_suite.py):

| Position | Depth | Nodes | What it exercises |
|---|---|---|---|
| start position | 5 | 4,865,609 | the basics |
| "Kiwipete" | 4 | 4,085,603 | castling, pins, promotions, en passant — all at once |
| position 3 | 6 | 11,030,083 | the en-passant discovered-check trap from 2.3 |
| position 4 | 5 | 15,833,292 | promotions and checks |
| position 5 | 4 | 2,103,487 | a nasty promotion/castling combination |
| position 6 | 4 | 3,894,594 | a quiet middlegame |

When a number is wrong, **divide** (`perft 4` in the engine prints the count per root move)
tells you which move's subtree is off. Compare with a reference engine's divide, descend
into that move, repeat — a few steps usually pinpoint the bug.

Our perft does one more thing ([`src/perft.c:10`](../../src/perft.c#L10)): at shallow depths,
after every move, it recomputes the hash key, pawn key and evaluation terms **from scratch**
(by printing a FEN and parsing it again) and compares them with the incrementally updated
values. That catches bugs that do not change the move count at all — a castling-rights
change that forgets to update the hash, for example, which would silently poison the
transposition table.

> When the bitboard engine was written for this project, the perft suite passed on the
> first run — not because the code was written perfectly, but because every rule has a
> test waiting for it. The one "failure" we had was a typo in the *test's* FEN.

## 2.9 Pitfalls that cost people days

1. **En passant exposing the king along the rank** (2.3). Perft position 3.
2. **Castling rights after a rook capture on its home square** (2.4). Kiwipete.
3. **Castling out of or through check; b1/b8 may be attacked but must be empty.**
4. **Promotion-captures**: they are captures *and* promotions — both flags, both effects,
   and the captured piece must be restored on unmake.
5. **Stale en-passant squares in the hash**: two identical positions with different keys
   break repetition detection and waste transposition-table hits (2.4).
6. **Checkmate on the 100th half-move**: the 50-move rule does not apply if the last move
   delivered mate (`pos_is_draw` checks for it).
7. **Forgetting that the hash is incremental**: any field that is not part of the key
   (e.g. the move counter) must not influence the evaluation, or the transposition table
   returns scores that belong to a different "position". The old engine's evaluation
   depended on the move number — a real bug this repository fixed in its first days.

## 2.10 Try it yourself

```
position fen 8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1
perft 6
```

should report 11,030,083 nodes; `go perft 3` prints the same kind of breakdown. The whole
suite runs with:

```bash
python3 tools/perft_suite.py bin/darkhelmet
```

Exercises, if you like:

* In the position of 2.3, what does `perft 1` report, and which move is missing compared
  with a naïve generator?
* Why can `pos_is_repetition` start at `i = 4` and not at `i = 2`?
* Which single line in make-move would you have to delete to make Kiwipete's perft 4 wrong,
  but not the start position's perft 5?

---

**Next:** Chapter 3 — Search basics: alpha-beta, PVS, iterative deepening, transposition
table and quiescence search.
