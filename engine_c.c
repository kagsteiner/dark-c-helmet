#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define strtok_r strtok_s
#endif

#define MAX_MOVES 256
#define MAX_LINE 4096
#define MAX_DEPTH 64
#define MAX_HISTORY 4096

#define INF 1000000
#define MATE_SCORE 900000
#define DEFAULT_TT_MB 64

enum {
    PIECE_EMPTY = 0,
    PIECE_PAWN = 1,
    PIECE_KNIGHT = 2,
    PIECE_BISHOP = 3,
    PIECE_ROOK = 4,
    PIECE_QUEEN = 5,
    PIECE_KING = 6
};

enum {
    COLOR_WHITE = 0,
    COLOR_BLACK = 1
};

enum {
    CASTLE_WHITE_K = 1,
    CASTLE_WHITE_Q = 2,
    CASTLE_BLACK_K = 4,
    CASTLE_BLACK_Q = 8
};

enum {
    MOVE_FLAG_NONE = 0,
    MOVE_FLAG_CASTLE = 1,
    MOVE_FLAG_EP = 2
};

enum {
    TT_FLAG_EXACT = 0,
    TT_FLAG_LOWER = 1,
    TT_FLAG_UPPER = 2
};

typedef struct {
    int from;
    int to;
    int promo;
    int flags;
    int score;
} Move;

typedef struct {
    Move move;
    int captured;
    int castling;
    int ep_sq;
    int halfmove;
    int fullmove;
    int moved_piece;
    int king_sq_white;
    int king_sq_black;
} Undo;

typedef struct {
    int squares[64];
    int side_to_move;
    int castling_rights;
    int ep_sq;
    int halfmove_clock;
    int fullmove_number;
    int king_sq[2];
    Undo history[MAX_HISTORY];
    int history_count;
} Board;

typedef struct {
    int depth;
    int seldepth;
    int nodes;
    int score;
    long long time_ms;
    Move best_move;
    int has_best;
} SearchInfo;

typedef struct {
    int stop;
    int nodes;
    int max_seldepth;
    long long start_ms;
    long long stop_ms;
    int max_depth;
    Move pv_table[MAX_DEPTH + 1][MAX_DEPTH + 1];
    int pv_len[MAX_DEPTH + 1];
    Move killers[MAX_DEPTH + 1][2];
    int history[2][64][64];
    Move tt_move_stack[MAX_DEPTH + 1];
} SearchContext;

typedef struct {
    uint64_t key;
    int depth;
    int score;
    int flag;
    Move best_move;
    int age;
    int used;
} TTEntry;

typedef struct {
    TTEntry* entries;
    size_t size;
    int age;
} TranspositionTable;

static TranspositionTable g_tt = {0};

static const char* ENGINE_NAME = "Dark C. Helmet 0.1";
static const char* ENGINE_AUTHOR = "Karlheinz + Cursor";

static const int PIECE_VALUES[7] = {0, 100, 320, 330, 500, 900, 20000};
static uint64_t zobrist_piece[16][64];
static uint64_t zobrist_castling[16];
static uint64_t zobrist_ep[8];
static uint64_t zobrist_side;

static const int KNIGHT_PST[64] = {
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20,   0,   0,   0,   0, -20, -40,
    -30,   0,  10,  15,  15,  10,   0, -30,
    -30,   5,  15,  20,  20,  15,   5, -30,
    -30,   0,  15,  20,  20,  15,   0, -30,
    -30,   5,  10,  15,  15,  10,   5, -30,
    -40, -20,   0,   5,   5,   0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50
};

static const int BISHOP_PST[64] = {
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10,   0,   0,   0,   0,   0,   0, -10,
    -10,   0,   5,  10,  10,   5,   0, -10,
    -10,   5,   5,  10,  10,   5,   5, -10,
    -10,   0,  10,  10,  10,  10,   0, -10,
    -10,  10,  10,  10,  10,  10,  10, -10,
    -10,   5,   0,   0,   0,   0,   5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20
};

static const int PAWN_PST[64] = {
     0,   0,   0,   0,   0,   0,   0,   0,
    50,  50,  50,  50,  50,  50,  50,  50,
    10,  10,  20,  30,  30,  20,  10,  10,
     5,   5,  10,  25,  25,  10,   5,   5,
     0,   0,   0,  20,  20,   0,   0,   0,
     5,  -5, -10,   0,   0, -10,  -5,   5,
     5,  10,  10, -20, -20,  10,  10,   5,
     0,   0,   0,   0,   0,   0,   0,   0
};

static const int ROOK_PST[64] = {
     0,   0,   0,   0,   0,   0,   0,   0,
     5,  10,  10,  10,  10,  10,  10,   5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
     0,   0,   0,   5,   5,   0,   0,   0
};

static const int QUEEN_PST[64] = {
    -20, -10, -10,  -5,  -5, -10, -10, -20,
    -10,   0,   0,   0,   0,   0,   0, -10,
    -10,   0,   5,   5,   5,   5,   0, -10,
     -5,   0,   5,   5,   5,   5,   0,  -5,
      0,   0,   5,   5,   5,   5,   0,  -5,
    -10,   5,   5,   5,   5,   5,   0, -10,
    -10,   0,   5,   0,   0,   0,   0, -10,
    -20, -10, -10,  -5,  -5, -10, -10, -20
};

static const int KING_MIDDLEGAME_PST[64] = {
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
     20,  20,   0,   0,   0,   0,  20,  20,
     20,  30,  10,   0,   0,  10,  30,  20
};

static const int KING_ENDGAME_PST[64] = {
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10,   0,   0, -10, -20, -30,
    -30, -10,  20,  30,  30,  20, -10, -30,
    -30, -10,  30,  40,  40,  30, -10, -30,
    -30, -10,  30,  40,  40,  30, -10, -30,
    -30, -10,  20,  30,  30,  20, -10, -30,
    -30, -30,   0,   0,   0,   0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50
};

static const int PASSED_PAWN_BONUS[8] = {0, 10, 20, 40, 60, 100, 150, 0};
static const int ENDGAME_PASSED_PAWN_BONUS[8] = {0, 20, 40, 80, 130, 200, 300, 0};
static const int ENDGAME_ADVANCED_PAWN_BONUS[8] = {0, 0, 5, 10, 20, 35, 50, 0};

#define ENDGAME_KING_CENTRALIZATION_BONUS 10
#define ENDGAME_KING_PAWN_PROXIMITY_BONUS 5
#define ROOK_BEHIND_PASSED_PAWN_BONUS 30
#define DOUBLED_PAWN_PENALTY 20
#define ISOLATED_PAWN_PENALTY 25
#define BACKWARD_PAWN_PENALTY 15
#define BISHOP_PAIR_BONUS 30
#define ROOK_OPEN_FILE_BONUS 25
#define ROOK_SEMI_OPEN_FILE_BONUS 15
#define ROOK_ON_SEVENTH_BONUS 20
#define CONNECTED_ROOKS_BONUS 10
#define KING_PAWN_SHIELD_BONUS 10
#define CENTER_PAWN_BONUS 30
#define EXTENDED_CENTER_PAWN_BONUS 15
#define DEVELOPMENT_BONUS 25
#define UNDEVELOPED_PENALTY 15
#define CASTLED_BONUS 50
#define CASTLING_RIGHTS_BONUS 15
#define EARLY_QUEEN_PENALTY 30
#define KNIGHT_GOOD_OUTPOST_BONUS 15
#define KNIGHT_RIM_PENALTY 25
#define BISHOP_UNDEVELOPED_PENALTY 35
#define ROOK_TRAPPED_BEHIND_BISHOP_PENALTY 50

// Attack Module v1 (middlegame attack planning signals)
#define ENABLE_ATTACK_MODULE_V1 1
#define ATTACK_V1_ZONE_HIT_MINOR 6
#define ATTACK_V1_ZONE_HIT_ROOK 9
#define ATTACK_V1_ZONE_HIT_QUEEN 14
#define ATTACK_V1_UNIT_MINOR 2
#define ATTACK_V1_UNIT_ROOK 3
#define ATTACK_V1_UNIT_QUEEN 5
#define ATTACK_V1_FILE_OPEN_BONUS 16
#define ATTACK_V1_FILE_SEMIOPEN_BONUS 9
#define ATTACK_V1_PAWN_STORM_STEP 6
#define ATTACK_V1_TROPISM_DIV 8

static const int ATTACK_V1_ATTACKER_SCALE[8] = {0, 0, 45, 70, 85, 95, 100, 105};

static inline int piece_type(int p) { return p & 7; }
static inline int piece_color(int p) { return p >> 3; }
static inline int make_piece(int color, int ptype) { return (color << 3) | ptype; }
static inline int rank_of(int sq) { return sq >> 3; }
static inline int file_of(int sq) { return sq & 7; }
static inline int square_of(int rank, int file) { return rank * 8 + file; }

static long long now_ms(void) {
    struct timespec ts;
    timespec_get(&ts, TIME_UTC);
    return (long long)ts.tv_sec * 1000LL + (long long)(ts.tv_nsec / 1000000LL);
}

static void move_to_uci(const Move* move, char out[8]) {
    out[0] = (char)('a' + file_of(move->from));
    out[1] = (char)('1' + rank_of(move->from));
    out[2] = (char)('a' + file_of(move->to));
    out[3] = (char)('1' + rank_of(move->to));
    if (move->promo) {
        char promo = 'q';
        if (move->promo == PIECE_ROOK) promo = 'r';
        else if (move->promo == PIECE_BISHOP) promo = 'b';
        else if (move->promo == PIECE_KNIGHT) promo = 'n';
        out[4] = promo;
        out[5] = '\0';
    } else {
        out[4] = '\0';
    }
}

