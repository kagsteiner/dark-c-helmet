// Turns Lichess PGN (as written by filter.py: headers, then the moves on one line) into
// training positions for the human-like player (HSample, see hnet.h).
//
//   zstdcat games.pgn.zst | bin/human-convert out.bin [--min-clock 30]
//
// Chess960 games (a [FEN] header) start from their position. One sample per move played. Moves made with less than --min-clock seconds left on the
// mover's clock (time scrambles, read from the [%clk] comments) are left out; games without
// clock comments keep all moves.

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "eval.h"
#include "hnet.h"
#include "movegen.h"

static Position pos;

// SAN -> legal move, MOVE_NONE if it matches none (or more than one).
static Move parse_san(const char* san) {
    MoveList list;
    generate_legal(&pos, &list);
    char s[16];
    int n = 0;
    for (const char* p = san; *p && n < 15; ++p)
        if (!strchr("+#!?", *p)) s[n++] = *p;
    s[n] = '\0';
    if (!strcmp(s, "O-O") || !strcmp(s, "O-O-O")) {
        int flag = n == 3 ? FLAG_KING_CASTLE : FLAG_QUEEN_CASTLE;
        for (int i = 0; i < list.count; ++i)
            if (move_flags(list.moves[i].move) == flag) return list.moves[i].move;
        return MOVE_NONE;
    }
    int type = PAWN, promo = -1;
    const char* p = s;
    if (strchr("NBRQK", *p)) type = (int)(strchr("PNBRQK", *p++) - "PNBRQK");
    char* eq = strchr(s, '=');
    if (eq) {
        promo = (int)(strchr("PNBRQK", eq[1]) - "PNBRQK");
        *eq = '\0';
    }
    // What is left: [file][rank][x]square.
    size_t len = strlen(p);
    if (len < 2) return MOVE_NONE;
    int to = make_square(p[len - 1] - '1', p[len - 2] - 'a');
    int dfile = -1, drank = -1;
    for (size_t i = 0; i + 2 < len; ++i) {
        if (p[i] >= 'a' && p[i] <= 'h') dfile = p[i] - 'a';
        else if (p[i] >= '1' && p[i] <= '8') drank = p[i] - '1';
    }
    Move found = MOVE_NONE;
    for (int i = 0; i < list.count; ++i) {
        Move m = list.moves[i].move;
        if (move_is_castle(m) || move_to(m) != to || piece_type(moved_piece(&pos, m)) != type) continue;
        if (dfile >= 0 && file_of(move_from(m)) != dfile) continue;
        if (drank >= 0 && rank_of(move_from(m)) != drank) continue;
        if (move_is_promo(m) ? move_promo_type(m) != promo : promo >= 0) continue;
        if (found) return MOVE_NONE;
        found = m;
    }
    return found;
}

// Seconds in a "[%clk h:mm:ss]" comment, -1 if there is none.
static int clock_seconds(const char* comment) {
    const char* c = strstr(comment, "%clk ");
    int h, m, s;
    if (!c || sscanf(c + 5, "%d:%d:%d", &h, &m, &s) != 3) return -1;
    return h * 3600 + m * 60 + s;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: human-convert out.bin [--min-clock seconds] < games.pgn\n");
        return 1;
    }
    int min_clock = 30;
    for (int i = 2; i + 1 < argc; ++i)
        if (!strcmp(argv[i], "--min-clock")) min_clock = atoi(argv[i + 1]);
    FILE* out = fopen(argv[1], "wb");
    if (!out) {
        perror(argv[1]);
        return 1;
    }
    bitboards_init();
    position_init();
    eval_init();

    static char line[1 << 16];
    static HSample game[MAX_GAME_PLY];
    int welo = 0, belo = 0, result = 0;
    char fen[128] = "";
    long games = 0, bad = 0, samples = 0, scrambles = 0;
    while (fgets(line, sizeof(line), stdin)) {
        if (line[0] == '[') {
            sscanf(line, "[WhiteElo \"%d", &welo);
            sscanf(line, "[BlackElo \"%d", &belo);
            sscanf(line, "[FEN \"%127[^\"]", fen);
            if (!strncmp(line, "[Result ", 8))
                result = !strncmp(line + 9, "1-0", 3) ? 1 : !strncmp(line + 9, "0-1", 3) ? -1 : 0;
            continue;
        }
        if (!isdigit((unsigned char)line[0])) continue;
        // The move line: tokens separated by spaces, comments in braces.
        g_chess960 = fen[0] != '\0';
        pos_set_fen(&pos, g_chess960 ? fen : START_FEN);
        fen[0] = '\0';
        int n = 0, ok = 1, elo = (welo + belo) / 20;
        uint8_t keep[MAX_GAME_PLY];
        int movers[MAX_GAME_PLY];
        char* p = line;
        while (*p && ok) {
            while (*p == ' ' || *p == '\n') ++p;
            if (!*p) break;
            if (*p == '{') {
                char* end = strchr(p, '}');
                if (!end) break;
                *end = '\0';
                int secs = clock_seconds(p);
                if (n > 0 && secs >= 0 && secs < min_clock) keep[n - 1] = 0;
                p = end + 1;
                continue;
            }
            char* tok = p;
            while (*p && *p != ' ' && *p != '\n') ++p;
            if (*p) *p++ = '\0';
            if (isdigit((unsigned char)tok[0])) continue;  // "12." "12..." or a result
            if (tok[0] == '*') continue;
            if (n >= MAX_GAME_PLY - 1) break;
            Move m = parse_san(tok);
            if (!m) {
                ok = 0;
                break;
            }
            HSample* s = &game[n];
            memset(s, 0, sizeof(*s));
            hnet_encode(&pos, s->board, &s->castling);
            s->elo = (uint8_t)(elo > 255 ? 255 : elo);
            s->move = (uint16_t)hnet_move_index(&pos, m);
            s->ply = (uint8_t)(n > 255 ? 255 : n);
            movers[n] = pos.side;
            keep[n] = 1;
            pos_make_move(&pos, m);
            n++;
            if (pos.game_ply >= MAX_GAME_PLY - 2) break;
        }
        games++;
        if (!ok) {
            bad++;
            continue;
        }
        for (int i = 0; i < n; ++i) {
            if (!keep[i]) {
                scrambles++;
                continue;
            }
            game[i].result = (int8_t)(movers[i] == WHITE ? result : -result);
            fwrite(&game[i], sizeof(HSample), 1, out);
            samples++;
        }
        if (games % 500000 == 0) fprintf(stderr, "%ld games, %ld samples\n", games, samples);
    }
    fclose(out);
    fprintf(stderr, "DONE %ld games (%ld unreadable), %ld samples, %ld scramble moves left out\n", games, bad,
            samples, scrambles);
    return 0;
}
