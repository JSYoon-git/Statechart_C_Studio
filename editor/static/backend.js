/* Browser-only backend (GitHub Pages): Pyodide runs the same Python code generator the server uses, and a
   wasm clang does the Build. Used by editor.js api() when there is no /api server. */
"use strict";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PY_FILES = ["sc_ir.py", "rhp_c.py", "task_c.py", "model.py"];
const GLUE = `
import json, os, shutil, io, zipfile
from model import load_editor
from task_c import TARGET_MAIN, generate

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
  async available() {          // true when the Python server answers
    try { return (await fetch("/api/projects")).ok; } catch (e) { return false; }
  },
};