static uint64_t splitmix64_next(uint64_t* x) {
    uint64_t z = (*x += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

static void init_zobrist(void) {
    static int initialized = 0;
    if (initialized) return;
    initialized = 1;

    uint64_t seed = 0x123456789ABCDEF0ULL;
    for (int p = 0; p < 16; ++p) {
        for (int sq = 0; sq < 64; ++sq) {
            zobrist_piece[p][sq] = splitmix64_next(&seed);
        }
    }
    for (int i = 0; i < 16; ++i) zobrist_castling[i] = splitmix64_next(&seed);
    for (int i = 0; i < 8; ++i) zobrist_ep[i] = splitmix64_next(&seed);
    zobrist_side = splitmix64_next(&seed);
}

static uint64_t board_hash(const Board* b) {
    uint64_t h = 0;
    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (p) h ^= zobrist_piece[p][sq];
    }
    h ^= zobrist_castling[b->castling_rights & 15];
    if (b->ep_sq >= 0) h ^= zobrist_ep[file_of(b->ep_sq)];
    if (b->side_to_move == COLOR_BLACK) h ^= zobrist_side;
    return h;
}

static void tt_free(TranspositionTable* tt) {
    if (tt->entries) free(tt->entries);
    tt->entries = NULL;
    tt->size = 0;
    tt->age = 0;
}

static void tt_init_mb(TranspositionTable* tt, int size_mb) {
    if (size_mb < 1) size_mb = 1;
    size_t bytes = (size_t)size_mb * 1024ULL * 1024ULL;
    size_t entry_size = sizeof(TTEntry);
    size_t n = bytes / entry_size;
    if (n < 1024) n = 1024;

    tt_free(tt);
    tt->entries = (TTEntry*)calloc(n, sizeof(TTEntry));
    if (!tt->entries) {
        tt->size = 0;
        tt->age = 0;
        return;
    }
    tt->size = n;
    tt->age = 0;
}

static void tt_clear(TranspositionTable* tt) {
    if (!tt->entries || tt->size == 0) return;
    memset(tt->entries, 0, tt->size * sizeof(TTEntry));
    tt->age = 0;
}

static void tt_new_search(TranspositionTable* tt) {
    tt->age++;
}

static TTEntry* tt_probe(TranspositionTable* tt, uint64_t key) {
    if (!tt->entries || tt->size == 0) return NULL;
    TTEntry* e = &tt->entries[key % tt->size];
    if (e->used && e->key == key) return e;
    return NULL;
}

static void tt_store(TranspositionTable* tt, uint64_t key, int depth, int score, int flag, const Move* best_move) {
    if (!tt->entries || tt->size == 0) return;
    TTEntry* e = &tt->entries[key % tt->size];
    if (!e->used || e->key == key || depth >= e->depth || tt->age > e->age + 1) {
        e->used = 1;
        e->key = key;
        e->depth = depth;
        e->score = score;
        e->flag = flag;
        e->best_move = best_move ? *best_move : (Move){0};
        e->age = tt->age;
    }
}

static int tt_hashfull_permille(const TranspositionTable* tt) {
    if (!tt->entries || tt->size == 0) return 0;
    int sample = (tt->size < 1000) ? (int)tt->size : 1000;
    int used = 0;
    for (int i = 0; i < sample; ++i) used += tt->entries[i].used ? 1 : 0;
    return (used * 1000) / sample;
}

static int parse_square_str(const char* s) {
    if (!s || strlen(s) < 2) return -1;
    int file = s[0] - 'a';
    int rank = s[1] - '1';
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
    return square_of(rank, file);
}

static int char_to_piece(char c) {
    switch (c) {
        case 'P': return make_piece(COLOR_WHITE, PIECE_PAWN);
        case 'N': return make_piece(COLOR_WHITE, PIECE_KNIGHT);
        case 'B': return make_piece(COLOR_WHITE, PIECE_BISHOP);
        case 'R': return make_piece(COLOR_WHITE, PIECE_ROOK);
        case 'Q': return make_piece(COLOR_WHITE, PIECE_QUEEN);
        case 'K': return make_piece(COLOR_WHITE, PIECE_KING);
        case 'p': return make_piece(COLOR_BLACK, PIECE_PAWN);
        case 'n': return make_piece(COLOR_BLACK, PIECE_KNIGHT);
        case 'b': return make_piece(COLOR_BLACK, PIECE_BISHOP);
        case 'r': return make_piece(COLOR_BLACK, PIECE_ROOK);
        case 'q': return make_piece(COLOR_BLACK, PIECE_QUEEN);
        case 'k': return make_piece(COLOR_BLACK, PIECE_KING);
        default: return PIECE_EMPTY;
    }
}

static void board_clear(Board* b) {
    memset(b, 0, sizeof(*b));
    b->ep_sq = -1;
    b->fullmove_number = 1;
}

static int board_set_fen(Board* b, const char* fen) {
    board_clear(b);
    char buf[256];
    strncpy(buf, fen, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char* parts[6] = {0};
    char* saveptr = NULL;
    char* tok = strtok_r(buf, " ", &saveptr);
    int n = 0;
    while (tok && n < 6) {
        parts[n++] = tok;
        tok = strtok_r(NULL, " ", &saveptr);
    }
    if (n < 4) return 0;

    int rank = 7;
    int file = 0;
    for (size_t i = 0; i < strlen(parts[0]); ++i) {
        char c = parts[0][i];
        if (c == '/') {
            rank--;
            file = 0;
            continue;
        }
        if (isdigit((unsigned char)c)) {
            file += c - '0';
            continue;
        }
        int sq = square_of(rank, file);
        int p = char_to_piece(c);
        b->squares[sq] = p;
        if (piece_type(p) == PIECE_KING) {
            b->king_sq[piece_color(p)] = sq;
        }
        file++;
    }

    b->side_to_move = (parts[1][0] == 'w') ? COLOR_WHITE : COLOR_BLACK;
    b->castling_rights = 0;
    if (strchr(parts[2], 'K')) b->castling_rights |= CASTLE_WHITE_K;
    if (strchr(parts[2], 'Q')) b->castling_rights |= CASTLE_WHITE_Q;
    if (strchr(parts[2], 'k')) b->castling_rights |= CASTLE_BLACK_K;
    if (strchr(parts[2], 'q')) b->castling_rights |= CASTLE_BLACK_Q;

    b->ep_sq = (parts[3][0] == '-') ? -1 : parse_square_str(parts[3]);
    if (n > 4) b->halfmove_clock = atoi(parts[4]);
    if (n > 5) b->fullmove_number = atoi(parts[5]);
    b->history_count = 0;
    return 1;
}

static void board_set_startpos(Board* b) {
    board_set_fen(b, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

static int is_square_attacked(const Board* b, int sq, int by_color) {
    int r = rank_of(sq);
    int f = file_of(sq);

    int pawn = make_piece(by_color, PIECE_PAWN);
    if (by_color == COLOR_WHITE) {
        if (r > 0 && f > 0 && b->squares[sq - 9] == pawn) return 1;
        if (r > 0 && f < 7 && b->squares[sq - 7] == pawn) return 1;
    } else {
        if (r < 7 && f > 0 && b->squares[sq + 7] == pawn) return 1;
        if (r < 7 && f < 7 && b->squares[sq + 9] == pawn) return 1;
    }

    static const int n_offsets[8][2] = {
        {-2, -1}, {-2, 1}, {-1, -2}, {-1, 2},
        {1, -2}, {1, 2}, {2, -1}, {2, 1}
    };
    int knight = make_piece(by_color, PIECE_KNIGHT);
    for (int i = 0; i < 8; ++i) {
        int nr = r + n_offsets[i][0], nf = f + n_offsets[i][1];
        if (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
            if (b->squares[square_of(nr, nf)] == knight) return 1;
        }
    }

    int king = make_piece(by_color, PIECE_KING);
    for (int dr = -1; dr <= 1; ++dr) {
        for (int df = -1; df <= 1; ++df) {
            if (dr == 0 && df == 0) continue;
            int nr = r + dr, nf = f + df;
            if (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
                if (b->squares[square_of(nr, nf)] == king) return 1;
            }
        }
    }

    static const int bishop_dirs[4][2] = {{-1,-1},{-1,1},{1,-1},{1,1}};
    static const int rook_dirs[4][2] = {{-1,0},{1,0},{0,-1},{0,1}};
    int bishop = make_piece(by_color, PIECE_BISHOP);
    int rook = make_piece(by_color, PIECE_ROOK);
    int queen = make_piece(by_color, PIECE_QUEEN);

    for (int i = 0; i < 4; ++i) {
        int nr = r + bishop_dirs[i][0], nf = f + bishop_dirs[i][1];
        while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
            int p = b->squares[square_of(nr, nf)];
            if (p) {
                if (p == bishop || p == queen) return 1;
                break;
            }
            nr += bishop_dirs[i][0];
            nf += bishop_dirs[i][1];
        }
    }

    for (int i = 0; i < 4; ++i) {
        int nr = r + rook_dirs[i][0], nf = f + rook_dirs[i][1];
        while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
            int p = b->squares[square_of(nr, nf)];
            if (p) {
                if (p == rook || p == queen) return 1;
                break;
            }
            nr += rook_dirs[i][0];
            nf += rook_dirs[i][1];
        }
    }

    return 0;
}

static int is_in_check(const Board* b, int color) {
    return is_square_attacked(b, b->king_sq[color], color ^ 1);
}

static void add_move(Move* list, int* count, int from, int to, int promo, int flags) {
    if (*count >= MAX_MOVES) return;
    list[*count].from = from;
    list[*count].to = to;
    list[*count].promo = promo;
    list[*count].flags = flags;
    list[*count].score = 0;
    (*count)++;
}

static void gen_pseudo_moves(const Board* b, Move* moves, int* count, int captures_only) {
    *count = 0;
    int color = b->side_to_move;
    int enemy = color ^ 1;

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p || piece_color(p) != color) continue;
        int ptype = piece_type(p);
        int r = rank_of(sq), f = file_of(sq);

        if (ptype == PIECE_PAWN) {
            int dir = (color == COLOR_WHITE) ? 1 : -1;
            int start_rank = (color == COLOR_WHITE) ? 1 : 6;
            int promo_rank = (color == COLOR_WHITE) ? 7 : 0;

            if (!captures_only) {
                int to = sq + dir * 8;
                if (to >= 0 && to < 64 && b->squares[to] == PIECE_EMPTY) {
                    if (rank_of(to) == promo_rank) {
                        add_move(moves, count, sq, to, PIECE_QUEEN, MOVE_FLAG_NONE);
                        add_move(moves, count, sq, to, PIECE_ROOK, MOVE_FLAG_NONE);
                        add_move(moves, count, sq, to, PIECE_BISHOP, MOVE_FLAG_NONE);
                        add_move(moves, count, sq, to, PIECE_KNIGHT, MOVE_FLAG_NONE);
                    } else {
                        add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                        if (r == start_rank) {
                            int to2 = sq + dir * 16;
                            if (b->squares[to2] == PIECE_EMPTY) {
                                add_move(moves, count, sq, to2, 0, MOVE_FLAG_NONE);
                            }
                        }
                    }
                }
            }

            for (int df = -1; df <= 1; df += 2) {
                int nf = f + df;
                if (nf < 0 || nf > 7) continue;
                int to = sq + dir * 8 + df;
                if (to < 0 || to >= 64) continue;
                int target = b->squares[to];
                if (target && piece_color(target) == enemy) {
                    if (rank_of(to) == promo_rank) {
                        add_move(moves, count, sq, to, PIECE_QUEEN, MOVE_FLAG_NONE);
                        add_move(moves, count, sq, to, PIECE_ROOK, MOVE_FLAG_NONE);
                        add_move(moves, count, sq, to, PIECE_BISHOP, MOVE_FLAG_NONE);
                        add_move(moves, count, sq, to, PIECE_KNIGHT, MOVE_FLAG_NONE);
                    } else {
                        add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                    }
                } else if (to == b->ep_sq) {
                    add_move(moves, count, sq, to, 0, MOVE_FLAG_EP);
                }
            }
        } else if (ptype == PIECE_KNIGHT) {
            static const int n_offsets[8][2] = {
                {-2, -1}, {-2, 1}, {-1, -2}, {-1, 2},
                {1, -2}, {1, 2}, {2, -1}, {2, 1}
            };
            for (int i = 0; i < 8; ++i) {
                int nr = r + n_offsets[i][0], nf = f + n_offsets[i][1];
                if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
                int to = square_of(nr, nf);
                int target = b->squares[to];
                if (target == PIECE_EMPTY) {
                    if (!captures_only) add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                } else if (piece_color(target) == enemy) {
                    add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                }
            }
        } else if (ptype == PIECE_BISHOP || ptype == PIECE_ROOK || ptype == PIECE_QUEEN) {
            static const int bishop_dirs[4][2] = {{-1,-1},{-1,1},{1,-1},{1,1}};
            static const int rook_dirs[4][2] = {{-1,0},{1,0},{0,-1},{0,1}};
            const int (*dirs)[2] = NULL;
            int dir_count = 0;

            if (ptype == PIECE_BISHOP) {
                dirs = bishop_dirs;
                dir_count = 4;
            } else if (ptype == PIECE_ROOK) {
                dirs = rook_dirs;
                dir_count = 4;
            } else {
                static const int queen_dirs[8][2] = {
                    {-1,-1},{-1,1},{1,-1},{1,1},{-1,0},{1,0},{0,-1},{0,1}
                };
                dirs = queen_dirs;
                dir_count = 8;
            }

            for (int i = 0; i < dir_count; ++i) {
                int nr = r + dirs[i][0], nf = f + dirs[i][1];
                while (nr >= 0 && nr <= 7 && nf >= 0 && nf <= 7) {
                    int to = square_of(nr, nf);
                    int target = b->squares[to];
                    if (target == PIECE_EMPTY) {
                        if (!captures_only) add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                    } else {
                        if (piece_color(target) == enemy) {
                            add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                        }
                        break;
                    }
                    nr += dirs[i][0];
                    nf += dirs[i][1];
                }
            }
        } else if (ptype == PIECE_KING) {
            for (int dr = -1; dr <= 1; ++dr) {
                for (int df = -1; df <= 1; ++df) {
                    if (dr == 0 && df == 0) continue;
                    int nr = r + dr, nf = f + df;
                    if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
                    int to = square_of(nr, nf);
                    int target = b->squares[to];
                    if (target == PIECE_EMPTY) {
                        if (!captures_only) add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                    } else if (piece_color(target) == enemy) {
                        add_move(moves, count, sq, to, 0, MOVE_FLAG_NONE);
                    }
                }
            }

            if (!captures_only && !is_in_check(b, color)) {
                if (color == COLOR_WHITE) {
                    if ((b->castling_rights & CASTLE_WHITE_K) &&
                        b->squares[5] == PIECE_EMPTY && b->squares[6] == PIECE_EMPTY &&
                        !is_square_attacked(b, 5, enemy) && !is_square_attacked(b, 6, enemy)) {
                        add_move(moves, count, 4, 6, 0, MOVE_FLAG_CASTLE);
                    }
                    if ((b->castling_rights & CASTLE_WHITE_Q) &&
                        b->squares[1] == PIECE_EMPTY && b->squares[2] == PIECE_EMPTY && b->squares[3] == PIECE_EMPTY &&
                        !is_square_attacked(b, 3, enemy) && !is_square_attacked(b, 2, enemy)) {
                        add_move(moves, count, 4, 2, 0, MOVE_FLAG_CASTLE);
                    }
                } else {
                    if ((b->castling_rights & CASTLE_BLACK_K) &&
                        b->squares[61] == PIECE_EMPTY && b->squares[62] == PIECE_EMPTY &&
                        !is_square_attacked(b, 61, enemy) && !is_square_attacked(b, 62, enemy)) {
                        add_move(moves, count, 60, 62, 0, MOVE_FLAG_CASTLE);
                    }
                    if ((b->castling_rights & CASTLE_BLACK_Q) &&
                        b->squares[57] == PIECE_EMPTY && b->squares[58] == PIECE_EMPTY && b->squares[59] == PIECE_EMPTY &&
                        !is_square_attacked(b, 59, enemy) && !is_square_attacked(b, 58, enemy)) {
                        add_move(moves, count, 60, 58, 0, MOVE_FLAG_CASTLE);
                    }
                }
            }
        }
    }
}

