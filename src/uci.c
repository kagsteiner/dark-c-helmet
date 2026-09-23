#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <sys/select.h>
#include <unistd.h>
#endif

#include "datagen.h"
#include "eval.h"
#include "movegen.h"
#include "nnue.h"
#include "perft.h"
#include "search.h"
#include "tt.h"
#include "util.h"

#define MAX_LINE 65536
#define DEFAULT_HASH_MB 64
#define BENCH_DEPTH 16

static Position g_pos;
static int nnue_available = 0;  // static: on macOS a heap/stack-allocated board measured much slower
static int g_quit = 0;

// ---------------------------------------------------------------------------
// Non-blocking input check, used to receive "stop" while searching
// ---------------------------------------------------------------------------

static int input_waiting(void) {
#ifdef _WIN32
    static int init = 0, is_pipe = 0;
    static HANDLE inh;
    DWORD dw;
    if (!init) {
        init = 1;
        inh = GetStdHandle(STD_INPUT_HANDLE);
        is_pipe = !GetConsoleMode(inh, &dw);
        if (!is_pipe) {
            SetConsoleMode(inh, dw & ~(ENABLE_MOUSE_INPUT | ENABLE_WINDOW_INPUT));
            FlushConsoleInputBuffer(inh);
        }
    }
    if (is_pipe) {
        if (!PeekNamedPipe(inh, NULL, 0, NULL, &dw, NULL)) return 1;
        return dw > 0;
    }
    GetNumberOfConsoleInputEvents(inh, &dw);
    return dw > 1;
#else
    fd_set readfds;
    struct timeval tv = {0, 0};
    FD_ZERO(&readfds);
    FD_SET(STDIN_FILENO, &readfds);
    return select(STDIN_FILENO + 1, &readfds, NULL, NULL, &tv) > 0;
#endif
}

