// UCI front end of the human-like player (bin/humanplayer, and dh-human.wasm in the web app).
//
// The profile decides how much it thinks; the clock decides how long it takes: like a person,
// it uses the time a move deserves (the main engine's budget, varied by +-25%) before
// answering. The WebAssembly build cannot wait, so there the app holds the move back.
// "policy" prints the net's moves for the current position, most likely first.
// Options: Profile (a rating band of HPROFILES), each profile field (scaled to
// integers, see the "uci" output), Seed.
//
//   bin/humanplayer                      UCI
//   bin/humanplayer sample <val.bin> <count> [profile] [960]   (960: Chess960 samples)
//       prints "fen human-move search-move policy-move" for <count> positions of a sample file
//       (bin/human-convert output), for measuring how human the moves are.

#define _POSIX_C_SOURCE 200809L  // clock_gettime
#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
char* wasm_fgets(char* buf, int size);
#define fgets(buf, size, stream) wasm_fgets((buf), (size))
#else
#include <sys/select.h>
#include <unistd.h>
#endif

#include "eval.h"
#include "hsearch.h"
#include "movegen.h"

static Position g_pos;
static HProfile g_profile;
static const char* g_net = NULL;

// Integer UCI options for the profile fields: name, field, scale (option = field * scale).
typedef struct {
    const char* name;
    size_t offset;
    int is_float;
    int scale, max;
} Field;
#define F(name, field, scale, max) {name, offsetof(HProfile, field), 1, scale, max}
#define I(name, field, max) {name, offsetof(HProfile, field), 0, 1, max}
static const Field FIELDS[] = {
    I("Candidates", candidates, 20),
    F("CandidateMass", cand_mass, 100, 100),
    F("Temperature", temperature, 100, 500),
    I("Replies", replies, 20),
    I("LineDepth", line_depth, 20),
    I("AltDepth", alt_depth, 20),
    F("Optimism", optimism, 100, 100),
    F("Satisfied", satisfied, 1000, 1000),
    F("Prior", prior, 1000, 1000),
    F("Blind", blind, 100, 100),
    I("Budget", budget, 100000),
    F("Material", material, 100, 100),
};
#define FIELD_COUNT ((int)(sizeof(FIELDS) / sizeof(FIELDS[0])))

static int field_get(const Field* f) {
    char* p = (char*)&g_profile + f->offset;
    return f->is_float ? (int)(*(float*)p * f->scale + 0.5f) : *(int*)p;
}

static void field_set(const Field* f, int v) {
    char* p = (char*)&g_profile + f->offset;
    if (f->is_float) *(float*)p = (float)v / f->scale;
    else *(int*)p = v;
}

// The band's net; in Chess960 its Chess960 net ("1300-960") when there is one.
static const char* use_net(const char* band) {
    char name[32];
    snprintf(name, sizeof(name), "%s-960", band);
    const char* net = g_chess960 ? hnet_use(name) : NULL;
    return net ? net : hnet_use(band);
}

static const HProfile* find_profile(const char* name) {
    for (int i = 0; i < HPROFILE_COUNT; ++i)
        if (!strcmp(HPROFILES[i].name, name)) return &HPROFILES[i];
    return NULL;
}

// The band chosen with the Profile option; in Chess960 its "-960" profile when there is one.
static char g_band[16];

static int use_profile(const char* name) {
    char name960[32];
    snprintf(name960, sizeof(name960), "%s-960", name);
    const HProfile* p = g_chess960 ? find_profile(name960) : NULL;
    if (!p) p = find_profile(name);
    const char* net = p ? use_net(name) : NULL;
    if (!net) return 0;
    g_profile = *p;
    g_net = net;
    snprintf(g_band, sizeof(g_band), "%s", name);
    return 1;
}