static int board_make_move(Board* b, const Move* move) {
    if (b->history_count >= MAX_HISTORY) return 0;
    int from = move->from;
    int to = move->to;
    int p = b->squares[from];
    if (!p) return 0;

    Undo* u = &b->history[b->history_count++];
    memset(u, 0, sizeof(*u));
    u->move = *move;
    u->castling = b->castling_rights;
    u->ep_sq = b->ep_sq;
    u->halfmove = b->halfmove_clock;
    u->fullmove = b->fullmove_number;
    u->moved_piece = p;
    u->king_sq_white = b->king_sq[COLOR_WHITE];
    u->king_sq_black = b->king_sq[COLOR_BLACK];

    int captured = b->squares[to];
    if (move->flags & MOVE_FLAG_EP) {
        int ep_cap_sq = to + ((b->side_to_move == COLOR_WHITE) ? -8 : 8);
        captured = b->squares[ep_cap_sq];
        b->squares[ep_cap_sq] = PIECE_EMPTY;
    }
    u->captured = captured;

    b->squares[from] = PIECE_EMPTY;
    int moved = p;
    if (move->promo) {
        moved = make_piece(piece_color(p), move->promo);
    }
    b->squares[to] = moved;

    int side = b->side_to_move;
    int ptype = piece_type(p);
    if (ptype == PIECE_KING) {
        b->king_sq[side] = to;
        if (side == COLOR_WHITE) b->castling_rights &= ~(CASTLE_WHITE_K | CASTLE_WHITE_Q);
        else b->castling_rights &= ~(CASTLE_BLACK_K | CASTLE_BLACK_Q);
    }
    if (ptype == PIECE_ROOK) {
        if (from == 0) b->castling_rights &= ~CASTLE_WHITE_Q;
        if (from == 7) b->castling_rights &= ~CASTLE_WHITE_K;
        if (from == 56) b->castling_rights &= ~CASTLE_BLACK_Q;
        if (from == 63) b->castling_rights &= ~CASTLE_BLACK_K;
    }
    if (captured && piece_type(captured) == PIECE_ROOK) {
        if (to == 0) b->castling_rights &= ~CASTLE_WHITE_Q;
        if (to == 7) b->castling_rights &= ~CASTLE_WHITE_K;
        if (to == 56) b->castling_rights &= ~CASTLE_BLACK_Q;
        if (to == 63) b->castling_rights &= ~CASTLE_BLACK_K;
    }

    if (move->flags & MOVE_FLAG_CASTLE) {
        if (to == 6) {
            b->squares[5] = b->squares[7];
            b->squares[7] = PIECE_EMPTY;
        } else if (to == 2) {
            b->squares[3] = b->squares[0];
            b->squares[0] = PIECE_EMPTY;
        } else if (to == 62) {
            b->squares[61] = b->squares[63];
            b->squares[63] = PIECE_EMPTY;
        } else if (to == 58) {
            b->squares[59] = b->squares[56];
            b->squares[56] = PIECE_EMPTY;
        }
    }

    if (ptype == PIECE_PAWN || captured) b->halfmove_clock = 0;
    else b->halfmove_clock++;

    b->ep_sq = -1;
    if (ptype == PIECE_PAWN && abs(to - from) == 16) {
        b->ep_sq = (from + to) / 2;
    }

    b->side_to_move ^= 1;
    if (b->side_to_move == COLOR_WHITE) b->fullmove_number++;
    return 1;
}

static void board_unmake_move(Board* b) {
    if (b->history_count <= 0) return;
    Undo* u = &b->history[--b->history_count];
    Move* m = &u->move;

    b->side_to_move ^= 1;
    b->castling_rights = u->castling;
    b->ep_sq = u->ep_sq;
    b->halfmove_clock = u->halfmove;
    b->fullmove_number = u->fullmove;
    b->king_sq[COLOR_WHITE] = u->king_sq_white;
    b->king_sq[COLOR_BLACK] = u->king_sq_black;

    b->squares[m->from] = u->moved_piece;
    b->squares[m->to] = PIECE_EMPTY;

    if (m->flags & MOVE_FLAG_CASTLE) {
        if (m->to == 6) {
            b->squares[7] = b->squares[5];
            b->squares[5] = PIECE_EMPTY;
        } else if (m->to == 2) {
            b->squares[0] = b->squares[3];
            b->squares[3] = PIECE_EMPTY;
        } else if (m->to == 62) {
            b->squares[63] = b->squares[61];
            b->squares[61] = PIECE_EMPTY;
        } else if (m->to == 58) {
            b->squares[56] = b->squares[59];
            b->squares[59] = PIECE_EMPTY;
        }
    }

    if (m->flags & MOVE_FLAG_EP) {
        int ep_cap_sq = m->to + ((b->side_to_move == COLOR_WHITE) ? -8 : 8);
        b->squares[ep_cap_sq] = u->captured;
    } else if (u->captured) {
        b->squares[m->to] = u->captured;
    }
}

