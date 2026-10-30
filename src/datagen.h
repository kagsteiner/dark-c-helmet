#ifndef DATAGEN_H
#define DATAGEN_H

#include <stdint.h>

// frc_percent: share of games (0-100) that start from a random Chess960 starting position.
void run_datagen(int games, long long nodes, uint64_t seed, const char* out_path, int frc_percent);

#endif
