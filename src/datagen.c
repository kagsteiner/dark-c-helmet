#include "datagen.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "movegen.h"
#include "search.h"
#include "tt.h"
#include "util.h"

// Self-play data generation for evaluation tuning (and later NNUE training).
// Output lines: "<fen> | <score, white's view> | <result, 1.0 / 0.5 / 0.0 from white's view>"

#define MAX_RECORDS 1024
#define WIN_ADJUDICATE 2000
#define RANDOM_PLIES 8

typedef struct {
    char fen[100];
    int score;
} Record;

static uint64_t rng(uint64_t* s) {
    uint64_t z = (*s += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

// Chess960 starting position number n (0-959, Scharnagl numbering; 518 is the standard one)
// as a FEN with Shredder-FEN castling rights.
static void frc_start_fen(int n, char* out, size_t size) {
    static const int knights[10][2] = {{0, 1}, {0, 2}, {0, 3}, {0, 4}, {1, 2}, {1, 3}, {1, 4}, {2, 3}, {2, 4}, {3, 4}};
    char r[9] = {0};
    r[2 * (n % 4) + 1] = 'B';
    n /= 4;
    r[2 * (n % 4)] = 'B';
    n /= 4;
    int free_sq[8], nf = 0;
    for (int i = 0; i < 8; ++i) if (!r[i]) free_sq[nf++] = i;
    r[free_sq[n % 6]] = 'Q';
    n /= 6;
    nf = 0;
    for (int i = 0; i < 8; ++i) if (!r[i]) free_sq[nf++] = i;
    r[free_sq[knights[n][0]]] = r[free_sq[knights[n][1]]] = 'N';
    nf = 0;
    for (int i = 0; i < 8; ++i) if (!r[i]) free_sq[nf++] = i;
    r[free_sq[0]] = 'R';
    r[free_sq[1]] = 'K';
    r[free_sq[2]] = 'R';
    char black[9];
    for (int i = 0; i < 8; ++i) black[i] = (char)(r[i] - 'A' + 'a');
    black[8] = '\0';
    snprintf(out, size, "%s/pppppppp/8/8/8/8/PPPPPPPP/%s w %c%c%c%c - 0 1", black, r, 'A' + free_sq[2],
             'A' + free_sq[0], 'a' + free_sq[2], 'a' + free_sq[0]);
}

static int random_opening(Position* pos, uint64_t* seed, int frc_percent) {
    if (frc_percent > 0 && (int)(rng(seed) % 100) < frc_percent) {
        char fen[100];
        frc_start_fen((int)(rng(seed) % 960), fen, sizeof(fen));
        pos_set_fen(pos, fen);
    } else {
        pos_set_fen(pos, START_FEN);
    }
    int plies = RANDOM_PLIES + (int)(rng(seed) % 2);  // vary the side to move
    for (int i = 0; i < plies; ++i) {
        MoveList list;
        generate_legal(pos, &list);
        if (list.count == 0) return 0;
        pos_make_move(pos, list.moves[rng(seed) % (uint64_t)list.count].move);
    }
    MoveList list;
    generate_legal(pos, &list);
    return list.count > 0;
}

void run_datagen(int games, long long nodes, uint64_t seed, const char* out_path, int frc_percent) {
    static Position pos;
    static Record records[MAX_RECORDS];
    FILE* out = fopen(out_path, "a");
    if (!out) {
        fprintf(stderr, "cannot open %s\n", out_path);
        return;
    }
    tt_resize(16);

    SearchLimits lim;
    memset(&lim, 0, sizeof(lim));
    lim.time[0] = lim.time[1] = -1;
    lim.movetime = -1;
    lim.nodes = nodes;

    long long start = now_ms(), total_positions = 0;
    int results[3] = {0, 0, 0};

    for (int g = 0; g < games; ++g) {
        if (!random_opening(&pos, &seed, frc_percent)) { g--; continue; }
        tt_clear();
        search_clear();

        // Skip clearly unbalanced openings.
        SearchResult r = search_run(&pos, &lim, 1, NULL);
        if (abs(r.score) > 300) { g--; continue; }

        int count = 0, win_plies = 0, draw_plies = 0;
        double result = 0.5;
        for (int ply = 0;; ++ply) {
            MoveList legal;
            generate_legal(&pos, &legal);
            if (legal.count == 0) {
                result = in_check(&pos) ? (pos.side == WHITE ? 0.0 : 1.0) : 0.5;
                break;
            }
            if (pos_is_draw(&pos, 0) || ply >= 400) { result = 0.5; break; }

            r = search_run(&pos, &lim, 1, NULL);
            int white_score = pos.side == WHITE ? r.score : -r.score;

            // Adjudication
            if (abs(r.score) >= WIN_ADJUDICATE) {
                if (++win_plies >= 4) { result = white_score > 0 ? 1.0 : 0.0; break; }
            } else {
                win_plies = 0;
            }
            if (ply >= 80 && abs(r.score) <= 10) {
                if (++draw_plies >= 12) { result = 0.5; break; }
            } else {
                draw_plies = 0;
            }

            if (!in_check(&pos) && !move_is_tactical(r.best_move) && abs(r.score) < WIN_ADJUDICATE &&
                count < MAX_RECORDS) {
                pos_to_fen(&pos, records[count].fen, sizeof(records[count].fen));
                records[count].score = white_score;
                count++;
            }
            pos_make_move(&pos, r.best_move);
            // Positions are rebuilt from FEN occasionally so the state stack never overflows.
            if (pos.game_ply >= MAX_GAME_PLY - 16) {
                char fen[128];
                pos_to_fen(&pos, fen, sizeof(fen));
                pos_set_fen(&pos, fen);
            }
        }

        results[result == 1.0 ? 0 : result == 0.5 ? 1 : 2]++;
        for (int i = 0; i < count; ++i)
            fprintf(out, "%s | %d | %.1f\n", records[i].fen, records[i].score, result);
        total_positions += count;
        if ((g + 1) % 20 == 0) {
            fflush(out);
            long long s = (now_ms() - start) / 1000;
            fprintf(stderr, "games %d  positions %lld  W/D/L %d/%d/%d  %lld s\n", g + 1, total_positions,
                    results[0], results[1], results[2], s);
        }
    }
    fclose(out);
}