static int generate_legal_moves(Board* b, Move* out, int captures_only) {
    Move pseudo[MAX_MOVES];
    int pseudo_n = 0;
    gen_pseudo_moves(b, pseudo, &pseudo_n, captures_only);

    int legal_n = 0;
    int side = b->side_to_move;
    for (int i = 0; i < pseudo_n; ++i) {
        if (!board_make_move(b, &pseudo[i])) continue;
        if (!is_in_check(b, side)) {
            out[legal_n++] = pseudo[i];
        }
        board_unmake_move(b);
    }
    return legal_n;
}

static int get_pst_value(int ptype, int sq, int color, int is_endgame) {
    int psq = (color == COLOR_WHITE) ? sq : (63 - sq);
    if (ptype == PIECE_PAWN) return PAWN_PST[psq];
    if (ptype == PIECE_KNIGHT) return KNIGHT_PST[psq];
    if (ptype == PIECE_BISHOP) return BISHOP_PST[psq];
    if (ptype == PIECE_ROOK) return ROOK_PST[psq];
    if (ptype == PIECE_QUEEN) return QUEEN_PST[psq];
    if (ptype == PIECE_KING) return is_endgame ? KING_ENDGAME_PST[psq] : KING_MIDDLEGAME_PST[psq];
    return 0;
}

static int check_path_clear(const Board* b, int sq1, int sq2) {
    if (rank_of(sq1) == rank_of(sq2)) {
        int f1 = file_of(sq1), f2 = file_of(sq2);
        if (f1 > f2) { int t = f1; f1 = f2; f2 = t; }
        for (int f = f1 + 1; f < f2; ++f) {
            if (b->squares[square_of(rank_of(sq1), f)] != PIECE_EMPTY) return 0;
        }
    } else {
        int r1 = rank_of(sq1), r2 = rank_of(sq2);
        if (r1 > r2) { int t = r1; r1 = r2; r2 = t; }
        for (int r = r1 + 1; r < r2; ++r) {
            if (b->squares[square_of(r, file_of(sq1))] != PIECE_EMPTY) return 0;
        }
    }
    return 1;
}

static int get_game_phase(const Board* b) {
    int piece_count[2][7] = {{0}};
    int material[2] = {0, 0};

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p) continue;
        int c = piece_color(p);
        int t = piece_type(p);
        piece_count[c][t]++;
        if (t != PIECE_KING) material[c] += PIECE_VALUES[t];
    }

    int white_queens = piece_count[COLOR_WHITE][PIECE_QUEEN];
    int black_queens = piece_count[COLOR_BLACK][PIECE_QUEEN];
    int white_rooks = piece_count[COLOR_WHITE][PIECE_ROOK];
    int black_rooks = piece_count[COLOR_BLACK][PIECE_ROOK];
    int white_minors = piece_count[COLOR_WHITE][PIECE_KNIGHT] + piece_count[COLOR_WHITE][PIECE_BISHOP];
    int black_minors = piece_count[COLOR_BLACK][PIECE_KNIGHT] + piece_count[COLOR_BLACK][PIECE_BISHOP];
    int white_non_pawn = material[COLOR_WHITE] - piece_count[COLOR_WHITE][PIECE_PAWN] * 100;
    int black_non_pawn = material[COLOR_BLACK] - piece_count[COLOR_BLACK][PIECE_PAWN] * 100;

    int is_endgame = 0;
    if (white_queens == 0 && black_queens == 0) is_endgame = 1;
    else if (white_queens > 0 && black_queens > 0 &&
             white_rooks == 0 && black_rooks == 0 &&
             white_minors <= 1 && black_minors <= 1) is_endgame = 1;
    if (white_non_pawn < 900 && black_non_pawn < 900) is_endgame = 1;
    if (white_non_pawn + black_non_pawn <= 1600) is_endgame = 1;
    if (is_endgame) return 2;

    if (b->fullmove_number <= 15) {
        int undeveloped = 0;
        if (b->squares[1] == make_piece(COLOR_WHITE, PIECE_KNIGHT)) undeveloped++;
        if (b->squares[6] == make_piece(COLOR_WHITE, PIECE_KNIGHT)) undeveloped++;
        if (b->squares[2] == make_piece(COLOR_WHITE, PIECE_BISHOP)) undeveloped++;
        if (b->squares[5] == make_piece(COLOR_WHITE, PIECE_BISHOP)) undeveloped++;
        if (b->squares[57] == make_piece(COLOR_BLACK, PIECE_KNIGHT)) undeveloped++;
        if (b->squares[62] == make_piece(COLOR_BLACK, PIECE_KNIGHT)) undeveloped++;
        if (b->squares[58] == make_piece(COLOR_BLACK, PIECE_BISHOP)) undeveloped++;
        if (b->squares[61] == make_piece(COLOR_BLACK, PIECE_BISHOP)) undeveloped++;
        if (b->fullmove_number <= 10 || undeveloped >= 2) return 0;
    }
    return 1;
}

static int evaluate_rooks_fast_c(const Board* b) {
    int score = 0;
    int white_pawns_on_file[8] = {0};
    int black_pawns_on_file[8] = {0};
    int white_rooks[16], black_rooks[16];
    int wrc = 0, brc = 0;

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p) continue;
        int c = piece_color(p);
        int t = piece_type(p);
        if (t == PIECE_PAWN) {
            if (c == COLOR_WHITE) white_pawns_on_file[file_of(sq)]++;
            else black_pawns_on_file[file_of(sq)]++;
        } else if (t == PIECE_ROOK) {
            if (c == COLOR_WHITE) white_rooks[wrc++] = sq;
            else black_rooks[brc++] = sq;
        }
    }

    for (int i = 0; i < wrc; ++i) {
        int sq = white_rooks[i];
        int r = rank_of(sq), f = file_of(sq);
        if (r == 6) score += ROOK_ON_SEVENTH_BONUS;
        if (white_pawns_on_file[f] == 0) score += (black_pawns_on_file[f] == 0) ? ROOK_OPEN_FILE_BONUS : ROOK_SEMI_OPEN_FILE_BONUS;
    }
    for (int i = 0; i < brc; ++i) {
        int sq = black_rooks[i];
        int r = rank_of(sq), f = file_of(sq);
        if (r == 1) score -= ROOK_ON_SEVENTH_BONUS;
        if (black_pawns_on_file[f] == 0) score -= (white_pawns_on_file[f] == 0) ? ROOK_OPEN_FILE_BONUS : ROOK_SEMI_OPEN_FILE_BONUS;
    }
    if (wrc == 2 && (rank_of(white_rooks[0]) == rank_of(white_rooks[1]) || file_of(white_rooks[0]) == file_of(white_rooks[1])) &&
        check_path_clear(b, white_rooks[0], white_rooks[1])) score += CONNECTED_ROOKS_BONUS;
    if (brc == 2 && (rank_of(black_rooks[0]) == rank_of(black_rooks[1]) || file_of(black_rooks[0]) == file_of(black_rooks[1])) &&
        check_path_clear(b, black_rooks[0], black_rooks[1])) score -= CONNECTED_ROOKS_BONUS;
    return score;
}

static int evaluate_pawn_structure_fast_c(const Board* b, int passed_pawns) {
    int score = 0;
    int white_pawns[16], black_pawns[16], wpc = 0, bpc = 0;
    int white_pawns_on_file[8] = {0}, black_pawns_on_file[8] = {0};
    int white_file_ranks[8][8], black_file_ranks[8][8];
    int white_file_count[8] = {0}, black_file_count[8] = {0};

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p || piece_type(p) != PIECE_PAWN) continue;
        int c = piece_color(p), f = file_of(sq), r = rank_of(sq);
        if (c == COLOR_WHITE) {
            white_pawns[wpc++] = sq;
            white_pawns_on_file[f]++;
            white_file_ranks[f][white_file_count[f]++] = r;
        } else {
            black_pawns[bpc++] = sq;
            black_pawns_on_file[f]++;
            black_file_ranks[f][black_file_count[f]++] = r;
        }
    }

    for (int f = 0; f < 8; ++f) {
        if (white_pawns_on_file[f] > 1) score -= DOUBLED_PAWN_PENALTY * (white_pawns_on_file[f] - 1);
        if (black_pawns_on_file[f] > 1) score += DOUBLED_PAWN_PENALTY * (black_pawns_on_file[f] - 1);
    }

    for (int i = 0; i < wpc; ++i) {
        int sq = white_pawns[i], f = file_of(sq), r = rank_of(sq);
        int isolated = 1;
        if (f > 0 && white_pawns_on_file[f - 1] > 0) isolated = 0;
        if (f < 7 && white_pawns_on_file[f + 1] > 0) isolated = 0;
        if (isolated) score -= ISOLATED_PAWN_PENALTY;

        int has_adj = ((f > 0 && white_pawns_on_file[f - 1] > 0) || (f < 7 && white_pawns_on_file[f + 1] > 0));
        if (!has_adj) continue;
        int behind_all = 1;
        for (int df = -1; df <= 1; df += 2) {
            int af = f + df;
            if (af < 0 || af > 7) continue;
            for (int k = 0; k < white_file_count[af]; ++k) {
                if (white_file_ranks[af][k] <= r) { behind_all = 0; break; }
            }
            if (!behind_all) break;
        }
        if (!behind_all) continue;
        int fr = r + 1;
        if (fr <= 7) {
            int attacked = 0;
            for (int df = -1; df <= 1; df += 2) {
                int af = f + df;
                if (af < 0 || af > 7) continue;
                for (int k = 0; k < black_file_count[af]; ++k) {
                    if (black_file_ranks[af][k] == fr + 1) { attacked = 1; break; }
                }
                if (attacked) break;
            }
            if (attacked) score -= BACKWARD_PAWN_PENALTY;
        }
    }

    for (int i = 0; i < bpc; ++i) {
        int sq = black_pawns[i], f = file_of(sq), r = rank_of(sq);
        int isolated = 1;
        if (f > 0 && black_pawns_on_file[f - 1] > 0) isolated = 0;
        if (f < 7 && black_pawns_on_file[f + 1] > 0) isolated = 0;
        if (isolated) score += ISOLATED_PAWN_PENALTY;

        int has_adj = ((f > 0 && black_pawns_on_file[f - 1] > 0) || (f < 7 && black_pawns_on_file[f + 1] > 0));
        if (!has_adj) continue;
        int behind_all = 1;
        for (int df = -1; df <= 1; df += 2) {
            int af = f + df;
            if (af < 0 || af > 7) continue;
            for (int k = 0; k < black_file_count[af]; ++k) {
                if (black_file_ranks[af][k] >= r) { behind_all = 0; break; }
            }
            if (!behind_all) break;
        }
        if (!behind_all) continue;
        int fr = r - 1;
        if (fr >= 0) {
            int attacked = 0;
            for (int df = -1; df <= 1; df += 2) {
                int af = f + df;
                if (af < 0 || af > 7) continue;
                for (int k = 0; k < white_file_count[af]; ++k) {
                    if (white_file_ranks[af][k] == fr - 1) { attacked = 1; break; }
                }
                if (attacked) break;
            }
            if (attacked) score += BACKWARD_PAWN_PENALTY;
        }
    }

    if (passed_pawns) {
        for (int i = 0; i < wpc; ++i) {
            int sq = white_pawns[i], r = rank_of(sq), f = file_of(sq), is_passed = 1;
            for (int rr = r + 1; rr < 8 && is_passed; ++rr) {
                for (int df = -1; df <= 1; ++df) {
                    int ff = f + df;
                    if (ff >= 0 && ff <= 7 && b->squares[square_of(rr, ff)] == make_piece(COLOR_BLACK, PIECE_PAWN)) { is_passed = 0; break; }
                }
            }
            if (is_passed) score += PASSED_PAWN_BONUS[r];
        }
        for (int i = 0; i < bpc; ++i) {
            int sq = black_pawns[i], r = rank_of(sq), f = file_of(sq), is_passed = 1;
            for (int rr = r - 1; rr >= 0 && is_passed; --rr) {
                for (int df = -1; df <= 1; ++df) {
                    int ff = f + df;
                    if (ff >= 0 && ff <= 7 && b->squares[square_of(rr, ff)] == make_piece(COLOR_WHITE, PIECE_PAWN)) { is_passed = 0; break; }
                }
            }
            if (is_passed) score -= PASSED_PAWN_BONUS[7 - r];
        }
    }
    return score;
}

