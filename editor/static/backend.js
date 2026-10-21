/* Browser-only backend (GitHub Pages): Pyodide runs the same Python code generator the server uses, and a
   wasm clang does the Build. Used by editor.js api() when there is no /api server. */
"use strict";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PY_FILES = ["sc_ir.py", "chart_gen.py", "task_c.py", "model.py", "sim_c.py", "scenario.py", "sim_web.py"];
const GLUE = `
import json, os, shutil, io, zipfile
from model import load_editor
from task_c import TARGET_MAIN, generate
from sim_web import sim_call

def _gen(pj):
    project = json.loads(pj)
    pkg = load_editor(project)
    out = "/tmp/out/" + pkg.name
    shutil.rmtree(out, ignore_errors=True)
    files, warnings = generate(pkg, out)
    if isinstance(project.get("mainC"), str) and project["mainC"].strip():
        files[TARGET_MAIN] = project["mainC"]
    return pkg.name, files, warnings

def gen_json(pj):
    name, files, warnings = _gen(pj)
    return json.dumps({"pkg": name, "files": files, "warnings": warnings})

def gen_zip(pj):
    name, files, warnings = _gen(pj)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(files):
            z.writestr(name + "/" + f, files[f])
    return buf.getvalue()
`;
let pyReady = null, ccWorker = null;

function loadPy() {
  if (pyReady) return pyReady;
  pyReady = (async () => {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PYODIDE + "pyodide.js"; s.onload = res; s.onerror = () => rej(new Error("could not load Pyodide"));
      document.head.appendChild(s);
    });
    const py = await loadPyodide({ indexURL: PYODIDE });
    for (const f of PY_FILES) py.FS.writeFile("/home/pyodide/" + f, await (await fetch("py/" + f)).text());
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')\n" + GLUE);
    return py;
  })();
  pyReady.catch(() => { pyReady = null; });
  return pyReady;
}
function compileCheck(files) {
  if (!ccWorker) ccWorker = new Worker("vendor/clang/cc_worker.js");
  return new Promise((res, rej) => {
    ccWorker.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data));
    ccWorker.onerror = (e) => rej(new Error(e.message || "compiler worker failed"));
    ccWorker.postMessage({ files });
  });
}
/* Host side of sim_web.py: the worker (vendor/clang/sim_worker.js) builds the harness to wasm and runs it. A run
   that does not answer within RUN_MS (an endless loop in the user's code) kills the worker; the wasm bytes stay
   here and are loaded into the next worker. */
const RUN_MS = 10000;
let simWorker = null, simSeq = 0, simMid = 0;
const simPend = new Map(), simWasm = new Map(), simLoaded = new Set();
function simWk() {
  if (simWorker) return simWorker;
  const w = new Worker("vendor/clang/sim_worker.js");
  const dead = (msg) => {
    if (simWorker === w) { simWorker = null; simLoaded.clear(); }
    for (const [id, p] of simPend) { clearTimeout(p.timer); p.rej(new Error(msg)); simPend.delete(id); }
  };
  w.onmessage = (e) => {
    const p = simPend.get(e.data.id);
    if (!p) return;
    simPend.delete(e.data.id); clearTimeout(p.timer);
    if (e.data.fatal) p.rej(new Error(e.data.fatal)); else p.res(e.data);
  };
  w.onerror = (e) => dead(e.message || "simulation worker failed");
  simWorker = w;
  return w;
}
function simAsk(msg, ms, transfer) {
  const w = simWk(), id = ++simSeq;
  return new Promise((res, rej) => {
    const timer = ms ? setTimeout(() => {
      simPend.delete(id);
      if (simWorker === w) { simWorker = null; simLoaded.clear(); }
      w.terminate();
      rej(new Error("TIMEOUT"));
    }, ms) : 0;
    simPend.set(id, { res, rej, timer });
    w.postMessage({ ...msg, id }, transfer || []);
  });
}
const simHost = {
  async build(filesJson) {
    const mid = ++simMid;
    const r = await simAsk({ op: "build", mid, files: JSON.parse(filesJson) }, 0);
    if (r.ok) { simWasm.set(mid, r.wasm); simLoaded.add(mid); }
    return JSON.stringify({ ok: r.ok, log: r.log, mid });
  },
  async run(mid, stdin) {
    if (!simLoaded.has(mid)) {
      await simAsk({ op: "load", mid, wasm: simWasm.get(mid).slice() }, 0);
      simLoaded.add(mid);
    }
    const r = await simAsk({ op: "run", mid, stdin }, RUN_MS);
    if (r.err) throw new Error("CRASH " + r.err);
    return r.out;
  },
  drop(mid) { simWasm.delete(mid); simLoaded.delete(mid); },
};
window.simHost = simHost;

/* a Python error arrives as a whole traceback; the server reports only its last line ("ValueError: ...") */
function lastLine(e) {
  const lines = String(e && e.message || e).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return new Error(lines[lines.length - 1] || "error");
}
const Backend = {
  async generate(project) {
    const py = await loadPy();
    try { return JSON.parse(py.globals.get("gen_json")(JSON.stringify(project))); }
    catch (e) { throw lastLine(e); }
  },
  async build(project) {
    const g = await this.generate(project);
    const r = await compileCheck(g.files);
    return { ok: r.ok, log: r.log, pkg: g.pkg, files: g.files, warnings: g.warnings };
  },
  async zip(project) {
    const py = await loadPy();
    let bytes;
    try { bytes = py.globals.get("gen_zip")(JSON.stringify(project)).toJs(); } catch (e) { throw lastLine(e); }
    return new Blob([bytes], { type: "application/zip" });
  },
  async simCall(path, body) {  // the /api/sim/* endpoints of the server, run in the browser
    const py = await loadPy();
    const j = JSON.parse(await py.globals.get("sim_call")(path, JSON.stringify(body)));
    if (j.error) { const e = new Error(j.error); e.log = j.log; throw e; }
    return j;
  },
  async available() {          // true when the Python server answers
    try { return (await fetch("/api/projects")).ok; } catch (e) { return false; }
  },
};
