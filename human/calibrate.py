#!/usr/bin/env python3
"""How human, and how strong, are the human player's moves?

Takes positions from a sample file (games the net was not trained on), lets bin/humanplayer
choose a move with a profile, and has the main engine (bin/darkhelmet) judge three moves per
position: the one the human played, the human player's search move and the plain policy move.
Prints how often each matches the human move and how much each loses on average (centipawn
loss, capped at 1000) plus the blunder rate (a loss of 200 cp or more). The human player
should lose about as much as the humans of its band do.

Usage: python3 human/calibrate.py val.bin [--positions 2000] [--profile 1300] [--nodes 100000]
                                   [--set Name=value ...]   (UCI options of bin/humanplayer)
                                   [--seed 1] [--jobs 14] [--chess960]   (Chess960 samples)
"""
import argparse
import queue
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Engine:
    def __init__(self, path):
        self.p = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.send("uci")
        self.wait("uciok")
        self.send("setoption name Hash value 16")

    def send(self, line):
        self.p.stdin.write(line + "\n")

    def wait(self, prefix):
        while True:
            line = self.p.stdout.readline()
            if line.startswith(prefix):
                return line

    def score(self, fen, moves, nodes):
        """Score in centipawns for the side to move after `moves`."""
        self.send(f"position fen {fen}" + (" moves " + " ".join(moves) if moves else ""))
        self.send(f"go nodes {nodes}")
        cp = 0
        while True:
            line = self.p.stdout.readline()
            if " score " in line:
                t = line.split()
                i = t.index("score")
                cp = int(t[i + 2]) if t[i + 1] == "cp" else (10000 if int(t[i + 2]) > 0 else -10000)
            if line.startswith("bestmove"):
                return cp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples")
    ap.add_argument("--positions", type=int, default=2000)
    ap.add_argument("--profile", default="1300")
    ap.add_argument("--nodes", type=int, default=100000)
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--jobs", type=int, default=14)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--chess960", action="store_true")
    a = ap.parse_args()

    # The positions, the human moves and the policy moves; then the search moves through UCI
    # with the options of --set and a fixed seed, so that runs can be compared.
    rows = subprocess.run([str(ROOT / "bin/humanplayer"), "sample", a.samples, str(a.positions), a.profile]
                          + (["960"] if a.chess960 else []),
                          capture_output=True, text=True, check=True).stdout.split("\n")
    rows = [r.split(";") for r in rows if r]
    if True:
        hp = subprocess.Popen([str(ROOT / "bin/humanplayer")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              text=True, bufsize=1)
        hp.stdin.write(f"setoption name Profile value {a.profile}\nsetoption name Seed value {a.seed}\n")
        hp.stdin.write(f"setoption name UCI_Chess960 value {str(a.chess960).lower()}\n")
        for s in a.set:
            name, value = s.split("=")
            hp.stdin.write(f"setoption name {name} value {value}\n")
        for r in rows:
            hp.stdin.write(f"position fen {r[0]}\ngo\n")
            while not (line := hp.stdout.readline()).startswith("bestmove"):
                pass
            r[2] = line.split()[1]
        hp.stdin.write("quit\n")

    engines = [Engine(str(ROOT / "bin/darkhelmet")) for _ in range(a.jobs)]
    for e in engines:
        e.send(f"setoption name UCI_Chess960 value {str(a.chess960).lower()}")

    # Each judging engine serves one position at a time (taking engines[k % jobs] let two
    # threads talk to the same engine at once and mixed up their answers).
    free = queue.Queue()
    for e in engines:
        free.put(e)

    def judge(k):
        e = free.get()
        try:
            return judge_with(e, k)
        finally:
            free.put(e)

    def judge_with(e, k):
        fen, human, search, policy = rows[k][:4]
        best = e.score(fen, [], a.nodes)
        loss = {}
        for name, mv in (("human", human), ("search", search), ("policy", policy)):
            after = -e.score(fen, [mv], a.nodes)
            loss[name] = max(0, min(1000, best - after))
        return human, search, policy, loss

    with ThreadPoolExecutor(a.jobs) as pool:
        results = list(pool.map(judge, range(len(rows))))
    for e in engines:
        e.send("quit")

    n = len(results)
    print(f"{n} positions, profile {a.profile} {' '.join(a.set)}, judged at {a.nodes} nodes")
    for name in ("human", "search", "policy"):
        losses = [r[3][name] for r in results]
        match = sum(1 for r in results if r[{"human": 0, "search": 1, "policy": 2}[name]] == r[0]) / n
        print(f"  {name:7s} move match {100 * match:5.1f}%   avg loss {sum(losses) / n:6.1f} cp   "
              f"blunders {100 * sum(1 for x in losses if x >= 200) / n:5.1f}%")


if __name__ == "__main__":
    sys.exit(main())