static int evaluate_endgame_pawns_fast_c(const Board* b) {
    int score = 0;
    int white_pawns[16], black_pawns[16], white_rooks[16], black_rooks[16];
    int wpc = 0, bpc = 0, wrc = 0, brc = 0;
    int white_passed[16], black_passed[16], wpp = 0, bpp = 0;
    int wking = b->king_sq[COLOR_WHITE], bking = b->king_sq[COLOR_BLACK];

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p) continue;
        int c = piece_color(p), t = piece_type(p);
        if (t == PIECE_PAWN) {
            if (c == COLOR_WHITE) white_pawns[wpc++] = sq;
            else black_pawns[bpc++] = sq;
        } else if (t == PIECE_ROOK) {
            if (c == COLOR_WHITE) white_rooks[wrc++] = sq;
            else black_rooks[brc++] = sq;
        }
    }

    for (int i = 0; i < wpc; ++i) {
        int sq = white_pawns[i], r = rank_of(sq), f = file_of(sq), is_passed = 1;
        score += ENDGAME_ADVANCED_PAWN_BONUS[r];
        for (int rr = r + 1; rr < 8 && is_passed; ++rr) {
            for (int df = -1; df <= 1; ++df) {
                int ff = f + df;
                if (ff >= 0 && ff <= 7 && b->squares[square_of(rr, ff)] == make_piece(COLOR_BLACK, PIECE_PAWN)) { is_passed = 0; break; }
            }
        }
        if (is_passed) {
            white_passed[wpp++] = sq;
            score += ENDGAME_PASSED_PAWN_BONUS[r];
            int wdist = abs(rank_of(wking) - r) + abs(file_of(wking) - f);
            int bdist = abs(rank_of(bking) - r) + abs(file_of(bking) - f);
            score += ((7 - wdist) > 0 ? (7 - wdist) : 0) * ENDGAME_KING_PAWN_PROXIMITY_BONUS;
            score -= ((7 - bdist) > 0 ? (7 - bdist) : 0) * ENDGAME_KING_PAWN_PROXIMITY_BONUS;
        }
    }

    for (int i = 0; i < bpc; ++i) {
        int sq = black_pawns[i], r = rank_of(sq), f = file_of(sq), is_passed = 1;
        score -= ENDGAME_ADVANCED_PAWN_BONUS[7 - r];
        for (int rr = r - 1; rr >= 0 && is_passed; --rr) {
            for (int df = -1; df <= 1; ++df) {
                int ff = f + df;
                if (ff >= 0 && ff <= 7 && b->squares[square_of(rr, ff)] == make_piece(COLOR_WHITE, PIECE_PAWN)) { is_passed = 0; break; }
            }
        }
        if (is_passed) {
            black_passed[bpp++] = sq;
            score -= ENDGAME_PASSED_PAWN_BONUS[7 - r];
            int bdist = abs(rank_of(bking) - r) + abs(file_of(bking) - f);
            int wdist = abs(rank_of(wking) - r) + abs(file_of(wking) - f);
            score -= ((7 - bdist) > 0 ? (7 - bdist) : 0) * ENDGAME_KING_PAWN_PROXIMITY_BONUS;
            score += ((7 - wdist) > 0 ? (7 - wdist) : 0) * ENDGAME_KING_PAWN_PROXIMITY_BONUS;
        }
    }

    for (int i = 0; i < wrc; ++i) {
        int rr = rank_of(white_rooks[i]), rf = file_of(white_rooks[i]);
        for (int j = 0; j < wpp; ++j) {
            if (file_of(white_passed[j]) == rf && rank_of(white_passed[j]) > rr) score += ROOK_BEHIND_PASSED_PAWN_BONUS;
        }
    }
    for (int i = 0; i < brc; ++i) {
        int rr = rank_of(black_rooks[i]), rf = file_of(black_rooks[i]);
        for (int j = 0; j < bpp; ++j) {
            if (file_of(black_passed[j]) == rf && rank_of(black_passed[j]) < rr) score -= ROOK_BEHIND_PASSED_PAWN_BONUS;
        }
    }
    return score;
}

static int center_distance(int sq) {
    int f = file_of(sq), r = rank_of(sq);
    int fd = abs(f - 3) < abs(f - 4) ? abs(f - 3) : abs(f - 4);
    int rd = abs(r - 3) < abs(r - 4) ? abs(r - 3) : abs(r - 4);
    return fd + rd;
}

static int evaluate_endgame_king_activity_fast_c(const Board* b) {
    int wd = center_distance(b->king_sq[COLOR_WHITE]);
    int bd = center_distance(b->king_sq[COLOR_BLACK]);
    int score = (6 - wd) * ENDGAME_KING_CENTRALIZATION_BONUS;
    score -= (6 - bd) * ENDGAME_KING_CENTRALIZATION_BONUS;
    return score;
}

static int evaluate_king_safety_fast_c(const Board* b) {
    int score = 0;
    int wking = b->king_sq[COLOR_WHITE], bking = b->king_sq[COLOR_BLACK];
    int wf = file_of(wking), wr = rank_of(wking);
    int bf = file_of(bking), br = rank_of(bking);
    int wp = make_piece(COLOR_WHITE, PIECE_PAWN), bp = make_piece(COLOR_BLACK, PIECE_PAWN);

    if (wr <= 1) {
        for (int df = -1; df <= 1; ++df) {
            int f = wf + df;
            if (f < 0 || f > 7) continue;
            for (int dr = 1; dr <= 2; ++dr) {
                int r = wr + dr;
                if (r < 8 && b->squares[square_of(r, f)] == wp) { score += KING_PAWN_SHIELD_BONUS; break; }
            }
        }
    }
    if (br >= 6) {
        for (int df = -1; df <= 1; ++df) {
            int f = bf + df;
            if (f < 0 || f > 7) continue;
            for (int dr = -1; dr >= -2; --dr) {
                int r = br + dr;
                if (r >= 0 && b->squares[square_of(r, f)] == bp) { score -= KING_PAWN_SHIELD_BONUS; break; }
            }
        }
    }
    return score;
}

static int attack_v1_manhattan(int sq1, int sq2) {
    return abs(rank_of(sq1) - rank_of(sq2)) + abs(file_of(sq1) - file_of(sq2));
}

static int attack_v1_piece_attacks_square(const Board* b, int from, int target, int piece) {
    int t = piece_type(piece);
    int c = piece_color(piece);
    int fr = rank_of(from), ff = file_of(from);
    int tr = rank_of(target), tf = file_of(target);
    int dr = tr - fr, df = tf - ff;

    if (t == PIECE_PAWN) {
        if (c == COLOR_WHITE) return dr == 1 && (df == -1 || df == 1);
        return dr == -1 && (df == -1 || df == 1);
    }
    if (t == PIECE_KNIGHT) {
        int adr = abs(dr), adf = abs(df);
        return (adr == 2 && adf == 1) || (adr == 1 && adf == 2);
    }
    if (t == PIECE_KING) {
        return abs(dr) <= 1 && abs(df) <= 1 && (dr != 0 || df != 0);
    }

    if (t == PIECE_BISHOP || t == PIECE_ROOK || t == PIECE_QUEEN) {
        int step_r = 0, step_f = 0;
        if (dr == 0 && df != 0) {
            if (t == PIECE_BISHOP) return 0;
            step_f = (df > 0) ? 1 : -1;
        } else if (df == 0 && dr != 0) {
            if (t == PIECE_BISHOP) return 0;
            step_r = (dr > 0) ? 1 : -1;
        } else if (abs(dr) == abs(df)) {
            if (t == PIECE_ROOK) return 0;
            step_r = (dr > 0) ? 1 : -1;
            step_f = (df > 0) ? 1 : -1;
        } else {
            return 0;
        }

        int r = fr + step_r;
        int f = ff + step_f;
        while (r != tr || f != tf) {
            if (b->squares[square_of(r, f)] != PIECE_EMPTY) return 0;
            r += step_r;
            f += step_f;
        }
        return 1;
    }
    return 0;
}

