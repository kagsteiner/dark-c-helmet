#!/usr/bin/env python3
"""Writes all 960 Chess960 starting positions (Scharnagl numbering 0-959) as EPD with
Shredder-FEN castling rights, e.g. "bqnb1rkr/pppppppp/8/8/8/8/PPPPPPPP/BQNB1RKR w HFhf - 0 1".

Usage: python3 tools/books/make_frc960.py > tools/books/frc960.epd
"""

KNIGHTS = [(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (1, 3), (1, 4), (2, 3), (2, 4), (3, 4)]


def back_rank(n):
    rank = [None] * 8
    n, b1 = divmod(n, 4)
    rank[2 * b1 + 1] = "B"                      # light-squared bishop: b, d, f, h
    n, b2 = divmod(n, 4)
    rank[2 * b2] = "B"                          # dark-squared bishop: a, c, e, g
    n, q = divmod(n, 6)
    free = [i for i in range(8) if rank[i] is None]
    rank[free[q]] = "Q"
    free = [i for i in range(8) if rank[i] is None]
    k1, k2 = KNIGHTS[n]
    rank[free[k1]] = rank[free[k2]] = "N"
    free = [i for i in range(8) if rank[i] is None]
    rank[free[0]], rank[free[1]], rank[free[2]] = "R", "K", "R"
    return "".join(rank)


def main():
    for n in range(960):
        r = back_rank(n)
        rooks = [i for i, p in enumerate(r) if p == "R"]
        files = "abcdefgh"
        castling = files[rooks[1]].upper() + files[rooks[0]].upper() + files[rooks[1]] + files[rooks[0]]
        print(f"{r.lower()}/pppppppp/8/8/8/8/PPPPPPPP/{r} w {castling} - 0 1")


if __name__ == "__main__":
    main()
