#!/usr/bin/env python3
"""SPSA tuner for the search constants in src/tune.h.

Each worker repeatedly takes the current parameter vector theta, picks a random direction
delta (+1/-1 per parameter), and plays one game pair (same opening, both colours) between
theta + c*delta and theta - c*delta. The score difference moves theta towards the winner:

    theta_i += R_k * c_k * (wins - losses) * delta_i,   R_k = a_k / c_k^2

with the usual SPSA gain sequences a_k = a / (A + k)^0.602 and c_k = c / k^0.101. As on
fishtest, the gains are set from c_end (perturbation size at the end, per parameter) and
r_end (learning rate at the end), and the engine sees the rounded values.

    make spsa
    python3 tools/spsa/spsa.py --pairs 16000 --workers 16 --tc 5+0.05

The state is saved to --state after every update, and a run resumes from it when restarted.
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SPIN_RE = re.compile(r"option name (\S+) type spin default (-?\d+) min (-?\d+) max (-?\d+)")
RESULT_RE = re.compile(r"Games: (\d+), Wins: (\d+), Losses: (\d+), Draws: (\d+)")
SKIP = {"Hash", "Threads", "Move"}  # regular engine options, not search constants


def engine_params(engine):
    out = subprocess.run([engine], input="uci\nquit\n", capture_output=True, text=True).stdout
    params = {}
    for name, default, lo, hi in SPIN_RE.findall(out):
        if name in SKIP:
            continue
        params[name] = {"default": int(default), "min": int(lo), "max": int(hi)}
    if not params:
        sys.exit(f"{engine} exposes no tunable options; build it with `make spsa`")
    return params


class Spsa:
    def __init__(self, args):
        self.args = args
        self.params = engine_params(args.engine)
        self.lock = threading.Lock()
        self.k = 0
        self.theta = {n: float(p["default"]) for n, p in self.params.items()}
        self.results = [0, 0, 0]  # plus-side wins, losses, draws
        if os.path.exists(args.state):
            with open(args.state) as f:
                state = json.load(f)
            self.k = state["k"]
            self.results = state["results"]
            for n, v in state["theta"].items():
                if n in self.theta:
                    self.theta[n] = v
            print(f"resuming at pair {self.k}", flush=True)
        n = args.pairs
        self.A = 0.1 * n
        self.c_end, self.a = {}, {}
        for name, p in self.params.items():
            # Perturb by 1/20 of the range, but at least 0.6 so small integers still differ
            # after rounding.
            c_end = max((p["max"] - p["min"]) / 20.0, 0.6)
            self.c_end[name] = c_end
            self.a[name] = args.r_end * c_end ** 2 * (self.A + n) ** 0.602
        self.c = {name: self.c_end[name] * n ** 0.101 for name in self.params}

    def clamp(self, name, v):
        p = self.params[name]
        return min(max(v, p["min"]), p["max"])

    def next_job(self):
        with self.lock:
            if self.k >= self.args.pairs:
                return None
            self.k += 1
            k = self.k
            job = {"k": k, "delta": {}, "plus": {}, "minus": {}, "ck": {}}
            for name in self.params:
                ck = self.c[name] / k ** 0.101
                d = random.choice((-1, 1))
                job["delta"][name] = d
                job["ck"][name] = ck
                job["plus"][name] = round(self.clamp(name, self.theta[name] + ck * d))
                job["minus"][name] = round(self.clamp(name, self.theta[name] - ck * d))
            return job

    def update(self, job, wins, losses, draws):
        k = job["k"]
        result = wins - losses
        with self.lock:
            for name in self.params:
                ak = self.a[name] / (self.A + k) ** 0.602
                ck = job["ck"][name]
                self.theta[name] = self.clamp(name, self.theta[name] + ak / ck * result * job["delta"][name])
            self.results[0] += wins
            self.results[1] += losses
            self.results[2] += draws
            self.save()

    def save(self):
        tmp = self.args.state + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"k": self.k, "results": self.results, "theta": self.theta}, f, indent=1)
        os.replace(tmp, self.args.state)

    def play_pair(self, job, workdir):
        a = self.args
        cmd = [a.fastchess]
        for side in ("plus", "minus"):
            cmd += ["-engine", f"cmd={a.engine}", f"name={side}"]
            cmd += [f"option.{n}={v}" for n, v in job[side].items()]
        cmd += ["-each", "proto=uci", f"tc={a.tc}", "option.Hash=16", "option.Threads=1",
                "-openings", f"file={a.book}", "format=epd", "order=random",
                "-srand", str(random.randrange(1, 2**31)),
                "-games", "2", "-rounds", "1", "-repeat", "-concurrency", "1",
                "-draw", "movenumber=40", "movecount=8", "score=10",
                "-resign", "movecount=3", "score=1000", "twosided=true"]
        out = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True).stdout
        m = RESULT_RE.findall(out)
        if not m:
            return None
        games, wins, losses, draws = map(int, m[-1])
        return (wins, losses, draws) if games == 2 else None

    def worker(self, wid):
        workdir = tempfile.mkdtemp(prefix=f"spsa{wid}_")
        failures = 0
        while True:
            job = self.next_job()
            if job is None:
                return
            r = self.play_pair(job, workdir)
            if r is None:
                failures += 1
                print(f"worker {wid}: pair {job['k']} failed", flush=True)
                if failures > 20:
                    return
                continue
            self.update(job, *r)

    def report(self):
        with self.lock:
            w, l, d = self.results
            lines = [f"[{time.strftime('%H:%M:%S')}] pair {self.k}/{self.args.pairs}  "
                     f"plus-side W/L/D {w}/{l}/{d}"]
            for name, p in self.params.items():
                v = self.theta[name]
                lines.append(f"    {name:16s} {v:9.2f}   (start {p['default']}, rounded {round(v)})")
        print("\n".join(lines), flush=True)

    def run(self):
        threads = [threading.Thread(target=self.worker, args=(i,), daemon=True) for i in range(self.args.workers)]
        for t in threads:
            t.start()
        last = time.time()
        while any(t.is_alive() for t in threads):
            time.sleep(5)
            if time.time() - last >= self.args.report_seconds:
                self.report()
                last = time.time()
        self.report()
        print("final values:")
        for name in self.params:
            print(f"    X({name}, {round(self.theta[name])}, ...)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--engine", default=os.path.join(ROOT, "bin", "darkhelmet-spsa"))
    p.add_argument("--fastchess", default=os.path.join(ROOT, "..", "fastchess", "fastchess"))
    p.add_argument("--book", default=os.path.join(ROOT, "tools", "books", "random8.epd"))
    p.add_argument("--tc", default="5+0.05")
    p.add_argument("--pairs", type=int, default=16000, help="total game pairs (sets the gain schedule)")
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--r-end", type=float, default=0.002)
    p.add_argument("--state", default=os.path.join(ROOT, "data", "spsa", "state.json"))
    p.add_argument("--report-seconds", type=int, default=600)
    args = p.parse_args()
    os.makedirs(os.path.dirname(args.state), exist_ok=True)
    args.engine = os.path.abspath(args.engine)
    args.book = os.path.abspath(args.book)
    Spsa(args).run()


if __name__ == "__main__":
    main()
