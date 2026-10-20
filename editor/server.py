"""Statechart editor server.

    python editor/server.py [--port 8770]

Serves the web editor (static/) and a small JSON API:

  POST /api/generate   {project}         -> {pkg, files: {name: text}, warnings}
  GET  /api/zip?pkg=X                    -> zip of the last generated sources
  POST /api/build      {project}         -> generate + compile every .c (MSVC /W4) -> {ok, log, ...}
  POST /api/sim/start  {project}         -> generated modules + test harness built and run -> {sid, meta, snaps, logs}
  POST /api/sim/step   {sid, n, inputs}  -> n task calls with these inputs -> {snaps, logs}
  POST /api/sim/scenario {sid, steps}    -> reset, play the step table, check it -> {start, results, ok}
  POST /api/sim/reset  {sid}  /  POST /api/sim/stop {sid}
  GET  /api/projects                     -> saved project names
  GET  /api/project?name=X               -> project JSON
  POST /api/project    {name, project}   -> save

Generated code goes to editor/out/<package>/, projects to editor/projects/.
"""
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "codegen"))

from model import load_editor  # noqa: E402
from task_c import TARGET_MAIN, TaskGen, generate  # noqa: E402
from sim_c import DONE, SNAP, sim_main  # noqa: E402
import sim  # noqa: E402

STATIC = os.path.join(HERE, "static")
OUT = os.path.join(HERE, "out")
PROJECTS = os.path.join(HERE, "projects")
VCVARS = r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
SAFE = re.compile(r"^[A-Za-z0-9_\-]+$")
MANIFEST = ".files.json"      # what the user gets for this package (also the ZIP content)


def find_vcvars():
    if os.path.exists(VCVARS):
        return VCVARS
    root = r"C:\Program Files\Microsoft Visual Studio"
    for dirpath, _, files in os.walk(root) if os.path.isdir(root) else []:
        if "vcvars64.bat" in files:
            return os.path.join(dirpath, "vcvars64.bat")
    return None


