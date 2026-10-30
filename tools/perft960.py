#!/usr/bin/env python3
"""Chess960 move generator check: perft on the 960 reference positions of the Chess
Programming Wiki (https://www.chessprogramming.org/Chess960_Perft_Results), in the format of
python-chess's examples/perft/chess960.perft:

    curl -sSfLO https://raw.githubusercontent.com/niklasf/python-chess/master/examples/perft/chess960.perft

Usage: python3 tools/perft960.py <engine-binary> <chess960.perft> [depth=4] [max-positions]

At depth <= 4 the engine also recomputes the hash keys after every move ("HASH ERRORS").
"""
import concurrent.futures
import subprocess
import sys


def load(path):
    positions, fen = [], None
    for line in open(path):
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "epd":
            fen = " ".join(parts[1:]) + " 0 1"
            positions.append([fen, {}])
        elif parts[0] == "perft" and positions:
            positions[-1][1][int(parts[1])] = int(parts[2])
    return positions


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    engine, path = sys.argv[1], sys.argv[2]
    depth = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    positions = load(path)
    if len(sys.argv) > 4:
        positions = positions[: int(sys.argv[4])]
    positions = [p for p in positions if depth in p[1]]

    def run(chunk):
        cmds = "setoption name UCI_Chess960 value true\n"
        cmds += "".join(f"position fen {fen}\nperft {depth}\n" for fen, _ in chunk) + "quit\n"
        out = subprocess.run([engine], input=cmds, capture_output=True, text=True).stdout
        nodes, errors = [], 0
        for line in out.splitlines():
            if line.startswith("Nodes searched:"):
                nodes.append(int(line.split(":")[1]))
            elif line.startswith("HASH ERRORS:"):
                errors += int(line.split(":")[1])
        return nodes, errors

    procs = 16
    chunks = [positions[i::procs] for i in range(procs)]
    with concurrent.futures.ThreadPoolExecutor(procs) as pool:
        outputs = list(pool.map(run, chunks))
    results, ordered, hash_errors = [], [], 0
    for chunk, (nodes, errors) in zip(chunks, outputs):
        ordered += chunk[: len(nodes)]
        results += nodes
        hash_errors += errors
    missing = len(positions) - len(results)
    positions = ordered

    failures = 0
    for (fen, expected), nodes in zip(positions, results):
        if nodes != expected[depth]:
            failures += 1
            print(f"FAIL depth {depth}: {nodes} (expected {expected[depth]})  {fen}")
    print(f"{len(results)} positions at depth {depth}: {failures} wrong, {missing} missing, "
          f"{hash_errors} hash errors")
    print("ALL PASSED" if failures == 0 and missing == 0 and hash_errors == 0 else "FAILED")
    return 0 if failures == 0 and missing == 0 and hash_errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
