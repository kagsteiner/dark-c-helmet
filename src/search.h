#ifndef SEARCH_H
#define SEARCH_H

#include "position.h"

typedef struct {
    int time[2];        // remaining time in ms, -1 if not given
    int inc[2];
    int movestogo;
    int movetime;       // -1 if not given
    int depth;          // 0 = no limit
    long long nodes;    // 0 = no limit
    int infinite;
} SearchLimits;

typedef struct {
    Move best_move;
    int score;
    int depth;
    long long nodes;
} SearchResult;

extern int g_move_overhead;

void search_init(void);
void search_clear(void);  // forget history tables (new game)

// Runs a search on a copy of pos. If silent, prints nothing and ignores stdin.
// poll_stop is called periodically and returns 1 when the GUI asked to stop.
SearchResult search_run(const Position* pos, const SearchLimits* limits, int silent, int (*poll_stop)(void));

#endif