static void attack_v1_build_king_zone(int king_sq, int victim_color, int zone[64]) {
    memset(zone, 0, 64 * sizeof(int));
    int kr = rank_of(king_sq), kf = file_of(king_sq);

    for (int dr = -1; dr <= 1; ++dr) {
        for (int df = -1; df <= 1; ++df) {
            int r = kr + dr, f = kf + df;
            if (r >= 0 && r < 8 && f >= 0 && f < 8) zone[square_of(r, f)] = 1;
        }
    }

    int forward = (victim_color == COLOR_WHITE) ? 1 : -1;
    for (int step = 1; step <= 2; ++step) {
        int r = kr + forward * step;
        if (r < 0 || r >= 8) continue;
        for (int df = -1; df <= 1; ++df) {
            int f = kf + df;
            if (f >= 0 && f < 8) zone[square_of(r, f)] = 1;
        }
    }
}

static int evaluate_attack_side_v1(const Board* b, int attacker_color) {
    int victim_color = attacker_color ^ 1;
    int victim_king_sq = b->king_sq[victim_color];
    int victim_king_file = file_of(victim_king_sq);
    int victim_king_rank = rank_of(victim_king_sq);

    int zone[64];
    attack_v1_build_king_zone(victim_king_sq, victim_color, zone);

    int attackers = 0;
    int attack_units = 0;
    int tropism = 0;
    int file_pressure = 0;
    int pawn_storm = 0;

    int attacker_pawns_on_file[8] = {0};
    int victim_pawns_on_file[8] = {0};

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p || piece_type(p) != PIECE_PAWN) continue;
        int c = piece_color(p);
        int f = file_of(sq);
        if (c == attacker_color) attacker_pawns_on_file[f]++;
        else victim_pawns_on_file[f]++;
    }

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p || piece_color(p) != attacker_color) continue;
        int t = piece_type(p);

        int zone_hits = 0;
        for (int target = 0; target < 64; ++target) {
            if (!zone[target]) continue;
            if (attack_v1_piece_attacks_square(b, sq, target, p)) zone_hits++;
        }

        if (zone_hits > 0) {
            attackers++;
            if (t == PIECE_KNIGHT || t == PIECE_BISHOP) {
                attack_units += ATTACK_V1_UNIT_MINOR + zone_hits * ATTACK_V1_ZONE_HIT_MINOR;
            } else if (t == PIECE_ROOK) {
                attack_units += ATTACK_V1_UNIT_ROOK + zone_hits * ATTACK_V1_ZONE_HIT_ROOK;
            } else if (t == PIECE_QUEEN) {
                attack_units += ATTACK_V1_UNIT_QUEEN + zone_hits * ATTACK_V1_ZONE_HIT_QUEEN;
            }
        }

        if (t == PIECE_KNIGHT || t == PIECE_BISHOP || t == PIECE_ROOK || t == PIECE_QUEEN) {
            int dist = attack_v1_manhattan(sq, victim_king_sq);
            int closeness = 14 - dist;
            if (closeness < 0) closeness = 0;
            if (t == PIECE_QUEEN) tropism += closeness * 5;
            else if (t == PIECE_ROOK) tropism += closeness * 3;
            else tropism += closeness * 2;
        }

        if (t == PIECE_ROOK || t == PIECE_QUEEN) {
            int f = file_of(sq);
            if (abs(f - victim_king_file) <= 1) {
                if (attacker_pawns_on_file[f] == 0 && victim_pawns_on_file[f] == 0) {
                    file_pressure += ATTACK_V1_FILE_OPEN_BONUS;
                } else if (attacker_pawns_on_file[f] == 0) {
                    file_pressure += ATTACK_V1_FILE_SEMIOPEN_BONUS;
                }
            }
        }

        if (t == PIECE_PAWN && abs(file_of(sq) - victim_king_file) <= 1) {
            int dist = abs(rank_of(sq) - victim_king_rank);
            int closeness = 4 - dist;
            if (closeness > 0) pawn_storm += closeness * ATTACK_V1_PAWN_STORM_STEP;
        }
    }

    int idx = attackers;
    if (idx > 7) idx = 7;
    int scaled_attack = attack_units * ATTACK_V1_ATTACKER_SCALE[idx] / 100;
    if (attackers < 2) scaled_attack /= 2;

    return scaled_attack + file_pressure + pawn_storm + tropism / ATTACK_V1_TROPISM_DIV;
}

static int evaluate_attack_module_v1(const Board* b) {
    int white_attack = evaluate_attack_side_v1(b, COLOR_WHITE);
    int black_attack = evaluate_attack_side_v1(b, COLOR_BLACK);
    return white_attack - black_attack;
}

static int evaluate_mobility_fast_c(const Board* b) {
    int score = 0;
    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p) continue;
        int c = piece_color(p), t = piece_type(p);
        int sign = (c == COLOR_WHITE) ? 1 : -1;
        int fd = file_of(sq); if (7 - file_of(sq) < fd) fd = 7 - file_of(sq);
        int rd = rank_of(sq); if (7 - rank_of(sq) < rd) rd = 7 - rank_of(sq);
        int cen = fd + rd;
        if (t == PIECE_KNIGHT) score += sign * cen * 2;
        else if (t == PIECE_BISHOP) score += sign * cen;
    }
    return score;
}

static int evaluate_opening_fast_c(const Board* b) {
    static const int CENTER_SQUARES[4] = {27, 28, 35, 36};
    static const int EXT_CENTER[12] = {18, 19, 20, 21, 26, 29, 34, 37, 42, 43, 44, 45};
    int score = 0;
    int wp = make_piece(COLOR_WHITE, PIECE_PAWN), bp = make_piece(COLOR_BLACK, PIECE_PAWN);
    int wn = make_piece(COLOR_WHITE, PIECE_KNIGHT), wb = make_piece(COLOR_WHITE, PIECE_BISHOP), wq = make_piece(COLOR_WHITE, PIECE_QUEEN);
    int bn = make_piece(COLOR_BLACK, PIECE_KNIGHT), bb = make_piece(COLOR_BLACK, PIECE_BISHOP), bq = make_piece(COLOR_BLACK, PIECE_QUEEN);
    int white_knights = 0, white_bishops = 0, black_knights = 0, black_bishops = 0;
    int white_developed = 0, black_developed = 0;
    int white_queen_present = 0, black_queen_present = 0;
    int white_queen_start = 0, black_queen_start = 0;

    for (int i = 0; i < 4; ++i) {
        int p = b->squares[CENTER_SQUARES[i]];
        if (p == wp) score += CENTER_PAWN_BONUS;
        else if (p == bp) score -= CENTER_PAWN_BONUS;
    }
    for (int i = 0; i < 12; ++i) {
        int p = b->squares[EXT_CENTER[i]];
        if (p == wp) score += EXTENDED_CENTER_PAWN_BONUS;
        else if (p == bp) score -= EXTENDED_CENTER_PAWN_BONUS;
    }

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (p == wn) { white_knights++; if (sq != 1 && sq != 6) white_developed++; }
        else if (p == wb) { white_bishops++; if (sq != 2 && sq != 5) white_developed++; }
        else if (p == bn) { black_knights++; if (sq != 57 && sq != 62) black_developed++; }
        else if (p == bb) { black_bishops++; if (sq != 58 && sq != 61) black_developed++; }
        else if (p == wq) { white_queen_present = 1; if (sq == 3) white_queen_start = 1; }
        else if (p == bq) { black_queen_present = 1; if (sq == 59) black_queen_start = 1; }
    }

    score += white_developed * DEVELOPMENT_BONUS;
    score -= black_developed * DEVELOPMENT_BONUS;

    int white_undeveloped = (white_knights + white_bishops) - white_developed;
    int black_undeveloped = (black_knights + black_bishops) - black_developed;
    score -= white_undeveloped * UNDEVELOPED_PENALTY;
    score += black_undeveloped * UNDEVELOPED_PENALTY;

    int wking = b->king_sq[COLOR_WHITE], bking = b->king_sq[COLOR_BLACK];
    if (wking == 6 || wking == 2) score += CASTLED_BONUS;
    else if (b->castling_rights & (CASTLE_WHITE_K | CASTLE_WHITE_Q)) score += CASTLING_RIGHTS_BONUS;
    if (bking == 62 || bking == 58) score -= CASTLED_BONUS;
    else if (b->castling_rights & (CASTLE_BLACK_K | CASTLE_BLACK_Q)) score -= CASTLING_RIGHTS_BONUS;

    if (b->fullmove_number < 8) {
        if (white_queen_present && !white_queen_start && white_developed < 3) score -= EARLY_QUEEN_PENALTY;
        if (black_queen_present && !black_queen_start && black_developed < 3) score += EARLY_QUEEN_PENALTY;
    }
    return score;
}

static int evaluate_trapped_pieces_c(const Board* b) {
    int score = 0;
    int wb = make_piece(COLOR_WHITE, PIECE_BISHOP), bb = make_piece(COLOR_BLACK, PIECE_BISHOP);
    int wr = make_piece(COLOR_WHITE, PIECE_ROOK), br = make_piece(COLOR_BLACK, PIECE_ROOK);
    if (b->squares[2] == wb) { score -= BISHOP_UNDEVELOPED_PENALTY; if (b->squares[0] == wr) score -= ROOK_TRAPPED_BEHIND_BISHOP_PENALTY; }
    if (b->squares[5] == wb) { score -= BISHOP_UNDEVELOPED_PENALTY; if (b->squares[7] == wr) score -= ROOK_TRAPPED_BEHIND_BISHOP_PENALTY; }
    if (b->squares[58] == bb) { score += BISHOP_UNDEVELOPED_PENALTY; if (b->squares[56] == br) score += ROOK_TRAPPED_BEHIND_BISHOP_PENALTY; }
    if (b->squares[61] == bb) { score += BISHOP_UNDEVELOPED_PENALTY; if (b->squares[63] == br) score += ROOK_TRAPPED_BEHIND_BISHOP_PENALTY; }
    return score;
}

static int evaluate_knight_quality_c(const Board* b) {
    int score = 0;
    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p || piece_type(p) != PIECE_KNIGHT) continue;
        int c = piece_color(p), f = file_of(sq);
        if (c == COLOR_WHITE) {
            if (f == 0 || f == 7) score -= KNIGHT_RIM_PENALTY;
            if (sq == 18 || sq == 21) score += KNIGHT_GOOD_OUTPOST_BONUS;
        } else {
            if (f == 0 || f == 7) score += KNIGHT_RIM_PENALTY;
            if (sq == 42 || sq == 45) score -= KNIGHT_GOOD_OUTPOST_BONUS;
        }
    }
    return score;
}

