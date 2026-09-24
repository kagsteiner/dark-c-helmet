# Chapter 1 — Bitboards: representing the board

> **Files:** [`src/types.h`](../../src/types.h), [`src/bitboard.h`](../../src/bitboard.h),
> [`src/bitboard.c`](../../src/bitboard.c), [`src/position.h`](../../src/position.h)

## 1.1 Why the board representation matters

The old engine in this repository (`engine_c.c`) stored the board as `int squares[64]` and
generated moves by walking rays square by square:

```c
// engine_c.c — the "mailbox" way: step along a ray until something blocks it
int nr = r + dirs[i][0], nf = f + dirs[i][1];
while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
    int target = b->squares[square_of(nr, nf)];
    ...
}
```

That works, and it is how most people write their first engine. The problem is not that it
is *wrong*, it is that it is *slow at the questions a strong engine asks all the time*:

* "Is square e1 attacked by Black?" — mailbox: walk 8 rays and 8 knight jumps. Asked for
  every legality check, every castling move, every king-safety term.
* "How many squares does this bishop attack that are not defended by enemy pawns?" —
  mailbox: walk rays, look each square up in another table.
* "Is this pawn passed?" — mailbox: loop over up to 18 squares in front of it.

With bitboards, each of these is a handful of 64-bit AND/OR/shift instructions. Our perft
(counting all positions to a fixed depth) runs **several times faster** than the old
engine's — 119 million positions in under half a second on this Mac — and the evaluation
can afford terms that would be far too expensive with a mailbox. Speed is not the goal in itself — but at equal time, a faster engine searches
deeper, and in the evaluation it means *more knowledge per node*.

## 1.2 The idea: one bit per square

A chessboard has 64 squares; a CPU register has 64 bits. A **bitboard** is a `uint64_t` in
which bit *n* means "something is true about square *n*".