static void cmd_position(char* args) {
    char* moves = strstr(args, "moves");
    if (moves) moves[-1] = '\0';
    if (!strncmp(args, "startpos", 8)) pos_set_fen(&g_pos, START_FEN);
    else if (!strncmp(args, "fen ", 4)) pos_set_fen(&g_pos, args + 4);
    if (!moves) return;
    for (char* tok = strtok(moves + 5, " \t"); tok; tok = strtok(NULL, " \t")) {
        Move m = pos_parse_move(&g_pos, tok);
        if (!m) break;
        if (g_pos.game_ply >= MAX_GAME_PLY - 1) {
            char fen[128];
            pos_to_fen(&g_pos, fen, sizeof(fen));
            pos_set_fen(&g_pos, fen);
        }
        pos_make_move(&g_pos, m);
    }
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

// Milliseconds the move should take (search.c's soft limit), 0 without a clock.
static long long move_budget(const char* args) {
    long long t[2] = {-1, -1}, inc[2] = {0, 0}, mtg = 0, movetime = -1;
    const char* keys[] = {"wtime", "btime", "winc", "binc", "movestogo", "movetime"};
    long long* vals[] = {&t[WHITE], &t[BLACK], &inc[WHITE], &inc[BLACK], &mtg, &movetime};
    for (int i = 0; i < 6; ++i) {
        const char* k = strstr(args, keys[i]);
        if (k) *vals[i] = atoll(k + strlen(keys[i]));
    }
    if (movetime >= 0) return movetime;
    int us = g_pos.side;
    if (t[us] < 0) return 0;
    long long avail = t[us] > 50 ? t[us] - 50 : 1;
    long long soft = (mtg > 0 ? avail / (mtg + 1) : avail / 25) + inc[us] * 3 / 4;
    return soft < avail * 3 / 4 ? soft : avail * 3 / 4;
}

#ifndef __EMSCRIPTEN__
// Waits until `until` (ms) unless "stop" or "quit" arrives. Returns 1 on "quit".
static int wait_until(long long until) {
    for (;;) {
        long long left = until - now_ms();
        if (left <= 0) return 0;
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(STDIN_FILENO, &fds);
        struct timeval tv = {(time_t)(left / 1000), (suseconds_t)(left % 1000) * 1000};
        if (select(STDIN_FILENO + 1, &fds, NULL, NULL, &tv) > 0) {
            static char line[1024];
            if (!fgets(line, sizeof(line), stdin) || !strncmp(line, "quit", 4)) return 1;
            if (!strncmp(line, "stop", 4)) return 0;
            if (!strncmp(line, "isready", 7)) printf("readyok\n"), fflush(stdout);
        }
    }
}
#endif

static int g_quit = 0;

static void cmd_go(const char* args) {
    long long start = now_ms();
    long long budget = move_budget(args);
    HResult r = hsearch_run(&g_pos, &g_profile);
    char buf[6];
    if (r.best) {
        // The believed line's value as centipawns (logistic, 400 per factor of 10 in odds).
        float s = r.score < 0.001f ? 0.001f : r.score > 0.999f ? 0.999f : r.score;
        int cp = (int)(400 * log10f(s / (1 - s)));
        printf("info depth %d nodes %d score cp %d pv", g_profile.line_depth, r.evals, cp);
        Position copy;
        // Walk the line on a copy to write castling correctly.
        memcpy(&copy, &g_pos, sizeof(copy));
        copy.st = copy.states + (g_pos.st - g_pos.states);
        for (int i = 0; i < r.line_len; ++i) {
            move_to_str(&copy, r.line[i], buf);
            printf(" %s", buf);
            pos_make_move(&copy, r.line[i]);
        }
        printf("\n");
        move_to_str(&g_pos, r.best, buf);
    } else {
        strcpy(buf, "0000");
    }
#ifndef __EMSCRIPTEN__
    if (budget > 0 && r.best) {
        fflush(stdout);
        float vary = 0.75f + 0.5f * (float)(rand() % 1000) / 1000;
        g_quit = wait_until(start + (long long)(budget * vary));
    }
#else
    (void)budget;
#endif
    printf("info nodes %d time %lld nps 0\n", r.evals, now_ms() - start);
    printf("bestmove %s\n", buf);
}

static void cmd_setoption(char* args) {
    char* name = strstr(args, "name ");
    char* value = strstr(args, " value ");
    if (!name || !value) return;
    *value = '\0';
    name += 5;
    value += 7;
    for (size_t n = strlen(name); n > 0 && isspace((unsigned char)name[n - 1]); --n) name[n - 1] = '\0';
    for (size_t n = strlen(value); n > 0 && isspace((unsigned char)value[n - 1]); --n) value[n - 1] = '\0';
    if (!strcasecmp(name, "Profile")) {
        if (!use_profile(value)) printf("info string no profile or network for %s\n", value);
    } else if (!strcasecmp(name, "Seed")) {
        hsearch_seed((uint64_t)atoll(value));
    } else if (!strcasecmp(name, "UCI_Chess960")) {
        // Switching resets options set since the Profile (the band's other profile and net).
        int on = !strcmp(value, "true");
        if (on != g_chess960) {
            g_chess960 = on;
            if (g_band[0]) use_profile(g_band);
        }
    } else {
        for (int i = 0; i < FIELD_COUNT; ++i)
            if (!strcasecmp(name, FIELDS[i].name)) field_set(&FIELDS[i], atoi(value));
    }
}

static void uci_loop(void) {
    static char line[65536];
    while (!g_quit && fgets(line, sizeof(line), stdin)) {
        char* nl = strpbrk(line, "\r\n");
        if (nl) *nl = '\0';
        char* cmd = line;
        while (*cmd == ' ' || *cmd == '\t') cmd++;
        char* args = strchr(cmd, ' ');
        if (args) *args++ = '\0';
        else args = cmd + strlen(cmd);

        if (!strcmp(cmd, "uci")) {
            printf("id name Human %s %s\nid author %s\n", g_profile.name, ENGINE_VERSION, ENGINE_AUTHOR);
            printf("option name Profile type combo default %s", g_profile.name);
            for (int i = 0; i < HPROFILE_COUNT; ++i) printf(" var %s", HPROFILES[i].name);
            printf("\n");
            for (int i = 0; i < FIELD_COUNT; ++i)
                printf("option name %s type spin default %d min 0 max %d\n", FIELDS[i].name, field_get(&FIELDS[i]),
                       FIELDS[i].max);
            printf("option name Seed type spin default 0 min 0 max 2147483647\n");
            printf("option name UCI_Chess960 type check default false\n");
            printf("info string net %s\n", g_net ? g_net : "none");
            printf("uciok\n");
        } else if (!strcmp(cmd, "isready")) {
            printf("readyok\n");
        } else if (!strcmp(cmd, "ucinewgame")) {
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
        } else if (!strcmp(cmd, "policy")) {
            // The net's moves for the current position, most likely first (for analysis).
            HEval e;
            hnet_evaluate(&g_pos, &e);
            char buf[6];
            printf("policy value %.3f", e.value);
            for (int i = 0; i < e.count; ++i) {
                move_to_str(&g_pos, e.moves[i], buf);
                printf(" %s %.4f", buf, e.prob[i]);
            }
            printf("\n");
        }
        fflush(stdout);
    }
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE void wasm_pump(void) { uci_loop(); }
#endif

// A sample's position as a FEN (the sample is already seen from the mover = White).
static void sample_fen(const HSample* s, char* out) {
    static const char LETTERS[] = "PNBRQKpnbrqk";
    int n = 0;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f < 8; ++f) {
            int pc = s->board[r * 8 + f];
            if (pc == 12) {
                empty++;
                continue;
            }
            if (empty) out[n++] = (char)('0' + empty);
            empty = 0;
            out[n++] = LETTERS[pc];
        }
        if (empty) out[n++] = (char)('0' + empty);
        if (r) out[n++] = '/';
    }
    n += sprintf(out + n, " w ");
    const char* rights = "KQkq";
    int any = 0;
    for (int i = 0; i < 4; ++i)
        if (s->castling & (1 << i)) out[n++] = rights[i], any = 1;
    if (!any) out[n++] = '-';
    sprintf(out + n, " - 0 1");
}