// Called by the search every few thousand nodes. Returns 1 if the search must stop.
static int poll_stop(void) {
    if (!input_waiting()) return 0;
    char line[256];
    if (!fgets(line, sizeof(line), stdin)) {
        g_quit = 1;
        return 1;
    }
    if (strncmp(line, "quit", 4) == 0) {
        g_quit = 1;
        return 1;
    }
    if (strncmp(line, "stop", 4) == 0) return 1;
    if (strncmp(line, "isready", 7) == 0) {
        printf("readyok\n");
        fflush(stdout);
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Bench and genfens
// ---------------------------------------------------------------------------

static const char* BENCH_FENS[] = {
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 0 8",
    "r2q1rk1/pp1nbppp/2p1pn2/3p4/2PP1B2/2N1PN2/PP1Q1PPP/R3KB1R w KQ - 0 9",
    "rnbqk2r/ppp1bppp/4pn2/3p4/2PP4/5NP1/PP2PPBP/RNBQK2R b KQkq - 1 5",
    "r1b2rk1/2q1bppp/p2p1n2/np2p3/3PP3/5N1P/PPBN1PP1/R1BQR1K1 b - - 0 13",
    "2rq1rk1/pb1nbppp/1p2pn2/2pp4/2PP4/1P1BPN2/PB1N1PPP/2RQ1RK1 w - - 4 13",
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    "3r2k1/pp3pp1/2p1b2p/8/3P4/2PB1N2/PP3PPP/4R1K1 w - - 0 22",
    "r3r1k1/pp3pp1/2p2n1p/3p4/3P4/2NQ1N1P/PPq2PP1/R4RK1 w - - 0 18",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "8/5pk1/6p1/3P4/1p3P2/6P1/5K2/8 w - - 0 45",
    "6k1/5p2/6p1/8/7p/8/6PP/6K1 b - - 0 1",
    "8/8/4k3/3p4/3P4/4K3/8/8 w - - 0 1",
    "4r1k1/p4ppp/1p6/2p5/2P5/1P3N2/P4PPP/6K1 w - - 0 25",
    "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
};

static void run_bench(int depth) {
    static Position bench_pos;
    int count = (int)(sizeof(BENCH_FENS) / sizeof(BENCH_FENS[0]));
    long long total = 0, start = now_ms();
    SearchLimits lim;
    memset(&lim, 0, sizeof(lim));
    lim.time[0] = lim.time[1] = -1;
    lim.movetime = -1;
    lim.depth = depth;
    for (int i = 0; i < count; ++i) {
        pos_set_fen(&bench_pos, BENCH_FENS[i]);
        tt_clear();
        search_clear();
        long long t0 = now_ms();
        SearchResult r = search_run(&bench_pos, &lim, 1, NULL);
        char buf[6];
        move_to_str(r.best_move, buf);
        printf("position %2d  bestmove %-6s score %6d  nodes %10lld  time %6lld ms\n", i + 1, buf, r.score,
               r.nodes, now_ms() - t0);
        total += r.nodes;
    }
    long long ms = now_ms() - start;
    if (ms <= 0) ms = 1;
    printf("%lld nodes %lld nps\n", total, total * 1000 / ms);
    fflush(stdout);
    tt_clear();
    search_clear();
}

static uint64_t rng_next(uint64_t* s) {
    uint64_t z = (*s += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

// Random balanced opening positions for engine matches: genfens <count> [seed <n>] [plies <n>]
static void run_genfens(int count, uint64_t seed, int plies) {
    static Position p;
    SearchLimits lim;
    memset(&lim, 0, sizeof(lim));
    lim.time[0] = lim.time[1] = -1;
    lim.movetime = -1;
    lim.depth = 8;
    int produced = 0;
    long long attempts = 0;
    while (produced < count && attempts++ < (long long)count * 1000) {
        pos_set_fen(&p, START_FEN);
        int ok = 1;
        for (int i = 0; i < plies && ok; ++i) {
            MoveList list;
            generate_legal(&p, &list);
            if (list.count == 0) { ok = 0; break; }
            pos_make_move(&p, list.moves[rng_next(&seed) % (uint64_t)list.count].move);
        }
        if (!ok) continue;
        MoveList list;
        generate_legal(&p, &list);
        if (list.count == 0) continue;
        tt_clear();
        SearchResult r = search_run(&p, &lim, 1, NULL);
        if (abs(r.score) > 100) continue;
        char fen[128];
        pos_to_fen(&p, fen, sizeof(fen));
        printf("%s\n", fen);
        produced++;
    }
    fflush(stdout);
    tt_clear();
}

// ---------------------------------------------------------------------------
// UCI commands
// ---------------------------------------------------------------------------

static void cmd_position(char* args) {
    char* moves = strstr(args, "moves");
    if (moves) *(moves - 1) = '\0';
    if (strncmp(args, "startpos", 8) == 0) {
        pos_set_fen(&g_pos, START_FEN);
    } else if (strncmp(args, "fen", 3) == 0) {
        if (!pos_set_fen(&g_pos, args + 4)) pos_set_fen(&g_pos, START_FEN);
    }
    if (!moves) return;
    char* save = NULL;
    for (char* tok = strtok_r_portable(moves + 5, " \t\r\n", &save); tok;
         tok = strtok_r_portable(NULL, " \t\r\n", &save)) {
        Move m = pos_parse_move(&g_pos, tok);
        if (m == MOVE_NONE) break;
        // Keep room for the search: restart the history from the current FEN if needed.
        if (g_pos.game_ply >= MAX_GAME_PLY - 1) {
            char fen[128];
            pos_to_fen(&g_pos, fen, sizeof(fen));
            pos_set_fen(&g_pos, fen);
        }
        pos_make_move(&g_pos, m);
    }
}

static void cmd_go(char* args) {
    SearchLimits lim;
    memset(&lim, 0, sizeof(lim));
    lim.time[0] = lim.time[1] = -1;
    lim.movetime = -1;

    char* save = NULL;
    for (char* tok = strtok_r_portable(args, " \t\r\n", &save); tok; tok = strtok_r_portable(NULL, " \t\r\n", &save)) {
        char* next = NULL;
#define NEXT_INT() ((next = strtok_r_portable(NULL, " \t\r\n", &save)) ? atoll(next) : 0)
        if (!strcmp(tok, "wtime")) lim.time[WHITE] = (int)NEXT_INT();
        else if (!strcmp(tok, "btime")) lim.time[BLACK] = (int)NEXT_INT();
        else if (!strcmp(tok, "winc")) lim.inc[WHITE] = (int)NEXT_INT();
        else if (!strcmp(tok, "binc")) lim.inc[BLACK] = (int)NEXT_INT();
        else if (!strcmp(tok, "movestogo")) lim.movestogo = (int)NEXT_INT();
        else if (!strcmp(tok, "movetime")) lim.movetime = (int)NEXT_INT();
        else if (!strcmp(tok, "depth")) lim.depth = (int)NEXT_INT();
        else if (!strcmp(tok, "nodes")) lim.nodes = NEXT_INT();
        else if (!strcmp(tok, "infinite")) lim.infinite = 1;
        else if (!strcmp(tok, "perft")) {
            perft_divide(&g_pos, (int)NEXT_INT());
            return;
        }
#undef NEXT_INT
    }

    SearchResult r = search_run(&g_pos, &lim, 0, poll_stop);

    // In infinite mode bestmove may only be sent after "stop".
    if (lim.infinite && !g_quit) {
        char line[256];
        while (fgets(line, sizeof(line), stdin)) {
            if (strncmp(line, "quit", 4) == 0) { g_quit = 1; break; }
            if (strncmp(line, "stop", 4) == 0) break;
            if (strncmp(line, "isready", 7) == 0) { printf("readyok\n"); fflush(stdout); }
        }
    }
    char buf[6];
    move_to_str(r.best_move, buf);
    printf("bestmove %s\n", buf);
    fflush(stdout);
}

static void cmd_setoption(char* args) {
    char* name = strstr(args, "name ");
    char* value = strstr(args, " value ");
    if (!name) return;
    name += 5;
    if (value) {
        *value = '\0';
        value += 7;
    }
    for (char* c = name; *c; ++c) *c = (char)tolower((unsigned char)*c);
    // trim trailing whitespace of the name
    for (size_t n = strlen(name); n > 0 && isspace((unsigned char)name[n - 1]); --n) name[n - 1] = '\0';

    if (!strcmp(name, "hash") && value) tt_resize((size_t)atoll(value));
    else if (!strcmp(name, "move overhead") && value) g_move_overhead = atoi(value);
    else if (!strcmp(name, "clear hash")) tt_clear();
    else if (!strcmp(name, "usennue") && value) g_use_nnue = !strcmp(value, "true") && nnue_available;
    else if (!strcmp(name, "evalfile") && value && *value && strcmp(value, "<embedded>")) {
        if (nnue_load_file(value)) {
            nnue_available = 1;
            printf("info string loaded network %s\n", value);
        } else {
            printf("info string could not load network %s\n", value);
        }
    }
    // "Threads" is accepted but the engine is single-threaded for now.
}

static void uci_loop(void) {
    static char line[MAX_LINE];
    while (!g_quit && fgets(line, sizeof(line), stdin)) {
        char* nl = strpbrk(line, "\r\n");
        if (nl) *nl = '\0';
        char* cmd = line;
        while (*cmd == ' ' || *cmd == '\t') cmd++;
        char* args = strchr(cmd, ' ');
        if (args) *args++ = '\0';
        else args = cmd + strlen(cmd);

        if (!strcmp(cmd, "uci")) {
            printf("id name %s %s\nid author %s\n", ENGINE_NAME, ENGINE_VERSION, ENGINE_AUTHOR);
            printf("option name Hash type spin default %d min 1 max 65536\n", DEFAULT_HASH_MB);
            printf("option name Threads type spin default 1 min 1 max 1\n");
            printf("option name Move Overhead type spin default %d min 0 max 5000\n", g_move_overhead);
            printf("option name Clear Hash type button\n");
            printf("option name UseNNUE type check default %s\n", g_use_nnue ? "true" : "false");
            printf("option name EvalFile type string default <embedded>\n");
            printf("uciok\n");
        } else if (!strcmp(cmd, "isready")) {
            printf("readyok\n");
        } else if (!strcmp(cmd, "ucinewgame")) {
            tt_clear();
            search_clear();
            pos_set_fen(&g_pos, START_FEN);
        } else if (!strcmp(cmd, "position")) {
            cmd_position(args);
        } else if (!strcmp(cmd, "go")) {
            cmd_go(args);
        } else if (!strcmp(cmd, "setoption")) {
            cmd_setoption(args);
        } else if (!strcmp(cmd, "quit")) {
            break;
        } else if (!strcmp(cmd, "d")) {
            pos_print(&g_pos);
        } else if (!strcmp(cmd, "eval")) {
            printf("eval %d (side to move)\n", evaluate(&g_pos));
        } else if (!strcmp(cmd, "perft")) {
            perft_divide(&g_pos, atoi(args));
        } else if (!strcmp(cmd, "bench")) {
            run_bench(*args ? atoi(args) : BENCH_DEPTH);
        } else if (!strcmp(cmd, "genfens")) {
            int count = atoi(args);
            uint64_t seed = 1;
            int plies = 8;
            char* s = strstr(args, "seed ");
            if (s) seed = (uint64_t)atoll(s + 5);
            char* p = strstr(args, "plies ");
            if (p) plies = atoi(p + 6);
            run_genfens(count, seed, plies);
        }
        fflush(stdout);
    }
}

int main(int argc, char** argv) {
    bitboards_init();
    position_init();
    eval_init();
    search_init();
    nnue_available = nnue_init();
    tt_resize(DEFAULT_HASH_MB);
    pos_set_fen(&g_pos, START_FEN);

    if (argc > 1 && !strcmp(argv[1], "bench")) {
        run_bench(argc > 2 ? atoi(argv[2]) : BENCH_DEPTH);
        tt_free();
        return 0;
    }
    // datagen <games> <nodes per move> <seed> <output file>
    if (argc > 5 && !strcmp(argv[1], "datagen")) {
        run_datagen(atoi(argv[2]), atoll(argv[3]), (uint64_t)atoll(argv[4]), argv[5]);
        tt_free();
        return 0;
    }

    // Unbuffered input so polling stdin during search sees every pending command.
    setvbuf(stdin, NULL, _IONBF, 0);
    uci_loop();
    tt_free();
    return 0;
}