We number squares **a1 = 0, b1 = 1, …, h1 = 7, a2 = 8, …, h8 = 63** ("little-endian
rank-file" mapping). So `square = rank * 8 + file`:

```
  8 | 56 57 58 59 60 61 62 63
  7 | 48 49 50 51 52 53 54 55
  6 | 40 41 42 43 44 45 46 47
  5 | 32 33 34 35 36 37 38 39
  4 | 24 25 26 27 28 29 30 31
  3 | 16 17 18 19 20 21 22 23
  2 |  8  9 10 11 12 13 14 15
  1 |  0  1  2  3  4  5  6  7
    +------------------------
       a  b  c  d  e  f  g  h
```

Two consequences you will use constantly:

* Moving **one rank up** is `+8`, i.e. a left shift by 8: `b << 8`.
* Moving **one file right** is `+1`: `b << 1` — but beware of wrap-around (see 1.5).

A bitboard is a **set of squares**, and set operations become single instructions:

| Set operation | Bitboard | Example |
|---|---|---|
| union | `a \| b` | all white pieces = white pawns \| white knights \| … |
| intersection | `a & b` | knight attacks & enemy pieces = knight captures |
| difference | `a & ~b` | knight attacks & ~own pieces = legal knight targets |
| is empty? | `b == 0` | no pawn in front → maybe passed |
| size | `popcount(b)` | mobility = number of reachable squares |

## 1.3 How the position is stored

[`src/position.h:42`](../../src/position.h#L42):

```c
typedef struct {
    Bitboard pieces[12];    // one bitboard per piece type and color (W_PAWN ... B_KING)
    Bitboard by_color[2];   // all white / all black pieces
    Bitboard occupied;      // all pieces
    uint8_t board[64];      // mailbox: which piece is on each square (or NO_PIECE)
    int side;
    ...
} Position;
```

This is deliberately **redundant**. `by_color` and `occupied` could be computed from
`pieces[]`, and `board[]` could be computed from the bitboards. We keep all of them because
each answers a different question in O(1):

* "Where are the white knights?" → `pieces[W_KNIGHT]`
* "What stands on e4?" → `board[E4]` (with bitboards alone you would have to test 12 boards)
* "Which squares are empty?" → `~occupied`

The price is that every change must update all views consistently. That happens in exactly
three tiny functions (`put_piece`, `remove_piece`, `move_piece` in
[`src/position.c`](../../src/position.c)), and the perft test in chapter 2 verifies they never
disagree.

Pieces are encoded as `color * 6 + type` ([`src/types.h`](../../src/types.h)):
`W_PAWN = 0 … W_KING = 5, B_PAWN = 6 … B_KING = 11`, and `NO_PIECE = 12`.

## 1.4 The three essential bit tricks

Almost all bitboard code is built on these, from [`src/bitboard.h`](../../src/bitboard.h):

```c
static inline int lsb(Bitboard b)      { return __builtin_ctzll(b); }      // index of lowest set bit
static inline int popcount(Bitboard b) { return __builtin_popcountll(b); } // number of set bits

static inline int pop_lsb(Bitboard* b) {  // return the lowest square and remove it
    int sq = lsb(*b);
    *b &= *b - 1;                          // clears exactly the lowest set bit
    return sq;
}
```

Why does `b & (b - 1)` clear the lowest bit? Subtracting 1 flips the lowest set bit to 0 and
all the zeros below it to 1; the AND then removes both:

```
b       = 0b1011000
b - 1   = 0b1010111
b&(b-1) = 0b1010000
```

`lsb` and `popcount` compile to single instructions (`tzcnt`/`popcnt` on x86, `rbit+clz` and
`cnt` on ARM). On MSVC the header uses `_BitScanForward64` and `__popcnt64` instead
([`src/bitboard.h:6`](../../src/bitboard.h#L6)).

With `pop_lsb` you get the standard **serialisation loop**, which appears dozens of times in
the engine:

```c
Bitboard knights = pieces_of(pos, us, KNIGHT);
while (knights) {
    int from = pop_lsb(&knights);          // visit each knight once
    Bitboard targets = KNIGHT_ATTACKS[from] & ~pos->by_color[us];
    while (targets) {
        int to = pop_lsb(&targets);        // visit each target square once
        add_move(from, to);
    }
}
```

The loop runs once per *set bit*, not once per square. A position with 2 knights costs 2
iterations, not 64.

A fourth trick that shows up in pin and check detection:

```c
static inline int more_than_one(Bitboard b) { return (b & (b - 1)) != 0; }
```

## 1.5 Non-sliding pieces: lookup tables and shifts

Knights and kings attack the same squares regardless of other pieces, so we precompute
`KNIGHT_ATTACKS[64]` and `KING_ATTACKS[64]` once at start-up
([`src/bitboard.c`](../../src/bitboard.c), `bitboards_init`). A knight's attack set is then
one memory load.

Pawns are more interesting because we usually want the attacks of **all pawns at once**.
A white pawn on square *s* attacks *s + 7* (diagonally left) and *s + 9* (diagonally right),
so for the whole set of white pawns:

```c
// src/bitboard.h:92
static inline Bitboard pawn_attacks_bb(int color, Bitboard pawns) {
    if (color == WHITE) return ((pawns & ~FILE_A_BB) << 7) | ((pawns & ~FILE_H_BB) << 9);
    return ((pawns & ~FILE_A_BB) >> 9) | ((pawns & ~FILE_H_BB) >> 7);
}
```

The `& ~FILE_A_BB` is essential. Without it a pawn on a4 (square 24) shifted by +7 lands on
square 31 = **h4**: the bits do not know that the board has edges, so the pawn "wraps
around". Masking out the a-file pawns before shifting "left" (and the h-file pawns before
shifting "right") prevents that. Forgetting such a mask is the classic bitboard bug — and it
is exactly the kind of bug perft (chapter 2) catches.

Pawn pushes work the same way. From the move generator
([`src/movegen.c:35`](../../src/movegen.c#L35)):

```c
Bitboard single = pawn_push(us, normal) & empty;           // all one-step pushes
Bitboard dbl    = pawn_push(us, single & rank3) & empty;   // two-step pushes
```

The double-push line is a nice example of bitboard thinking: a pawn can push twice exactly
when its single push landed on the third rank *and* the next square is empty. No loops over
pawns, no special cases — two lines generate the pushes of all eight pawns.

## 1.6 Sliding pieces: the hard part, and magic bitboards

Bishops, rooks and queens are the problem: their attacks depend on **which squares are
occupied**. A rook on d4 attacks up to d8 if the file is empty, but only up to d6 if
something stands on d6.

### The question we need answered

> Given a square and the current occupancy, which squares does a rook (or bishop) attack?

We want this in O(1). The idea of **magic bitboards**: precompute the answer for *every
possible occupancy* and look it up. That sounds impossible (2⁶⁴ occupancies), but three
observations make it tiny.

**Observation 1 — only squares on the piece's rays matter.** For a rook on d4, pieces on b7
are irrelevant. We mask the occupancy with the rook's rays first.

**Observation 2 — the edge squares do not matter.** Whether d8 is occupied or not, the rook
attacks d8 if it gets that far. So the **relevant mask** excludes the edges. For a rook on d4:

```
  8 | . . . . . . . .
  7 | . . . x . . . .      x = relevant occupancy square
  6 | . . . x . . . .      R = the rook (d4)
  5 | . . . x . . . .
  4 | . x x R x x x .      10 relevant squares
  3 | . . . x . . . .      -> 2^10 = 1024 possible blocker configurations
  2 | . . . x . . . .
  1 | . . . . . . . .
```

A rook has 10–12 relevant squares (12 in a corner), a bishop 5–9. So for each square there
are at most 2¹² = 4096 blocker configurations that matter.

**Observation 3 — we can hash those configurations perfectly.** We need to turn the
relevant blockers (scattered bits anywhere in the 64-bit word) into a compact table index
0…4095. That is what the "magic" multiplication does:

```c
// src/bitboard.h:69
static inline Bitboard rook_attacks(int sq, Bitboard occ) {
    const Magic* m = &ROOK_MAGICS[sq];
    return m->attacks[((occ & m->mask) * m->magic) >> m->shift];
}
```

1. `occ & m->mask` keeps only the relevant blockers.
2. Multiplying by a carefully chosen 64-bit number `magic` "gathers" those scattered bits into
   the **top** bits of the product. (Multiplication is a sum of shifted copies of the
   input, and a good magic makes the copies land in useful places.)
3. `>> m->shift` keeps just the top 10–12 bits → a table index.
4. The table entry is the precomputed attack set.

The magic is not derived by formula; it is **found by trial and error** — and that is
precisely what "hashing" means here: we try random candidate numbers until one maps every
relevant blocker configuration to an index where it does not collide with a configuration
that needs a *different* answer. Two configurations may share an index if they produce the
same attack set (a "constructive collision" — e.g. blockers *behind* the first blocker do not
change anything).

### Finding the magics at start-up

We do not hard-code magic numbers; [`src/bitboard.c:53`](../../src/bitboard.c#L53) finds
them when the engine starts (it takes a few milliseconds):

```c
// For every square:
m->mask  = sliding_attacks(sq, 0, dirs) & ~edges;   // relevant squares (observation 1+2)
m->shift = 64 - popcount(m->mask);

// Enumerate all 2^n subsets of the mask ("Carry-Rippler" trick)
Bitboard b = 0;
do {
    occupancy[size] = b;
    reference[size] = sliding_attacks(sq, b, dirs);  // slow ray-walking, only at start-up
    size++;
    b = (b - m->mask) & m->mask;                      // next subset
} while (b);

// Try random sparse numbers until one works
for (;;) {
    m->magic = rng_next() & rng_next() & rng_next();  // AND of 3 randoms = few bits set
    ... fill the table; if two subsets with different attacks collide, try the next one
}
```

Three details worth noticing:

* **`(b - mask) & mask` enumerates all subsets of `mask`.** It is a small classic worth
  working through on paper once.
* **Sparse candidates** (few bits set, from ANDing three random numbers) are far more likely
  to be good magics than uniformly random ones.
* **The slow ray-walking code survives** — as the *reference implementation* used to fill
  the tables. This is a good general pattern: write the simple, obviously correct version
  first, and use it to generate or check the fast one.

All 64 rook tables share one array of 102,400 entries, the bishop tables one of 5,248
entries (≈ 860 KB in total), because squares near the centre need smaller tables than the
corners ("fancy magics").

> **Alternative:** modern x86 CPUs have the `PEXT` instruction, which does the "gather the
> relevant bits" step directly without a magic number. It is not available on ARM (your Mac)
> and is slow on older AMD chips, so magics are the portable choice.

Queens need no tables of their own:

```c
static inline Bitboard queen_attacks(int sq, Bitboard occ) {
    return bishop_attacks(sq, occ) | rook_attacks(sq, occ);
}
```

## 1.7 Thinking in reverse: "who attacks this square?"

A beautiful property of attack tables is **symmetry**: a knight on *a* attacks *b* exactly
when a knight on *b* would attack *a*. The same holds for bishops, rooks, queens and kings
(and for pawns with the colour swapped). So to find everything that attacks square *sq*,
pretend each piece type stands on *sq* and intersect its attacks with the real pieces of
that type ([`src/position.h:102`](../../src/position.h#L102)):

```c
static inline Bitboard attackers_to(const Position* pos, int sq, Bitboard occ) {
    return (PAWN_ATTACKS[BLACK][sq] & pos->pieces[W_PAWN])   // white pawns attacking sq
         | (PAWN_ATTACKS[WHITE][sq] & pos->pieces[B_PAWN])
         | (KNIGHT_ATTACKS[sq]      & (knights of both colours))
         | (bishop_attacks(sq, occ) & (bishops and queens))
         | (rook_attacks(sq, occ)   & (rooks and queens))
         | (KING_ATTACKS[sq]        & (both kings));
}
```

Six lookups instead of walking 16 rays. Note the `occ` parameter: passing a *modified*
occupancy lets us ask hypothetical questions — "would the king be attacked on g1 if it moved
there?" (remove the king from `occ`, otherwise it blocks the ray through itself), or "which
pieces attack e5 once the pawn on e5 is gone?" (used by the static exchange evaluation in
chapter 5, where x-ray attackers appear as pieces are traded off).

## 1.8 Precomputed geometry

`bitboards_init` also builds a few tables that turn geometric questions into lookups:

| Table | Meaning | Used for |
|---|---|---|
| `BETWEEN_BB[a][b]` | squares strictly between two aligned squares | blocking a check, detecting pins |
| `LINE_BB[a][b]` | the whole line through two aligned squares | a pinned piece may only move along the pin line |
| `PASSED_MASK[c][sq]` | squares in front on the same and adjacent files | passed-pawn test: `!(PASSED_MASK[us][sq] & their_pawns)` |
| `FORWARD_FILE_BB[c][sq]` | squares in front on the same file | doubled pawns |
| `ADJACENT_FILES_BB[f]` | the neighbouring files | isolated pawns |
| `DISTANCE[a][b]` | king distance (Chebyshev) | endgame king-to-pawn terms |

A nice use of `BETWEEN_BB` is pin detection
([`src/position.c:99`](../../src/position.c#L99)). Find enemy sliders that would attack our
king on an empty board ("snipers"); for each, if exactly one piece stands between it and the
king and that piece is ours, it is pinned:

```c
Bitboard snipers = (rook_attacks(ksq, 0)   & (their rooks | their queens))
                 | (bishop_attacks(ksq, 0) & (their bishops | their queens));
while (snipers) {
    int s = pop_lsb(&snipers);
    Bitboard between = BETWEEN_BB[ksq][s] & pos->occupied;
    if (between && !more_than_one(between) && (between & our_pieces))
        pinned |= between;
}
```

Knowing the pinned pieces up front makes the legality check in chapter 2 almost free.

## 1.9 Bitboards in the evaluation

The payoff is not only in move generation. Some evaluation terms from
[`src/eval.c`](../../src/eval.c), each essentially a single expression:

```c
// Passed pawn: no enemy pawn in front on this or an adjacent file
if (!(PASSED_MASK[us][sq] & their_pawns)) ...

// Mobility area: squares not occupied by own pawns/king and not attacked by enemy pawns
mobility_area[c] = ~(own_pawns | own_king) & ~pawn_attacks_bb(them, their_pawns);
int mobility = popcount(bishop_attacks(sq, occ) & mobility_area[us]);

// Pieces the opponent attacks that nobody defends ("hanging")
Bitboard hanging = their_pieces & attacked_by[us] & ~attacked_by[them];
```

In the old engine, "is this pawn passed?" was a triple loop. Here it is one AND. That
difference is why a bitboard engine can afford a rich evaluation *and* deep search at the
same time — and later (chapter 7) why the NNUE can be fed its inputs cheaply.

## 1.10 Pitfalls that cost people days

1. **`1 << sq` instead of `1ULL << sq`.** `1` is a 32-bit `int`; shifting it by 32 or more is
   undefined behaviour and silently produces garbage for half the board. The engine uses a
   macro, `#define BB(sq) (1ULL << (sq))`.
2. **Wrap-around on horizontal shifts.** Always mask off the a- or h-file before shifting by
   ±1, ±7 or ±9 (section 1.5).
3. **Forgetting to remove the moving king from the occupancy** when testing whether its
   destination is attacked: the king would "block" the slider's ray and the move would look
   safe when it is not.
4. **Unsigned negation on MSVC.** The idiom `b & -b` (isolate the lowest bit) triggers error
   C4146 in MSVC with `/sdl`; the engine writes it as `b & (~b + 1)`.
5. **Inconsistent redundant state.** With `pieces[]`, `by_color[]`, `occupied` and `board[]`
   all describing the same position, a single missed update corrupts everything later. Keep
   all updates in a few small functions and test them with perft.

## 1.11 Try it yourself

In the engine (`bin/darkhelmet`, then type commands):

```
position fen r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1
d
perft 4
```

`d` prints the board and its hash key; `perft 4` counts all positions four moves ahead
(4,085,603 for this position, the famous "Kiwipete"). Chapter 2 explains why that single
number is the most valuable test in chess programming.

Small exercises, if you like:

* Work out on paper what `pawn_attacks_bb(WHITE, BB(A4))` would return without the
  `~FILE_A_BB` mask.
* Enumerate the subsets of `mask = 0b1010` with `b = (b - mask) & mask`, starting from 0.
* Why does a rook in the corner have 12 relevant squares but a rook on d4 only 10?

---

**Next:** Chapter 2 — Move generation, legality, make/unmake, Zobrist hashing and perft.
