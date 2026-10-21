/* Statechart Studio - simulation engine of the Scenario tab (there is no manual simulation screen).
   The server builds the GENERATED C (X.c / X.h) together with a separate test harness and keeps it running;
   scenario.js plays step tables against it. This file holds that session and lights up the active
   states of the shown moment on the drawing. Nothing is computed here. */
"use strict";

const sim = {
  sid: null, meta: null, sig: null,         // session id, what the harness reports about the classes, drawing it was built from
  t: 0,                                     // task calls so far (of the shown moment)
  snap: null,                               // shown moment {c: [{s: [state idx], o: [..], v: [..]}]}
  busy: false,
  err: null,                                // {msg, log} when the harness could not be built / crashed
};

// ------------------------------------------------------------------ what the drawing shows
let simActiveCache = { key: null, set: null };
/* node ids of the active states of the class on screen, or null when nothing is shown */
function simActiveSet() {
  if (!sim.sid || !sim.snap || !sim.meta || !project) return null;
  const c = project.classes[cur];
  const ci = c ? sim.meta.classes.findIndex((m) => m.name === c.name) : -1;
  if (ci < 0) return null;
  const key = sim.t + ":" + ci + ":" + sim.sid + ":" + (sim.snap.c[ci] || {}).s;
  if (simActiveCache.key === key) return simActiveCache.set;
  const idx = new Set((sim.snap.c[ci] || {}).s || []);
  const set = new Set(sim.meta.classes[ci].states.filter((s) => idx.has(s.idx)).map((s) => s.node));
  simActiveCache = { key, set };
  return set;
}
function simOnEdit() { /* the next scenario run rebuilds the harness when the drawing changed (scenario.js) */ }

// ------------------------------------------------------------------ server calls
async function simCall(path, body) {
  if (serverMode === null) serverMode = await Backend.available();
  if (!serverMode) return Backend.simCall(path, body);        // GitHub Pages: wasm clang + lld in a worker
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.error) { const e = new Error(j.error || r.statusText); e.log = j.log; throw e; }
  return j;
}

/* build + start the harness for the drawing as it is now; false (and sim.err) when that failed */
async function simStart(opts) {
  const quiet = !!(opts && opts.quiet);         // the drawing was already built (and its defects accepted): no dialogs
  if (!quiet) {
    autoDeclareEvents();
    if (validate()) { showTab("problems"); flash(_t("Fix the errors in the Problems tab first")); return false; }
    if (!confirmDefects(_t("Run the scenario"))) return false;
  }
  const old = sim.sid;
  try {
    if (old) { sim.sid = null; await simCall("/api/sim/stop", { sid: old }).catch(() => {}); }
    const sig = projSig();
    const r = await simCall("/api/sim/start", project);
    sim.sid = r.sid; sim.meta = r.meta; sim.sig = sig; sim.err = null;
    sim.t = 0; sim.snap = r.snaps[r.snaps.length - 1];
  } catch (e) {
    sim.sid = null; sim.snap = null;
    sim.err = { msg: e.message, log: e.log || "" };
  }
  render();
  return !!sim.sid;
}

function simFail(e) {                        // the harness crashed or hung: the session is gone
  sim.sid = null; sim.snap = null;
  sim.err = { msg: e.message, log: e.log || "" };
  render();
}

window.addEventListener("pagehide", () => {
  if (sim.sid) { try { navigator.sendBeacon("/api/sim/stop", new Blob([JSON.stringify({ sid: sim.sid })], { type: "application/json" })); } catch (e) { /* ignore */ } }
});
