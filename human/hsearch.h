// The human-like player's search: a few candidate moves, each followed as one line
// ("I play A, he answers B, I play C ..."), only the opponent's most obvious replies checked,
// optimistic about the result, and the first line that looks good enough is played.
#ifndef HSEARCH_H
#define HSEARCH_H

#include "hnet_eval.h"

// How a player of one strength thinks. Probabilities and values are in win-probability
// units (0..1) unless noted. The UCI options of huci.c set each field (scaled to integers).
typedef struct {
    const char* name;
    int candidates;      // at most this many candidate moves
    float cand_mass;     // ... and only until their policy probability adds up to this
    float temperature;   // randomness in which idea comes first (0 = always the most likely)
    int replies;         // opponent replies checked after a candidate (the obvious one first)
    int line_depth;      // plies followed after the obvious reply
    int alt_depth;       // plies followed after a less obvious reply
    float optimism;      // 0: a candidate is worth its worst checked reply, 1: their average
    float satisfied;     // play a candidate at once if its line beats the position by this much
    float prior;         // weight of the policy's liking (per unit of log probability)
    float blind;         // chance to overlook a backward or long quiet opponent reply
    float material;      // weight of a plain material count (P1 N3 B3 R5 Q9) at a line's end
    int budget;          // most positions evaluated per move
} HProfile;

extern const HProfile HPROFILES[];
extern const int HPROFILE_COUNT;

typedef struct {
    Move best;
    float score;     // the chosen line's value for the side to move (with optimism)
    int evals;       // positions evaluated
    int line_len;
    Move line[32];   // the line the player believed in
} HResult;

void hsearch_seed(uint64_t seed);
HResult hsearch_run(Position* pos, const HProfile* p);

#endif
