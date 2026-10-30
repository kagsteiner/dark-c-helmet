#include "position.h"
#include "movegen.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

uint64_t ZOBRIST_PIECE[12][64];
uint64_t ZOBRIST_CASTLING[16];
uint64_t ZOBRIST_EP[8];
uint64_t ZOBRIST_SIDE;

const int SEE_VALUE[6] = {100, 320, 330, 500, 950, 0};
const int PHASE_WEIGHT[6] = {0, 1, 1, 2, 4, 0};

int g_chess960 = 0;

static uint64_t splitmix64(uint64_t* x) {
    uint64_t z = (*x += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

void position_init(void) {
    uint64_t seed = 0x5DEECE66DULL;
    for (int pc = 0; pc < 12; ++pc)
        for (int sq = 0; sq < 64; ++sq) ZOBRIST_PIECE[pc][sq] = splitmix64(&seed);
    for (int i = 0; i < 16; ++i) ZOBRIST_CASTLING[i] = splitmix64(&seed);
    for (int i = 0; i < 8; ++i) ZOBRIST_EP[i] = splitmix64(&seed);
    ZOBRIST_SIDE = splitmix64(&seed);
}

// Grants a castling right with the rook on rook_sq (standard chess or Chess960) and
// precomputes what the move generator and make-move need for it.
static void add_castling_right(Position* pos, int color, int rook_sq) {
    int ksq = king_square(pos, color);
    int queenside = file_of(rook_sq) < file_of(ksq);
    int idx = castle_index(color, queenside);
    int king_to = relative_square(color, queenside ? C1 : G1);
    int rook_to = relative_square(color, queenside ? D1 : F1);
    pos->st->castling |= 1 << idx;
    pos->castle_rook[idx] = rook_sq;
    pos->castle_empty[idx] = (BETWEEN_BB[ksq][king_to] | BB(king_to) | BETWEEN_BB[rook_sq][rook_to] | BB(rook_to)) &
                             ~BB(ksq) & ~BB(rook_sq);
    pos->castle_transit[idx] = BETWEEN_BB[ksq][king_to];
    pos->castle_mask[ksq] &= (uint8_t)~(3 << (color * 2));
    pos->castle_mask[rook_sq] &= (uint8_t)~(1 << idx);
}

// One castling character of a FEN: KQkq (X-FEN: the outermost rook on that side) or a file
// letter A-H / a-h (Shredder-FEN, also X-FEN when the outermost rook is not meant).
static void parse_castling_char(Position* pos, char c) {
    int color = isupper((unsigned char)c) ? WHITE : BLACK;
    int ksq = king_square(pos, color);
    if (rank_of(ksq) != (color == WHITE ? 0 : 7)) return;
    int rook = make_piece(color, ROOK);
    int lc = tolower((unsigned char)c);
    int rook_sq = NO_SQ;
    if (lc == 'k') {
        for (int f = 7; f > file_of(ksq) && rook_sq == NO_SQ; --f)
            if (pos->board[make_square(rank_of(ksq), f)] == rook) rook_sq = make_square(rank_of(ksq), f);
    } else if (lc == 'q') {
        for (int f = 0; f < file_of(ksq) && rook_sq == NO_SQ; ++f)
            if (pos->board[make_square(rank_of(ksq), f)] == rook) rook_sq = make_square(rank_of(ksq), f);
    } else if (lc >= 'a' && lc <= 'h') {
        int sq = make_square(rank_of(ksq), lc - 'a');
        if (pos->board[sq] == rook) rook_sq = sq;
    }
    if (rook_sq != NO_SQ) add_castling_right(pos, color, rook_sq);
}

// ---------------------------------------------------------------------------
// Low-level board updates (board arrays only) and state updates (hash, eval)
// ---------------------------------------------------------------------------

static inline void put_piece(Position* pos, int pc, int sq) {
    Bitboard b = BB(sq);
    pos->board[sq] = (uint8_t)pc;
    pos->pieces[pc] |= b;
    pos->by_color[piece_color(pc)] |= b;
    pos->occupied |= b;
}

static inline void remove_piece(Position* pos, int sq) {
    int pc = pos->board[sq];
    Bitboard b = BB(sq);
    pos->pieces[pc] ^= b;
    pos->by_color[piece_color(pc)] ^= b;
    pos->occupied ^= b;
    pos->board[sq] = NO_PIECE;
}

static inline void move_piece(Position* pos, int from, int to) {
    int pc = pos->board[from];
    Bitboard fromto = BB(from) | BB(to);
    pos->pieces[pc] ^= fromto;
    pos->by_color[piece_color(pc)] ^= fromto;
    pos->occupied ^= fromto;
    pos->board[from] = NO_PIECE;
    pos->board[to] = (uint8_t)pc;
}

static inline void state_add(State* st, int pc, int sq) {
    st->key ^= ZOBRIST_PIECE[pc][sq];
    st->psq_mg += PSQ_MG[pc][sq];
    st->psq_eg += PSQ_EG[pc][sq];
    st->phase += PHASE_WEIGHT[piece_type(pc)];
    if (piece_type(pc) == PAWN) st->pawn_key ^= ZOBRIST_PIECE[pc][sq];
}

static inline void add_dirty(State* st, int pc, int from, int to) {
    DirtyPieces* d = &st->dirty;
    d->piece[d->count] = pc;
    d->from[d->count] = from;
    d->to[d->count] = to;
    d->count++;
}

static inline void state_remove(State* st, int pc, int sq) {
    st->key ^= ZOBRIST_PIECE[pc][sq];
    st->psq_mg -= PSQ_MG[pc][sq];
    st->psq_eg -= PSQ_EG[pc][sq];
    st->phase -= PHASE_WEIGHT[piece_type(pc)];
    if (piece_type(pc) == PAWN) st->pawn_key ^= ZOBRIST_PIECE[pc][sq];
}

static void set_check_info(Position* pos) {
    State* st = pos->st;
    int us = pos->side, them = us ^ 1;
    int ksq = king_square(pos, us);
    st->checkers = attackers_to(pos, ksq, pos->occupied) & pos->by_color[them];

    Bitboard snipers = (rook_attacks(ksq, 0) & (pieces_of(pos, them, ROOK) | pieces_of(pos, them, QUEEN))) |
                       (bishop_attacks(ksq, 0) & (pieces_of(pos, them, BISHOP) | pieces_of(pos, them, QUEEN)));
    st->pinned = 0;
    while (snipers) {
        int s = pop_lsb(&snipers);
        Bitboard between = BETWEEN_BB[ksq][s] & pos->occupied;
        if (between && !more_than_one(between) && (between & pos->by_color[us])) st->pinned |= between;
    }
}

// ---------------------------------------------------------------------------
// FEN
// ---------------------------------------------------------------------------

static int char_to_piece(char c) {
    const char* pieces = "PNBRQKpnbrqk";
    const char* p = strchr(pieces, c);
    return p ? (int)(p - pieces) : NO_PIECE;
}

int pos_set_fen(Position* pos, const char* fen) {
    memset(pos, 0, sizeof(*pos));
    for (int sq = 0; sq < 64; ++sq) pos->board[sq] = NO_PIECE;
    pos->st = &pos->states[0];
    State* st = pos->st;

    char buf[256];
    strncpy(buf, fen, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    char* fields[6] = {0};
    int n = 0;
    for (char* tok = strtok(buf, " \t\r\n"); tok && n < 6; tok = strtok(NULL, " \t\r\n")) fields[n++] = tok;
    if (n < 2) return 0;

    int rank = 7, file = 0;
    for (const char* c = fields[0]; *c; ++c) {
        if (*c == '/') { rank--; file = 0; }
        else if (isdigit((unsigned char)*c)) file += *c - '0';
        else {
            int pc = char_to_piece(*c);
            if (pc == NO_PIECE || rank < 0 || file > 7) return 0;
            put_piece(pos, pc, make_square(rank, file));
            file++;
        }
    }
    if (popcount(pos->pieces[W_KING]) != 1 || popcount(pos->pieces[B_KING]) != 1) return 0;
    for (int i = 0; i < 4; ++i) pos->castle_rook[i] = NO_SQ;
    memset(pos->castle_mask, 15, sizeof(pos->castle_mask));

    pos->side = (fields[1][0] == 'b') ? BLACK : WHITE;
    pos->start_side = pos->side;
    st->castling = 0;
    if (n > 2) {
        for (const char* c = fields[2]; *c && *c != '-'; ++c) parse_castling_char(pos, *c);
    }
    st->ep_sq = NO_SQ;
    if (n > 3 && fields[3][0] != '-' && strlen(fields[3]) >= 2) {
        int sq = make_square(fields[3][1] - '1', fields[3][0] - 'a');
        // Only record the square if an en-passant capture is actually possible.
        if (sq >= 0 && sq < 64 && (PAWN_ATTACKS[pos->side ^ 1][sq] & pieces_of(pos, pos->side, PAWN)))
            st->ep_sq = sq;
    }
    st->rule50 = (n > 4) ? atoi(fields[4]) : 0;
    pos->fullmove_base = (n > 5) ? atoi(fields[5]) : 1;
    if (pos->fullmove_base < 1) pos->fullmove_base = 1;
    pos->game_ply = 0;
    st->captured = NO_PIECE;
    st->move = MOVE_NONE;

    st->key = 0;
    st->pawn_key = 0;
    st->psq_mg = st->psq_eg = st->phase = 0;
    for (int sq = 0; sq < 64; ++sq)
        if (pos->board[sq] != NO_PIECE) state_add(st, pos->board[sq], sq);
    st->key ^= ZOBRIST_CASTLING[st->castling];
    if (st->ep_sq != NO_SQ) st->key ^= ZOBRIST_EP[file_of(st->ep_sq)];
    if (pos->side == BLACK) st->key ^= ZOBRIST_SIDE;
    set_check_info(pos);
    st->dirty.count = 0;
    pos->acc[0].computed[WHITE] = pos->acc[0].computed[BLACK] = 0;
    return 1;
}

void pos_to_fen(const Position* pos, char* out, size_t size) {
    const char* chars = "PNBRQKpnbrqk";
    char board[80];
    int k = 0;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f < 8; ++f) {
            int pc = pos->board[make_square(r, f)];
            if (pc == NO_PIECE) { empty++; continue; }
            if (empty) { board[k++] = (char)('0' + empty); empty = 0; }
            board[k++] = chars[pc];
        }
        if (empty) board[k++] = (char)('0' + empty);
        if (r) board[k++] = '/';
    }
    board[k] = '\0';
    // KQkq when the castling rook is the outermost one on its side (always so in standard
    // chess), otherwise the rook's file letter (Shredder-FEN / X-FEN).
    char castle[5];
    int c = 0;
    for (int idx = 0; idx < 4; ++idx) {
        if (!(pos->st->castling & (1 << idx))) continue;
        int color = idx / 2, queenside = idx & 1, rsq = pos->castle_rook[idx];
        int outermost = 1;
        for (int f = queenside ? 0 : 7; f != file_of(rsq); f += queenside ? 1 : -1)
            if (pos->board[make_square(rank_of(rsq), f)] == make_piece(color, ROOK)) outermost = 0;
        char ch = outermost ? (queenside ? 'q' : 'k') : (char)('a' + file_of(rsq));
        castle[c++] = color == WHITE ? (char)toupper((unsigned char)ch) : ch;
    }
    if (!c) castle[c++] = '-';
    castle[c] = '\0';
    char ep[3] = "-";
    if (pos->st->ep_sq != NO_SQ) {
        ep[0] = (char)('a' + file_of(pos->st->ep_sq));
        ep[1] = (char)('1' + rank_of(pos->st->ep_sq));
        ep[2] = '\0';
    }
    int fullmove = pos->fullmove_base + (pos->game_ply + pos->start_side) / 2;
    snprintf(out, size, "%s %c %s %s %d %d", board, pos->side == WHITE ? 'w' : 'b', castle, ep,
             pos->st->rule50, fullmove);
}

void pos_print(const Position* pos) {
    const char* chars = "PNBRQKpnbrqk";
    for (int r = 7; r >= 0; --r) {
        printf(" +---+---+---+---+---+---+---+---+\n %d", r + 1);
        for (int f = 0; f < 8; ++f) {
            int pc = pos->board[make_square(r, f)];
            printf("| %c ", pc == NO_PIECE ? ' ' : chars[pc]);
        }
        printf("|\n");
    }
    printf(" +---+---+---+---+---+---+---+---+\n    a   b   c   d   e   f   g   h\n");
    char fen[128];
    pos_to_fen(pos, fen, sizeof(fen));
    printf("Fen: %s\nKey: %016llx\n", fen, (unsigned long long)pos->st->key);
    fflush(stdout);
}

// ---------------------------------------------------------------------------
// Make / unmake
// ---------------------------------------------------------------------------

void pos_make_move(Position* pos, Move m) {
    State* prev = pos->st;
    State* st = prev + 1;
    *st = *prev;
    pos->st = st;

    int us = pos->side, them = us ^ 1;
    int from = move_from(m), to = move_to(m), flags = move_flags(m);
    int pc = pos->board[from];

    st->move = m;
    st->rule50++;
    st->plies_from_null++;
    st->captured = NO_PIECE;
    st->dirty.count = 0;
    st->key ^= ZOBRIST_SIDE;
    if (prev->ep_sq != NO_SQ) {
        st->key ^= ZOBRIST_EP[file_of(prev->ep_sq)];
        st->ep_sq = NO_SQ;
    }

    if (flags == FLAG_KING_CASTLE || flags == FLAG_QUEEN_CASTLE) {
        // Lift both pieces before placing them: in Chess960 the squares can overlap.
        int queenside = flags == FLAG_QUEEN_CASTLE;
        int rook_from = pos->castle_rook[castle_index(us, queenside)];
        int rook_to = relative_square(us, queenside ? D1 : F1);
        int rook = pos->board[rook_from];
        remove_piece(pos, from);
        remove_piece(pos, rook_from);
        put_piece(pos, pc, to);
        put_piece(pos, rook, rook_to);
        state_remove(st, pc, from);
        state_add(st, pc, to);
        state_remove(st, rook, rook_from);
        state_add(st, rook, rook_to);
        add_dirty(st, pc, from, to);
        add_dirty(st, rook, rook_from, rook_to);
    } else {
        if (flags & FLAG_CAPTURE) {
            int cap_sq = (flags == FLAG_EP) ? (to ^ 8) : to;
            int captured = pos->board[cap_sq];
            remove_piece(pos, cap_sq);
            state_remove(st, captured, cap_sq);
            st->captured = captured;
            st->rule50 = 0;
            add_dirty(st, captured, cap_sq, NO_SQ);
        }
        move_piece(pos, from, to);
        state_remove(st, pc, from);
        state_add(st, pc, to);
        if (!(flags & FLAG_PROMO)) add_dirty(st, pc, from, to);

        if (piece_type(pc) == PAWN) {
            st->rule50 = 0;
            if (flags == FLAG_DOUBLE_PUSH) {
                int ep = (from + to) / 2;
                if (PAWN_ATTACKS[us][ep] & pieces_of(pos, them, PAWN)) {
                    st->ep_sq = ep;
                    st->key ^= ZOBRIST_EP[file_of(ep)];
                }
            } else if (flags & FLAG_PROMO) {
                int promo = make_piece(us, move_promo_type(m));
                remove_piece(pos, to);
                put_piece(pos, promo, to);
                state_remove(st, pc, to);
                state_add(st, promo, to);
                add_dirty(st, pc, from, NO_SQ);
                add_dirty(st, promo, NO_SQ, to);
            }
        }
    }

    if (st->castling && (pos->castle_mask[from] & pos->castle_mask[to]) != 15) {
        st->key ^= ZOBRIST_CASTLING[st->castling];
        st->castling &= pos->castle_mask[from] & pos->castle_mask[to];
        st->key ^= ZOBRIST_CASTLING[st->castling];
    }

    pos->side = them;
    pos->game_ply++;
    pos->acc[pos->game_ply].computed[WHITE] = pos->acc[pos->game_ply].computed[BLACK] = 0;
    set_check_info(pos);
}

void pos_unmake_move(Position* pos, Move m) {
    pos->side ^= 1;
    pos->game_ply--;
    int us = pos->side;
    int from = move_from(m), to = move_to(m), flags = move_flags(m);
    State* st = pos->st;

    if (flags == FLAG_KING_CASTLE || flags == FLAG_QUEEN_CASTLE) {
        int queenside = flags == FLAG_QUEEN_CASTLE;
        int rook_from = pos->castle_rook[castle_index(us, queenside)];
        int rook_to = relative_square(us, queenside ? D1 : F1);
        int king = pos->board[to], rook = pos->board[rook_to];
        remove_piece(pos, to);
        remove_piece(pos, rook_to);
        put_piece(pos, king, from);
        put_piece(pos, rook, rook_from);
    } else {
        if (flags & FLAG_PROMO) {
            remove_piece(pos, to);
            put_piece(pos, make_piece(us, PAWN), to);
        }
        move_piece(pos, to, from);
        if (st->captured != NO_PIECE) {
            int cap_sq = (flags == FLAG_EP) ? (to ^ 8) : to;
            put_piece(pos, st->captured, cap_sq);
        }
    }
    pos->st--;
}

void pos_make_null(Position* pos) {
    State* prev = pos->st;
    State* st = prev + 1;
    *st = *prev;
    pos->st = st;
    st->move = MOVE_NONE;
    st->captured = NO_PIECE;
    st->rule50++;
    st->plies_from_null = 0;
    st->dirty.count = 0;
    st->key ^= ZOBRIST_SIDE;
    if (prev->ep_sq != NO_SQ) {
        st->key ^= ZOBRIST_EP[file_of(prev->ep_sq)];
        st->ep_sq = NO_SQ;
    }
    pos->side ^= 1;
    pos->game_ply++;
    pos->acc[pos->game_ply].computed[WHITE] = pos->acc[pos->game_ply].computed[BLACK] = 0;
    set_check_info(pos);
}

void pos_unmake_null(Position* pos) {
    pos->side ^= 1;
    pos->game_ply--;
    pos->st--;
}

// ---------------------------------------------------------------------------
// Legality, draws, SEE
// ---------------------------------------------------------------------------

// Checks whether a pseudo-legal move leaves the own king safe.
int pos_is_legal(const Position* pos, Move m) {
    int us = pos->side, them = us ^ 1;
    int from = move_from(m), to = move_to(m), flags = move_flags(m);
    int ksq = king_square(pos, us);

    if (flags == FLAG_EP) {
        int cap_sq = to ^ 8;
        Bitboard occ = (pos->occupied ^ BB(from) ^ BB(cap_sq)) | BB(to);
        Bitboard attackers = attackers_to(pos, ksq, occ) & pos->by_color[them] & ~BB(cap_sq);
        return attackers == 0;
    }
    if (from == ksq) {
        if (flags == FLAG_KING_CASTLE || flags == FLAG_QUEEN_CASTLE) return 1;  // checked in movegen
        return !square_attacked(pos, to, them, pos->occupied ^ BB(from));
    }
    Bitboard checkers = pos->st->checkers;
    if (checkers) {
        if (more_than_one(checkers)) return 0;
        int checker = lsb(checkers);
        if (!((BETWEEN_BB[ksq][checker] | checkers) & BB(to))) return 0;
    }
    if (pos->st->pinned & BB(from)) return (LINE_BB[from][ksq] & BB(to)) != 0;
    return 1;
}

// Whether m is a move the generator could produce in this position. Moves from the
// transposition table or the killer/countermove tables come from other positions and must
// pass this test before they are tried without generating the move list.
int pos_is_pseudo_legal(const Position* pos, Move m) {
    if (m == MOVE_NONE) return 0;
    int us = pos->side, them = us ^ 1;
    int from = move_from(m), to = move_to(m), flags = move_flags(m);
    int pc = pos->board[from];
    if (pc == NO_PIECE || piece_color(pc) != us) return 0;
    int type = piece_type(pc);

    // Castling first: in Chess960 the king's target square may hold the castling rook or the
    // king itself.
    if (flags == FLAG_KING_CASTLE || flags == FLAG_QUEEN_CASTLE) {
        if (type != KING) return 0;
        MoveList list;
        list.count = 0;
        generate_castling(pos, &list);
        for (int i = 0; i < list.count; ++i)
            if (list.moves[i].move == m) return 1;
        return 0;
    }
    int target = pos->board[to];
    if (target != NO_PIECE && piece_color(target) == us) return 0;
    if (flags == FLAG_EP)
        return type == PAWN && to == pos->st->ep_sq && (PAWN_ATTACKS[us][from] & BB(to));
    if (flags == 6 || flags == 7) return 0;                        // unused flag combinations

    int capture = (flags & FLAG_CAPTURE) != 0;
    if (capture != (target != NO_PIECE)) return 0;              // capture flag must match the board
    if (target != NO_PIECE && piece_type(target) == KING) return 0;

    if (type == PAWN) {
        int promo_rank = relative_rank(us, to) == 7;
        if (promo_rank != ((flags & FLAG_PROMO) != 0)) return 0;
        int up = us == WHITE ? 8 : -8;
        if (capture) return (PAWN_ATTACKS[us][from] & BB(to)) != 0;
        if (flags == FLAG_DOUBLE_PUSH)
            return relative_rank(us, from) == 1 && to == from + 2 * up &&
                   pos->board[from + up] == NO_PIECE;               // target emptiness checked above
        if (flags != FLAG_QUIET && !(flags & FLAG_PROMO)) return 0;
        return to == from + up;                                     // single push (or promotion)
    }
    if (flags != FLAG_QUIET && flags != FLAG_CAPTURE) return 0;     // no special flags for pieces
    (void)them;
    return (piece_attacks(type, from, pos->occupied) & BB(to)) != 0;
}

int pos_is_repetition(const Position* pos, int ply_from_root) {
    const State* st = pos->st;
    int end = st->rule50 < st->plies_from_null ? st->rule50 : st->plies_from_null;
    if (end > pos->game_ply) end = pos->game_ply;
    int count = 0;
    for (int i = 4; i <= end; i += 2) {
        const State* prev = st - i;
        if (prev->key == st->key) {
            // Inside the search tree one repetition is enough; before the root require two.
            if (i < ply_from_root) return 1;
            if (++count >= 2) return 1;
        }
    }
    return 0;
}

static int insufficient_material(const Position* pos) {
    if (pieces_type(pos, PAWN) | pieces_type(pos, ROOK) | pieces_type(pos, QUEEN)) return 0;
    // Only kings and at most one minor piece in total.
    return popcount(pos->occupied) <= 3;
}

int pos_is_draw(const Position* pos, int ply_from_root) {
    if (pos->st->rule50 >= 100) {
        if (!in_check(pos)) return 1;
        MoveList list;
        generate_legal(pos, &list);
        return list.count > 0;  // checkmate takes precedence over the 50-move rule
    }
    return pos_is_repetition(pos, ply_from_root) || insufficient_material(pos);
}

// Static exchange evaluation: does the move win at least `threshold` material?
int see_ge(const Position* pos, Move m, int threshold) {
    if (move_is_castle(m) || move_is_promo(m) || move_flags(m) == FLAG_EP) return threshold <= 0;

    int from = move_from(m), to = move_to(m);
    int victim = pos->board[to];
    int swap = (victim == NO_PIECE ? 0 : SEE_VALUE[piece_type(victim)]) - threshold;
    if (swap < 0) return 0;
    swap = SEE_VALUE[piece_type(pos->board[from])] - swap;
    if (swap <= 0) return 1;

    Bitboard occ = pos->occupied ^ BB(from) ^ BB(to);
    int stm = pos->side;
    Bitboard attackers = attackers_to(pos, to, occ);
    Bitboard bishops = pieces_type(pos, BISHOP) | pieces_type(pos, QUEEN);
    Bitboard rooks = pieces_type(pos, ROOK) | pieces_type(pos, QUEEN);
    int res = 1;

    for (;;) {
        stm ^= 1;
        attackers &= occ;
        Bitboard stm_attackers = attackers & pos->by_color[stm];
        if (!stm_attackers) break;
        res ^= 1;

        Bitboard b;
        if ((b = stm_attackers & pieces_type(pos, PAWN))) {
            if ((swap = SEE_VALUE[PAWN] - swap) < res) break;
            occ ^= b & (~b + 1);
            attackers |= bishop_attacks(to, occ) & bishops;
        } else if ((b = stm_attackers & pieces_type(pos, KNIGHT))) {
            if ((swap = SEE_VALUE[KNIGHT] - swap) < res) break;
            occ ^= b & (~b + 1);
        } else if ((b = stm_attackers & pieces_type(pos, BISHOP))) {
            if ((swap = SEE_VALUE[BISHOP] - swap) < res) break;
            occ ^= b & (~b + 1);
            attackers |= bishop_attacks(to, occ) & bishops;
        } else if ((b = stm_attackers & pieces_type(pos, ROOK))) {
            if ((swap = SEE_VALUE[ROOK] - swap) < res) break;
            occ ^= b & (~b + 1);
            attackers |= rook_attacks(to, occ) & rooks;
        } else if ((b = stm_attackers & pieces_type(pos, QUEEN))) {
            if ((swap = SEE_VALUE[QUEEN] - swap) < res) break;
            occ ^= b & (~b + 1);
            attackers |= (bishop_attacks(to, occ) & bishops) | (rook_attacks(to, occ) & rooks);
        } else {
            // King capture: only legal if the opponent has no attackers left.
            return (attackers & ~pos->by_color[stm]) ? res ^ 1 : res;
        }
    }
    return res;
}

// ---------------------------------------------------------------------------
// Move strings
// ---------------------------------------------------------------------------

void move_to_str(const Position* pos, Move m, char out[6]) {
    if (m == MOVE_NONE) {
        strcpy(out, "0000");
        return;
    }
    int from = move_from(m), to = move_to(m);
    // Chess960 notation: castling is written as the king capturing its own rook.
    if (g_chess960 && move_is_castle(m))
        to = pos->castle_rook[castle_index(rank_of(from) == 0 ? WHITE : BLACK, move_flags(m) == FLAG_QUEEN_CASTLE)];
    out[0] = (char)('a' + file_of(from));
    out[1] = (char)('1' + rank_of(from));
    out[2] = (char)('a' + file_of(to));
    out[3] = (char)('1' + rank_of(to));
    out[4] = '\0';
    if (move_is_promo(m)) {
        out[4] = "nbrq"[move_promo_type(m) - KNIGHT];
        out[5] = '\0';
    }
}

Move pos_parse_move(Position* pos, const char* str) {
    MoveList list;
    generate_legal(pos, &list);
    for (int i = 0; i < list.count; ++i) {
        char buf[6];
        move_to_str(pos, list.moves[i].move, buf);
        if (strcmp(buf, str) == 0) return list.moves[i].move;
    }
    return MOVE_NONE;
}
