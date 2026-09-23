#!/usr/bin/env python3
"""Quick W/D/L tally and Elo estimate for the first engine in a fastchess PGN."""
import math, re, sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
games = re.findall(r'\[White "([^"]+)"\]\s*\[Black "([^"]+)"\].*?\[Result "([^"]+)"\]', text, re.S)
if not games:
    sys.exit("no games")
engine = sys.argv[2] if len(sys.argv) > 2 else games[0][0]
w = d = l = 0
for white, black, res in games:
    if res == "1/2-1/2":
        d += 1
    elif res in ("1-0", "0-1"):
        won = (res == "1-0") == (white == engine)
        w, l = (w + 1, l) if won else (w, l + 1)
n = w + d + l
score = (w + d / 2) / n
elo = -400 * math.log10(1 / score - 1) if 0 < score < 1 else float("inf") * (1 if score else -1)
print(f"{engine}: +{w} ={d} -{l}  ({n} games, score {score:.3f}, Elo {elo:+.0f})")