def write(out, fn, text):
    with open(os.path.join(out, fn), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def do_generate(project):
    """Task-style code to out/<pkg>/: the chart's X.c / X.h and the example main.c (or the user's
    own). Returns (pkg, out dir, {file: text}, warnings)."""
    pkg = load_editor(project)
    out = os.path.join(OUT, pkg.name)
    if os.path.isdir(out):
        shutil.rmtree(out, ignore_errors=True)
    files, warnings = generate(pkg, out)
    if isinstance(project.get("mainC"), str) and project["mainC"].strip():      # the user's own main.c
        files[TARGET_MAIN] = project["mainC"]
        write(out, TARGET_MAIN, project["mainC"])
    with open(os.path.join(out, MANIFEST), "w", encoding="utf-8") as f:
        json.dump(sorted(files), f)
    return pkg, out, files, warnings


def do_build(out):
    """Compile every generated .c (modules, main.c), objects only: MSVC /W4 (its C compiler takes
    C89 plus extensions, so tests/test_codegen.py also lints the C89 rules), or gcc -std=c89 -pedantic.
    Returns (ok, log) - log holds the error / warning lines (empty when clean)."""
    out = os.path.abspath(out)
    srcs = sorted(f for f in os.listdir(out) if f.endswith(".c"))
    vc = find_vcvars()
    if vc:
        bat = os.path.join(out, "build_msvc.bat")
        with open(bat, "w", encoding="mbcs") as f:
            f.write("@echo off\r\nset VSLANG=1033\r\n"
                    f'call "{vc}" >nul\r\n'
                    'cd /d "%~dp0"\r\n'            # cmd AutoRun scripts may change the directory
                    "if not exist obj mkdir obj\r\n"
                    "cl /nologo /c /W4 /utf-8 /wd4819 /I . " + " ".join(srcs) + " /Foobj\\\r\n")
        r = subprocess.run(["cmd", "/d", "/c", bat], cwd=out, capture_output=True, text=True,
                           encoding="mbcs", errors="replace", timeout=180)
    elif shutil.which("gcc"):
        r = subprocess.run(["gcc", "-std=c89", "-pedantic", "-Wall", "-Wextra", "-Wdeclaration-after-statement", "-c", "-I.", *srcs], cwd=out,
                           capture_output=True, text=True, timeout=180)
    else:
        return False, "No C compiler found (MSVC Build Tools or gcc)."
    log = "\n".join(ln for ln in (r.stdout + r.stderr).splitlines()
                    if re.search(r"\b(error|warning|fatal)\b|: note:", ln, re.I))
    return r.returncode == 0, log


def sim_start(project):
    pkg, out, files, warnings = do_generate(project)
    text, meta = sim_main(pkg, [TaskGen(pkg, c) for c in pkg.classes])
    r = sim.start(out, files, text, meta, find_vcvars(), TARGET_MAIN, DONE, SNAP)
    r["warnings"] = warnings
    return r


class Handler(SimpleHTTPRequestHandler):
    wbufsize = 65536            # headers + body leave in one segment (separate writes cost ~200 ms on Windows: Nagle + delayed ACK)

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (str(args[0]) if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/projects":
            os.makedirs(PROJECTS, exist_ok=True)
            return self.send_json(sorted(f[:-5] for f in os.listdir(PROJECTS) if f.endswith(".json")))
        if u.path == "/api/project":
            name = (q.get("name") or [""])[0]
            path = os.path.join(PROJECTS, name + ".json")
            if not SAFE.match(name) or not os.path.exists(path):
                return self.send_json({"error": "not found"}, 404)
            with open(path, encoding="utf-8") as f:
                return self.send_json(json.load(f))
        if u.path == "/api/zip":
            name = (q.get("pkg") or [""])[0]
            out = os.path.join(OUT, name)
            if not SAFE.match(name) or not os.path.isdir(out):
                return self.send_json({"error": "generate first"}, 404)
            try:
                with open(os.path.join(out, MANIFEST), encoding="utf-8") as f:
                    wanted = set(json.load(f))
            except OSError:
                wanted = {f for f in os.listdir(out) if f.endswith((".c", ".h"))}
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(os.listdir(out)):
                    if f in wanted:
                        z.write(os.path.join(out, f), f"{name}/{f}")
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{name}_c.zip"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/generate":
                pkg, out, files, warnings = do_generate(self.body())
                return self.send_json({"pkg": pkg.name, "files": files, "warnings": warnings})
            if u.path == "/api/build":
                pkg, out, files, warnings = do_generate(self.body())
                ok, log = do_build(out)
                return self.send_json({"ok": ok, "log": log, "pkg": pkg.name, "files": files, "warnings": warnings})
            if u.path == "/api/sim/start":
                return self.send_json(sim_start(self.body()))
            if u.path == "/api/sim/step":
                b = self.body()
                return self.send_json(sim.step(b.get("sid"), b.get("n", 1), b.get("inputs")))
            if u.path == "/api/sim/scenario":
                b = self.body()
                return self.send_json(sim.run_scenario(b.get("sid"), b.get("steps")))
            if u.path == "/api/sim/reset":
                return self.send_json(sim.reset(self.body().get("sid")))
            if u.path == "/api/sim/stop":
                return self.send_json(sim.stop(self.body().get("sid")))
            if u.path == "/api/project":
                b = self.body()
                name = str(b.get("name", ""))
                if not SAFE.match(name):
                    return self.send_json({"error": "name: letters, digits, _ and - only"}, 400)
                os.makedirs(PROJECTS, exist_ok=True)
                with open(os.path.join(PROJECTS, name + ".json"), "w", encoding="utf-8") as f:
                    json.dump(b.get("project"), f, indent=1, ensure_ascii=False)
                return self.send_json({"ok": True})
        except Exception as ex:  # report model errors to the UI
            import traceback
            traceback.print_exc()
            return self.send_json({"error": f"{type(ex).__name__}: {ex}"}, 500)
        return self.send_json({"error": "unknown endpoint"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    a = ap.parse_args()
    sim.cleanup()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"statechart editor: http://127.0.0.1:{a.port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
