#!/usr/bin/env python3
"""Move generator correctness check: runs perft on standard positions and compares
node counts with known values. The engine also reports incremental-hash mismatches.

Usage: python3 tools/perft_suite.py <engine-binary> [--quick]
"""
import subprocess
import sys

# (fen, depth, expected nodes) -- values from the Chess Programming Wiki perft results
POSITIONS = [
    ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 5, 4865609),
    ("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 4, 4085603),
    ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 6, 11030083),
    ("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 5, 15833292),
    ("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 4, 2103487),
    ("r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", 4, 3894594),
]
QUICK = [
    ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 4, 197281),
    ("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3, 97862),
    ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 5, 674624),
    ("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 4, 422333),
    ("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 3, 62379),
]


def run(engine, fen, depth):
    cmds = f"position fen {fen}\nperft {depth}\nquit\n"
    out = subprocess.run([engine], input=cmds, capture_output=True, text=True).stdout
    nodes, hash_errors = None, 0
    for line in out.splitlines():
        if line.startswith("Nodes searched:"):
            nodes = int(line.split(":")[1])
        elif line.startswith("HASH ERRORS:"):
            hash_errors = int(line.split(":")[1])
    return nodes, hash_errors


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    engine = sys.argv[1]
    positions = QUICK if "--quick" in sys.argv else POSITIONS
    failures = 0
    for fen, depth, expected in positions:
        nodes, hash_errors = run(engine, fen, depth)
        ok = nodes == expected and hash_errors == 0
        failures += not ok
        status = "ok  " if ok else "FAIL"
        extra = f"  hash errors: {hash_errors}" if hash_errors else ""
        print(f"{status} depth {depth} {nodes} (expected {expected}){extra}  {fen}")
    print("ALL PASSED" if failures == 0 else f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
