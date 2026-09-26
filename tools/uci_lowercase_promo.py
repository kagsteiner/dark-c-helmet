#!/usr/bin/env python3
"""Run a UCI engine and lowercase promotion letters in its move output.

Some engines (e.g. HIARCS 15) print promotions as "e7e8Q"; the UCI standard and match
runners expect "e7e8q". Usage: uci_lowercase_promo.py <engine> [args...]
"""
import re
import subprocess
import sys
import threading

MOVE = re.compile(r"\b([a-h][1-8][a-h][1-8])([QRBN])\b")

proc = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        text=True, bufsize=1)


def pump_input():
    for line in sys.stdin:
        proc.stdin.write(line)
        proc.stdin.flush()
    proc.stdin.close()


threading.Thread(target=pump_input, daemon=True).start()
for line in proc.stdout:
    if line.startswith(("bestmove", "info")):
        line = MOVE.sub(lambda m: m.group(1) + m.group(2).lower(), line)
    sys.stdout.write(line)
    sys.stdout.flush()
sys.exit(proc.wait())
