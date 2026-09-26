#!/usr/bin/env python3
"""Replace the `EvalParams P = {...};` initializer in src/eval.c with tuner output.

Usage: python3 tools/tune/apply_params.py tuned.txt

Once tuned material/PSQT values are in place, the PeSTO start-up tables are no longer
used, so they are removed and loading from them is disabled.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
eval_c = ROOT / "src" / "eval.c"

tuned = Path(sys.argv[1]).read_text()
block = re.search(r"EvalParams P = \{.*?\n\};\n", tuned, re.S)
if not block:
    sys.exit("no 'EvalParams P = {...};' block found in tuner output")

src = eval_c.read_text()
src, n = re.subn(r"EvalParams P = \{.*?\n\};\n", lambda _: block.group(0), src, count=1, flags=re.S)
if n != 1:
    sys.exit("could not find P initializer in src/eval.c")

# Drop the PeSTO start-up tables once tuned values exist.
start = src.find("// PeSTO tables")
end = src.find("#define ALL_PIECES")
if start != -1 and end != -1:
    src = src[:start] + src[end:]
src = src.replace("static int params_from_pesto = 1;", "static int params_from_pesto = 0;")
src = re.sub(r"    if \(params_from_pesto\) \{.*?\n    \}\n", "", src, count=1, flags=re.S)
src = src.replace("static int params_from_pesto = 0;\n\n", "")
eval_c.write_text(src)
print(f"updated {eval_c}")