static int run_sample(const char* path, int count, const char* profile) {
    FILE* f = fopen(path, "rb");
    if (!f) {
        perror(path);
        return 1;
    }
    fseek(f, 0, SEEK_END);
    long total = ftell(f) / (long)sizeof(HSample);
    long step = total / count > 0 ? total / count : 1;
    if (profile && !use_profile(profile)) {
        fprintf(stderr, "no profile %s\n", profile);
        return 1;
    }
    for (int i = 0; i < count && (long)i * step < total; ++i) {
        HSample s;
        fseek(f, (long)i * step * (long)sizeof(HSample), SEEK_SET);
        if (fread(&s, sizeof(s), 1, f) != 1) break;
        char fen[128];
        sample_fen(&s, fen);
        if (!pos_set_fen(&g_pos, fen)) continue;
        // The move played, as a legal move of this position.
        MoveList list;
        generate_legal(&g_pos, &list);
        Move human = MOVE_NONE;
        for (int k = 0; k < list.count; ++k)
            if (hnet_move_index(&g_pos, list.moves[k].move) == s.move &&
                (!move_is_promo(list.moves[k].move) || move_promo_type(list.moves[k].move) == QUEEN))
                human = list.moves[k].move;
        if (!human) continue;
        HEval e;
        hnet_evaluate(&g_pos, &e);
        HResult r = hsearch_run(&g_pos, &g_profile);
        char a[6], b[6], c[6];
        move_to_str(&g_pos, human, a);
        move_to_str(&g_pos, r.best, b);
        move_to_str(&g_pos, e.moves[0], c);
        printf("%s;%s;%s;%s;%d\n", fen, a, b, c, s.elo * 10);
    }
    fclose(f);
    return 0;
}

int main(int argc, char** argv) {
    bitboards_init();
    position_init();
    eval_init();
    hsearch_seed((uint64_t)time(NULL));
    srand((unsigned)time(NULL));
    if (!use_profile(HPROFILES[0].name)) fprintf(stderr, "no network embedded for profile %s\n", HPROFILES[0].name);
    pos_set_fen(&g_pos, START_FEN);
    if (argc > 3 && !strcmp(argv[1], "sample")) {
        g_chess960 = argc > 5 && !strcmp(argv[5], "960");
        return run_sample(argv[2], atoi(argv[3]), argc > 4 ? argv[4] : NULL);
    }
#ifdef __EMSCRIPTEN__
    // Single-threaded WebAssembly: JavaScript runs the loop with wasm_pump() after each command.
    emscripten_exit_with_live_runtime();
#endif
    uci_loop();
    return 0;
}