static int evaluate(const Board* b) {
    int game_phase = get_game_phase(b);
    int is_endgame = (game_phase == 2);
    int is_opening = (game_phase == 0);
    int score = 0;
    int white_material = 0, black_material = 0;
    int white_bishops = 0, black_bishops = 0;

    for (int sq = 0; sq < 64; ++sq) {
        int p = b->squares[sq];
        if (!p) continue;
        int c = piece_color(p), t = piece_type(p);
        if (t != PIECE_KING) {
            if (c == COLOR_WHITE) white_material += PIECE_VALUES[t];
            else black_material += PIECE_VALUES[t];
        }
        if (t == PIECE_BISHOP) {
            if (c == COLOR_WHITE) white_bishops++;
            else black_bishops++;
        }
        int pst = get_pst_value(t, sq, c, is_endgame);
        score += (c == COLOR_WHITE) ? pst : -pst;
    }

    score += white_material - black_material;
    if (white_bishops >= 2) score += BISHOP_PAIR_BONUS;
    if (black_bishops >= 2) score -= BISHOP_PAIR_BONUS;
    score += evaluate_rooks_fast_c(b);

    if (is_endgame) {
        score += evaluate_endgame_pawns_fast_c(b);
        score += evaluate_endgame_king_activity_fast_c(b);
        score += evaluate_pawn_structure_fast_c(b, 0);
    } else if (is_opening) {
        score += evaluate_pawn_structure_fast_c(b, 1);
        score += evaluate_opening_fast_c(b);
        score += evaluate_trapped_pieces_c(b);
        score += evaluate_knight_quality_c(b);
    } else {
        score += evaluate_pawn_structure_fast_c(b, 1);
        score += evaluate_king_safety_fast_c(b);
        if (ENABLE_ATTACK_MODULE_V1) score += evaluate_attack_module_v1(b);
        score += evaluate_mobility_fast_c(b);
        score += evaluate_trapped_pieces_c(b);
        score += evaluate_knight_quality_c(b);
    }

    return (b->side_to_move == COLOR_WHITE) ? score : -score;
}

static int move_is_capture(const Board* b, const Move* m) {
    if (m->flags & MOVE_FLAG_EP) return 1;
    return b->squares[m->to] != PIECE_EMPTY;
}

static int move_equals(const Move* a, const Move* b) {
    return a->from == b->from && a->to == b->to && a->promo == b->promo && a->flags == b->flags;
}

static int score_move(const Board* b, SearchContext* ctx, const Move* m, int ply, int captures_only, const Move* tt_move) {
    int score = 0;
    if (tt_move && move_equals(m, tt_move)) return 10000000;
    if (m->promo) score += 800000 + PIECE_VALUES[m->promo];
    if (move_is_capture(b, m)) {
        int victim = (m->flags & MOVE_FLAG_EP)
            ? make_piece((b->side_to_move ^ 1), PIECE_PAWN)
            : b->squares[m->to];
        int attacker = b->squares[m->from];
        score += 500000 + PIECE_VALUES[piece_type(victim)] * 16 - PIECE_VALUES[piece_type(attacker)];
    } else if (!captures_only) {
        if (ply <= MAX_DEPTH) {
            if (move_equals(m, &ctx->killers[ply][0])) score += 300000;
            else if (move_equals(m, &ctx->killers[ply][1])) score += 250000;
        }
        score += ctx->history[b->side_to_move][m->from][m->to];
    }
    return score;
}

static void order_moves(const Board* b, SearchContext* ctx, Move* moves, int n, int ply, int captures_only, const Move* tt_move) {
    for (int i = 0; i < n; ++i) moves[i].score = score_move(b, ctx, &moves[i], ply, captures_only, tt_move);
    for (int i = 1; i < n; ++i) {
        Move key = moves[i];
        int j = i - 1;
        while (j >= 0 && moves[j].score < key.score) {
            moves[j + 1] = moves[j];
            --j;
        }
        moves[j + 1] = key;
    }
}

static int should_stop(SearchContext* ctx) {
    if (ctx->stop) return 1;
    if (ctx->stop_ms <= 0) return 0;
    if ((ctx->nodes & 2047) == 0) {
        if (now_ms() >= ctx->stop_ms) {
            ctx->stop = 1;
            return 1;
        }
    }
    return 0;
}

static int quiescence(Board* b, SearchContext* ctx, int alpha, int beta, int ply) {
    ctx->nodes++;
    if (should_stop(ctx)) return 0;
    if (ply > ctx->max_seldepth) ctx->max_seldepth = ply;

    int stand_pat = evaluate(b);
    if (stand_pat >= beta) return beta;
    if (stand_pat > alpha) alpha = stand_pat;

    Move moves[MAX_MOVES];
    int n = generate_legal_moves(b, moves, 1);
    order_moves(b, ctx, moves, n, 0, 1, NULL);

    for (int i = 0; i < n; ++i) {
        if (!board_make_move(b, &moves[i])) continue;
        int score = -quiescence(b, ctx, -beta, -alpha, ply + 1);
        board_unmake_move(b);
        if (ctx->stop) return 0;
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }
    return alpha;
}

static int negamax(Board* b, SearchContext* ctx, int depth, int alpha, int beta, int ply) {
    ctx->nodes++;
    if (should_stop(ctx)) return 0;
    ctx->pv_len[ply] = 0;
    if (ply > ctx->max_seldepth) ctx->max_seldepth = ply;

    if (b->halfmove_clock >= 100) return 0;
    if (depth <= 0) return quiescence(b, ctx, alpha, beta, ply);

    int in_check = is_in_check(b, b->side_to_move);

    // Null move pruning
    if (!in_check && depth >= 3 && ply > 0 && beta < MATE_SCORE - 100 && beta > -MATE_SCORE + 100) {
        int non_pawn = 0;
        for (int sq = 0; sq < 64; ++sq) {
            int p = b->squares[sq];
            if (!p) continue;
            int t = piece_type(p);
            if (t != PIECE_PAWN && t != PIECE_KING) non_pawn++;
        }
        if (non_pawn >= 4) {
            int old_ep = b->ep_sq;
            b->ep_sq = -1;
            b->side_to_move ^= 1;

            int R = 2 + depth / 4;
            int score = -negamax(b, ctx, depth - 1 - R, -beta, -beta + 1, ply + 1);

            b->side_to_move ^= 1;
            b->ep_sq = old_ep;

            if (ctx->stop) return 0;
            if (score >= beta) return beta;
        }
    }

    Move moves[MAX_MOVES];
    int n = generate_legal_moves(b, moves, 0);
    if (n == 0) {
        if (is_in_check(b, b->side_to_move)) return -MATE_SCORE + ply;
        return 0;
    }

    Move tt_move = {0};
    Move* tt_move_ptr = NULL;
    int alpha_orig = alpha;
    uint64_t key = board_hash(b);
    TTEntry* tte = tt_probe(&g_tt, key);
    if (tte) {
        tt_move = tte->best_move;
        tt_move_ptr = &tt_move;
        if (tte->depth >= depth) {
            if (tte->flag == TT_FLAG_EXACT) {
                if (tt_move_ptr && (tt_move_ptr->from || tt_move_ptr->to || tt_move_ptr->promo)) {
                    ctx->pv_table[ply][0] = *tt_move_ptr;
                    ctx->pv_len[ply] = 1;
                }
                return tte->score;
            } else if (tte->flag == TT_FLAG_LOWER) {
                if (tte->score > alpha) alpha = tte->score;
            } else if (tte->flag == TT_FLAG_UPPER) {
                if (tte->score < beta) beta = tte->score;
            }
            if (alpha >= beta) return tte->score;
        }
    }

    order_moves(b, ctx, moves, n, ply, 0, tt_move_ptr);
    int best = -INF;

    Move best_move = moves[0];
    int tt_flag = TT_FLAG_UPPER;

    for (int i = 0; i < n; ++i) {
        int is_capture = move_is_capture(b, &moves[i]);
        if (!board_make_move(b, &moves[i])) continue;

        int score;
        if (i == 0) {
            // Principal variation full-window search
            score = -negamax(b, ctx, depth - 1, -beta, -alpha, ply + 1);
        } else {
            // Late move reduction for quiet, non-checking late moves
            int gives_check = is_in_check(b, b->side_to_move);
            if (i >= 4 && depth >= 3 && !in_check && !gives_check &&
                !is_capture && !(moves[i].flags & MOVE_FLAG_CASTLE) && moves[i].promo == 0) {
                int reduction = 1 + i / 8;
                score = -negamax(b, ctx, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1);
                if (score > alpha && !ctx->stop) {
                    score = -negamax(b, ctx, depth - 1, -beta, -alpha, ply + 1);
                }
            } else {
                // PVS null-window search
                score = -negamax(b, ctx, depth - 1, -alpha - 1, -alpha, ply + 1);
                if (score > alpha && score < beta && !ctx->stop) {
                    score = -negamax(b, ctx, depth - 1, -beta, -alpha, ply + 1);
                }
            }
        }
        board_unmake_move(b);
        if (ctx->stop) return 0;

        if (score > best) {
            best = score;
            best_move = moves[i];
        }
        if (score > alpha) {
            alpha = score;
            tt_flag = TT_FLAG_EXACT;
            ctx->pv_table[ply][0] = moves[i];
            int child_len = ctx->pv_len[ply + 1];
            for (int j = 0; j < child_len; ++j) {
                ctx->pv_table[ply][j + 1] = ctx->pv_table[ply + 1][j];
            }
            ctx->pv_len[ply] = child_len + 1;
        }
        if (alpha >= beta) {
            tt_flag = TT_FLAG_LOWER;
            // Update killer/history for quiet beta-cutoff moves
            if (!is_capture && ply <= MAX_DEPTH) {
                if (!move_equals(&moves[i], &ctx->killers[ply][0])) {
                    ctx->killers[ply][1] = ctx->killers[ply][0];
                    ctx->killers[ply][0] = moves[i];
                }
                int c = b->side_to_move;
                int from = moves[i].from, to = moves[i].to;
                ctx->history[c][from][to] += depth * depth;
                if (ctx->history[c][from][to] > 1000000) {
                    for (int f = 0; f < 64; ++f) {
                        for (int t = 0; t < 64; ++t) {
                            ctx->history[c][f][t] /= 2;
                        }
                    }
                }
            }
            break;
        }
    }
    if (best <= alpha_orig) tt_flag = TT_FLAG_UPPER;
    tt_store(&g_tt, key, depth, best, tt_flag, &best_move);
    return best;
}

