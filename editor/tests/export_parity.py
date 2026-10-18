"""Dump every edge case + every shipped example with the SERVER's result, so the browser backend
(Pyodide + wasm clang) can be compared against it:  python editor/tests/export_parity.py
Writes editor/static/_qa/cases.json (git-ignored)."""
import glob
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
import server  # noqa: E402
from test_edge_cases import CASES  # noqa: E402

server.OUT = tempfile.mkdtemp(prefix="sc_parity_")
cases = [(n, p, w) for n, p, w in CASES]
for f in sorted(glob.glob(os.path.join(HERE, "..", "static", "examples", "*.json"))):
    with open(f, encoding="utf-8") as fh:
        cases.append(("example " + os.path.basename(f)[:-5], json.load(fh), "build"))
rows = []
for name, p, want in cases:
    row = {"name": name, "want": want, "project": p}
    try:
        pkg, out, files, warn = server.do_generate(json.loads(json.dumps(p)))
        row.update(files=files, warnings=warn)
        ok, log = server.do_build(out)
        row.update(build_ok=ok, build_log=log)
    except Exception as ex:
        row.update(error=f"{type(ex).__name__}: {ex}")
    rows.append(row)
out = os.path.join(HERE, "..", "static", "_qa", "cases.json")
with open(out, "w", encoding="utf-8") as fh:
    json.dump(rows, fh, ensure_ascii=False)
print(len(rows), "cases ->", os.path.abspath(out))
