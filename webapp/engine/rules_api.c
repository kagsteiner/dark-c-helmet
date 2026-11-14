// Chess rules for the web app's UI, built from the engine's own board code (no search, no net).
//
// One game at a time: a start position (FEN) plus the moves played, so that threefold
// repetition sees the whole history. Strings returned to JavaScript live in a static buffer
// that is overwritten by the next call.

#include <emscripten.h>
#include <stdio.h>
#include <string.h>

#include "eval.h"
#include "movegen.h"
#include "perft.h"
#include "position.h"

static Position pos;
static Move played[MAX_GAME_PLY];
static int played_count = 0;
static char out[65536];
static const char* PROMO[] = {"n", "b", "r", "q"};

enum { STATE_ONGOING, STATE_CHECKMATE, STATE_STALEMATE, STATE_THREEFOLD, STATE_FIFTY, STATE_MATERIAL };

EMSCRIPTEN_KEEPALIVE void rules_init(void) {
    bitboards_init();
    position_init();
    eval_init();  // make/unmake keep the material + piece-square sums up to date
    pos_set_fen(&pos, START_FEN);
}

// Returns 1 if the FEN was accepted. chess960 only changes how castling is written in UCI
// moves: king takes own rook (e1h1) instead of e1g1.
EMSCRIPTEN_KEEPALIVE int rules_set_fen(const char* fen, int chess960) {
    g_chess960 = chess960;
    played_count = 0;
    return pos_set_fen(&pos, fen);
}

EMSCRIPTEN_KEEPALIVE const char* rules_fen(void) {
    pos_to_fen(&pos, out, sizeof(out));
    return out;
}

// Plays a move given in UCI notation. Returns 1 if it was legal.
EMSCRIPTEN_KEEPALIVE int rules_play(const char* uci) {
    Move m = pos_parse_move(&pos, uci);
    if (m == MOVE_NONE) return 0;
    if (pos.game_ply >= MAX_GAME_PLY - 1) {
        // History full (1000+ plies): restart it from the current position.
        char fen[128];
        pos_to_fen(&pos, fen, sizeof(fen));
        pos_set_fen(&pos, fen);
        played_count = 0;
    }
    pos_make_move(&pos, m);
    played[played_count++] = m;
    return 1;
}

// Takes back the last move. Returns 0 if there is none.
EMSCRIPTEN_KEEPALIVE int rules_undo(void) {
    if (!played_count) return 0;
    pos_unmake_move(&pos, played[--played_count]);
    return 1;
}

static int insufficient_material(void) {
    if (pieces_type(&pos, PAWN) | pieces_type(&pos, ROOK) | pieces_type(&pos, QUEEN)) return 0;
    return popcount(pos.occupied) <= 3;  // kings and at most one minor piece
}

static int game_state(void) {
    MoveList list;
    generate_legal(&pos, &list);
    if (list.count == 0) return in_check(&pos) ? STATE_CHECKMATE : STATE_STALEMATE;
    if (pos.st->rule50 >= 100) return STATE_FIFTY;
    if (pos_is_repetition(&pos, 0)) return STATE_THREEFOLD;
    if (insufficient_material()) return STATE_MATERIAL;
    return STATE_ONGOING;
}

// 0 ongoing, 1 checkmate, 2 stalemate, 3 threefold repetition, 4 fifty-move rule,
// 5 insufficient material.
EMSCRIPTEN_KEEPALIVE int rules_state(void) { return game_state(); }

EMSCRIPTEN_KEEPALIVE int rules_in_check(void) { return in_check(&pos) ? 1 : 0; }

// The legal moves as JSON, with what the UI needs for input and notation:
//   uci      move as the engine reads it (Chess960 castling: king takes own rook)
//   from,to  squares 0-63 (a1 = 0); for castling `to` is the king's target square
//   rook     castling only: the rook's start square
//   piece    "PNBRQK"; capture, promo ("nbrq" or ""), check, mate
EMSCRIPTEN_KEEPALIVE const char* rules_moves(void) {
    MoveList list;
    generate_legal(&pos, &list);
    int n = 0;
    n += snprintf(out + n, sizeof(out) - n, "[");
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        int from = move_from(m), to = move_to(m), us = pos.side;
        char uci[6];
        move_to_str(&pos, m, uci);
        int castle = move_is_castle(m);
        int rook = castle ? pos.castle_rook[castle_index(us, move_flags(m) == FLAG_QUEEN_CASTLE)] : -1;
        int capture = move_is_capture(m) ? 1 : 0;  // includes en passant
        const char* promo = move_is_promo(m) ? PROMO[move_promo_type(m) - KNIGHT] : "";
        char piece = "PNBRQK"[piece_type(piece_on(&pos, from))];

        pos_make_move(&pos, m);
        int check = in_check(&pos) ? 1 : 0, mate = 0;
        if (check) {
            MoveList replies;
            generate_legal(&pos, &replies);
            mate = replies.count == 0;
        }
        pos_unmake_move(&pos, m);

        n += snprintf(out + n, sizeof(out) - n,
                      "%s{\"uci\":\"%s\",\"from\":%d,\"to\":%d,\"rook\":%d,\"piece\":\"%c\",\"capture\":%d,"
                      "\"promo\":\"%s\",\"castle\":%d,\"check\":%d,\"mate\":%d}",
                      i ? "," : "", uci, from, to, rook, piece, capture, promo, castle, check, mate);
    }
    snprintf(out + n, sizeof(out) - n, "]");
    return out;
}

// Number of leaf nodes at the given depth (tests).
EMSCRIPTEN_KEEPALIVE double rules_perft(int depth) { return (double)perft(&pos, depth); }

// Pieces the opponent wins material on by capturing them (static exchange evaluation: the
// capture sequence on that square, cheapest attacker first, each side free to stop). Both
// colours: the side to move's captures as they stand, the other side's after a null move
// (not when in check). JSON array of squares 0-63.
static void hanging_squares(Bitboard* found) {
    MoveList list;
    generate_legal(&pos, &list);
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        if (move_is_capture(m) && see_ge(&pos, m, 1)) *found |= BB(move_to(m));
    }
}

EMSCRIPTEN_KEEPALIVE const char* rules_hanging(void) {
    Bitboard found = 0;
    hanging_squares(&found);
    if (!in_check(&pos)) {
        pos_make_null(&pos);
        hanging_squares(&found);
        pos_unmake_null(&pos);
    }
    int n = snprintf(out, sizeof(out), "[");
    int first = 1;
    for (int sq = 0; sq < 64; ++sq) {
        if (!(found & BB(sq))) continue;
        n += snprintf(out + n, sizeof(out) - n, "%s%d", first ? "" : ",", sq);
        first = 0;
    }
    snprintf(out + n, sizeof(out) - n, "]");
    return out;
}

// The position with the side to move passing (a null move), to ask what the opponent
// threatens. Empty when the side to move is in check.
EMSCRIPTEN_KEEPALIVE const char* rules_null_fen(void) {
    if (in_check(&pos)) {
        out[0] = '\0';
        return out;
    }
    pos_make_null(&pos);
    pos_to_fen(&pos, out, sizeof(out));
    pos_unmake_null(&pos);
    return out;
}