static Move search_best_move(Board* b, int max_depth, long long time_limit_ms, int fixed_depth_mode, SearchInfo* out_info) {
    SearchContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.max_depth = max_depth;
    ctx.max_seldepth = 0;
    ctx.start_ms = now_ms();
    ctx.stop_ms = (time_limit_ms > 0) ? (ctx.start_ms + time_limit_ms) : 0;
    tt_new_search(&g_tt);

    SearchInfo info;
    memset(&info, 0, sizeof(info));
    Move best = {0};

    for (int depth = 1; depth <= max_depth; ++depth) {
        Move moves[MAX_MOVES];
        int n = generate_legal_moves(b, moves, 0);
        if (n == 0) break;
        order_moves(b, &ctx, moves, n, 0, 0, NULL);

        int alpha = -INF;
        int beta = INF;
        int best_score = -INF;
        Move best_this = moves[0];
        Move root_pv[MAX_DEPTH + 1];
        int root_pv_len = 0;

        for (int i = 0; i < n; ++i) {
            if (!board_make_move(b, &moves[i])) continue;
            int score = -negamax(b, &ctx, depth - 1, -beta, -alpha, 1);
            board_unmake_move(b);
            if (ctx.stop) break;

            if (score > best_score) {
                best_score = score;
                best_this = moves[i];
                root_pv[0] = moves[i];
                int child_len = ctx.pv_len[1];
                for (int j = 0; j < child_len && (j + 1) < (MAX_DEPTH + 1); ++j) {
                    root_pv[j + 1] = ctx.pv_table[1][j];
                }
                root_pv_len = child_len + 1;
            }
            if (score > alpha) alpha = score;
        }

        if (ctx.stop && depth > 1) break;
        best = best_this;
        info.depth = depth;
        info.seldepth = ctx.max_seldepth;
        info.score = best_score;
        info.nodes = ctx.nodes;
        info.has_best = 1;
        info.best_move = best;
        info.time_ms = now_ms() - ctx.start_ms;

        long long t = info.time_ms > 0 ? info.time_ms : 1;
        long long nps = (long long)info.nodes * 1000LL / t;
        int hashfull = tt_hashfull_permille(&g_tt);
        printf("info depth %d seldepth %d nodes %d time %lld nps %lld score cp %d hashfull %d",
               info.depth, info.seldepth, info.nodes, info.time_ms, nps, info.score, hashfull);
        if (root_pv_len > 0) {
            printf(" pv");
            for (int p = 0; p < root_pv_len; ++p) {
                char pv_move[8];
                move_to_uci(&root_pv[p], pv_move);
                printf(" %s", pv_move);
            }
        }
        printf("\n");
        fflush(stdout);

        if (!fixed_depth_mode && time_limit_ms > 0 && info.time_ms > time_limit_ms / 2) break;
        if (abs(best_score) > MATE_SCORE - 1000) break;
    }

    if (!info.has_best) {
        Move fallback[MAX_MOVES];
        int n = generate_legal_moves(b, fallback, 0);
        if (n > 0) best = fallback[0];
    }

    if (out_info) *out_info = info;
    return best;
}

static int parse_uci_move(Board* b, const char* s, Move* out) {
    if (!s || strlen(s) < 4) return 0;
    int from = parse_square_str(s);
    int to = parse_square_str(s + 2);
    if (from < 0 || to < 0) return 0;

    Move m;
    memset(&m, 0, sizeof(m));
    m.from = from;
    m.to = to;

    int moving = b->squares[from];
    if (!moving) return 0;
    int ptype = piece_type(moving);
    if (ptype == PIECE_PAWN && file_of(from) != file_of(to) && b->squares[to] == PIECE_EMPTY) {
        m.flags |= MOVE_FLAG_EP;
    }
    if (ptype == PIECE_KING && abs(file_of(from) - file_of(to)) == 2) {
        m.flags |= MOVE_FLAG_CASTLE;
    }
    if (strlen(s) > 4) {
        char c = (char)tolower((unsigned char)s[4]);
        if (c == 'q') m.promo = PIECE_QUEEN;
        else if (c == 'r') m.promo = PIECE_ROOK;
        else if (c == 'b') m.promo = PIECE_BISHOP;
        else if (c == 'n') m.promo = PIECE_KNIGHT;
    }
    *out = m;
    return 1;
}

static int token_split(char* line, char* tokens[], int max_tokens) {
    int n = 0;
    char* saveptr = NULL;
    char* tok = strtok_r(line, " \t\r\n", &saveptr);
    while (tok && n < max_tokens) {
        tokens[n++] = tok;
        tok = strtok_r(NULL, " \t\r\n", &saveptr);
    }
    return n;
}

static long long compute_time_for_move(const Board* b, int wtime, int btime, int winc, int binc, int movetime, int movestogo) {
    if (movetime >= 0) return movetime;
    int our_time = (b->side_to_move == COLOR_WHITE) ? wtime : btime;
    int our_inc = (b->side_to_move == COLOR_WHITE) ? winc : binc;
    if (our_time < 0) return 0;
    int mtg = (movestogo > 0) ? movestogo : 30;
    long long t = our_time / mtg + our_inc / 2;
    if (t > our_time / 4) t = our_time / 4;
    t -= 30;
    if (t < 10) t = 10;
    return t;
}

int main(void) {
    init_zobrist();
    tt_init_mb(&g_tt, DEFAULT_TT_MB);

    Board board;
    board_set_startpos(&board);

    char line[MAX_LINE];
    while (fgets(line, sizeof(line), stdin)) {
        char line_copy[MAX_LINE];
        strncpy(line_copy, line, sizeof(line_copy) - 1);
        line_copy[sizeof(line_copy) - 1] = '\0';

        char* tokens[256];
        int n = token_split(line_copy, tokens, 256);
        if (n == 0) continue;

        if (strcmp(tokens[0], "uci") == 0) {
            printf("id name %s\n", ENGINE_NAME);
            printf("id author %s\n", ENGINE_AUTHOR);
            printf("option name Hash type spin default 64 min 1 max 1024\n");
            printf("uciok\n");
            fflush(stdout);
        } else if (strcmp(tokens[0], "isready") == 0) {
            printf("readyok\n");
            fflush(stdout);
        } else if (strcmp(tokens[0], "ucinewgame") == 0) {
            board_set_startpos(&board);
            tt_clear(&g_tt);
        } else if (strcmp(tokens[0], "setoption") == 0) {
            // setoption name Hash value <mb>
            int name_idx = -1, value_idx = -1;
            for (int i = 1; i < n; ++i) {
                if (strcmp(tokens[i], "name") == 0) name_idx = i;
                else if (strcmp(tokens[i], "value") == 0) value_idx = i;
            }
            if (name_idx >= 0) {
                int start = name_idx + 1;
                int end = (value_idx >= 0) ? value_idx : n;
                char name[128] = {0};
                for (int i = start; i < end; ++i) {
                    if (i > start) strncat(name, " ", sizeof(name) - strlen(name) - 1);
                    strncat(name, tokens[i], sizeof(name) - strlen(name) - 1);
                }
                for (size_t k = 0; k < strlen(name); ++k) name[k] = (char)tolower((unsigned char)name[k]);
                if (strcmp(name, "hash") == 0 && value_idx >= 0 && value_idx + 1 < n) {
                    int mb = atoi(tokens[value_idx + 1]);
                    tt_init_mb(&g_tt, mb);
                }
            }
            continue;
        } else if (strcmp(tokens[0], "position") == 0) {
            int i = 1;
            if (i < n && strcmp(tokens[i], "startpos") == 0) {
                board_set_startpos(&board);
                i++;
            } else if (i < n && strcmp(tokens[i], "fen") == 0) {
                i++;
                char fen[256] = {0};
                int fen_parts = 0;
                while (i < n && strcmp(tokens[i], "moves") != 0 && fen_parts < 6) {
                    if (fen_parts > 0) strncat(fen, " ", sizeof(fen) - strlen(fen) - 1);
                    strncat(fen, tokens[i], sizeof(fen) - strlen(fen) - 1);
                    fen_parts++;
                    i++;
                }
                if (fen_parts >= 4) board_set_fen(&board, fen);
            }

            if (i < n && strcmp(tokens[i], "moves") == 0) {
                i++;
                while (i < n) {
                    Move m;
                    if (parse_uci_move(&board, tokens[i], &m)) {
                        board_make_move(&board, &m);
                    }
                    i++;
                }
            }
        } else if (strcmp(tokens[0], "go") == 0) {
            int depth = MAX_DEPTH;
            int movetime = -1;
            int wtime = -1, btime = -1;
            int winc = 0, binc = 0;
            int movestogo = -1;
            int depth_specified = 0;

            for (int i = 1; i < n; ++i) {
                if (strcmp(tokens[i], "depth") == 0 && i + 1 < n) {
                    depth = atoi(tokens[++i]);
                    depth_specified = 1;
                }
                else if (strcmp(tokens[i], "movetime") == 0 && i + 1 < n) movetime = atoi(tokens[++i]);
                else if (strcmp(tokens[i], "wtime") == 0 && i + 1 < n) wtime = atoi(tokens[++i]);
                else if (strcmp(tokens[i], "btime") == 0 && i + 1 < n) btime = atoi(tokens[++i]);
                else if (strcmp(tokens[i], "winc") == 0 && i + 1 < n) winc = atoi(tokens[++i]);
                else if (strcmp(tokens[i], "binc") == 0 && i + 1 < n) binc = atoi(tokens[++i]);
                else if (strcmp(tokens[i], "movestogo") == 0 && i + 1 < n) movestogo = atoi(tokens[++i]);
            }

            long long limit_ms = compute_time_for_move(&board, wtime, btime, winc, binc, movetime, movestogo);
            SearchInfo info;
            Move best = search_best_move(&board, depth > MAX_DEPTH ? MAX_DEPTH : depth, limit_ms, depth_specified, &info);

            char best_str[8];
            move_to_uci(&best, best_str);
            if (best_str[0] == '\0') strcpy(best_str, "0000");
            printf("bestmove %s\n", best_str);
            fflush(stdout);
        } else if (strcmp(tokens[0], "quit") == 0) {
            break;
        } else if (strcmp(tokens[0], "stop") == 0) {
            continue;
        }
    }

    tt_free(&g_tt);
    return 0;
}
