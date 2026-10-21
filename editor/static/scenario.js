/* Statechart Studio - scenarios: the unit test as a step table. Every row is one step:
   X_Init (optional), then "Set inputs", then "Calls" 10 ms task calls, then "Expect" (outputs) must hold.
   The table is stored in the project (project.scenarios); the server plays it against the real generated C
   (/api/sim/scenario, scenario.py) and answers PASS / FAIL per row with a snapshot, so a row shows that moment
   on the drawing. The cells are chips (scchips.js). */
"use strict";

let scSel = 0;                                   // selected scenario
let scRow = null;                                // selected step row (after a run)
const scResults = {};                            // scenario index -> {res, sig}
let scProject = null;                            // the project object the results belong to
let scBusy = false;
let scPrep = null;                               // promise: the test build is being prepared in the background
let scStatus = "";                               // short status text in the toolbar ("Preparing the test build…")
let scRenaming = false;                          // the scenario name is being edited
let scPos = null, scPosSel = -1;                 // Run: rows shown so far / the scenario they belong to
const SC_MAX_CALLS = 100000;

// ------------------------------------------------------------------ small helpers
function scList() { return (project && project.scenarios) || []; }
function scCur() { return scList()[scSel]; }
function scEdit() { if (!project.scenarios) project.scenarios = []; return project.scenarios; }
function scCount(res, sc) {
  const pass = res ? res.results.filter((x) => x.ok).length : 0;
  return { pass, total: sc.steps.length, ok: !!res && res.ok };
}
function scMark(i) {
  const sc = scList()[i], r = scResults[i];
  if (!r) return "○";
  return r.res.ok && r.res.results.length === sc.steps.length ? "✓" : "✗";
}
function scTime(n) {                              // 49 calls of 10 ms
  const ms = (parseInt(n, 10) || 0) * 10;
  return ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(2)} s`;
}
const scSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function scStepping() { return scPos !== null && scPosSel === scSel && !!scResults[scSel]; }
function scRevealCount() { const c = scCur(); return scStepping() && c && scPos < c.steps.length ? scPos : null; }       // rows that show a result (null = all)
function scTouched() { delete scResults[scSel]; scPos = null; }          // the table changed: the old PASS / FAIL no longer belongs to it

/* the tab itself tells the state: 🔒 locked until Build succeeded, ✓ / ✗ n after a full run */
function scUpdateTab() {
  const b = $("scTabBtn");
  const list = scList();
  let badge = "";
  if (list.length && list.every((_, i) => scResults[i])) {
    const bad = list.filter((_, i) => scMark(i) !== "✓").length;
    badge = bad ? ` ✗ ${bad}` : " ✓";
  }
  b.textContent = (scenarioReady() ? "" : "🔒 ") + "Scenario" + badge;
  b.classList.toggle("hint", scenarioReady() && !list.length);             // a dot: unlocked, nothing written yet
}
let scReadyLast = null;
function scOnReady(ready) {                       // called by paintButtons(): redraw only when the lock changes
  if (ready === scReadyLast) return;
  scReadyLast = ready;
  scUpdateTab();
  if (!$("tab-scenario").classList.contains("on")) return;
  if (!ready && !scList().length) { showTab("code"); return; }       // a new, empty project: nothing to show behind the lock
  scBuild();
  if (ready) scPrepare();
}

// ------------------------------------------------------------------ the test build
/* the harness is built in the background as soon as the tab is open, so the first Run answers at once */
function scPrepare() {
  if (scPrep || !scenarioReady() || (sim.sid && sim.sig === projSig())) return scPrep;
  scStatus = _t("Preparing the test build…");
  scPrep = simStart({ quiet: true }).then(() => {}, () => {}).then(() => { scPrep = null; scStatus = ""; if ($("tab-scenario").classList.contains("on")) scBuild(); });
  scBuild();
  return scPrep;
}
async function scRunOne(i) {
  const sc = scList()[i];
  if (!sc || !sc.steps.length || !scenarioReady()) return null;
  if (scPrep) await scPrep;
  if (!sim.sid || projSig() !== sim.sig) {
    scStatus = _t("Preparing the test build…"); scBuild();
    const ok = await simStart({ quiet: true });
    scStatus = "";
    if (!ok) return null;
  }
  let res;
  sim.busy = true;
  try {
    res = await simCall("/api/sim/scenario", { sid: sim.sid, steps: sc.steps });
  } catch (e) {
    sim.busy = false;
    simFail(e);
    return null;
  }
  sim.busy = false;
  scResults[i] = { res, sig: projSig() };
  const last = res.results.filter((r) => r.snap).pop();       // the drawing shows where the scenario ended
  sim.snap = last ? last.snap : res.start;
  sim.t = last ? last.t : 0;
  render();
  return res;
}

/* Run: the selected scenario one step (row) at a time, YOU decide when: every press executes the next row, marks
   it, shows its PASS / FAIL and the states of that moment on the drawing. Row 1 first (X_Init, then the row); after
   the last row the next press starts over. (The server plays the whole table once, the editor shows it row by row.) */
function scClearCard() { if (sel) { sel = null; refreshProps(); render(); } }       // the card would hide the states that light up
async function scRun() {
  if (scBusy) return;
  const sc = scCur();
  if (!sc || !sc.steps.length) return;
  scClearCard();
  scBusy = true;
  try {
    if (!scStepping() || scPos >= sc.steps.length) {                    // start (or start over)
      delete scResults[scSel]; scPos = null; scRow = null; scBuild();
      const res = await scRunOne(scSel);
      if (!res) return;
      scPos = 0; scPosSel = scSel;
    }
    const res = scResults[scSel].res, k = scPos, x = res.results[k];
    if (!x) { scPos = null; return; }                                   // the run ended early (a row that could not run)
    scPos = k + 1; scRow = k;
    if (x.snap) { sim.snap = x.snap; sim.t = x.t; render(); }
  } finally { scBusy = false; scBuild(); }
  const tr = $("tab-scenario").querySelector(`tr[data-step="${scRow}"]`);
  if (tr) tr.scrollIntoView({ block: "nearest" });
}
function scRestart() { scPos = null; scRow = null; render(); scBuild(); }

/* Run all: every scenario at once, one after the other (each starts with X_Init, so they do not affect each other);
   the table on screen follows the scenario that is playing and ends on the first one that failed */
async function scRunAll() {
  if (scBusy) return;
  scClearCard();
  scBusy = true; scRow = null; scPos = null;
  const n = scList().length;
  let firstBad = -1;
  try {
    for (let i = 0; i < n; i++) {
      scSel = i; scBuild();
      if (!(await scRunOne(i))) break;
      if (scMark(i) !== "✓" && firstBad < 0) firstBad = i;
      scBuild();
      if (i < n - 1) await scSleep(350);                               // long enough to see each result
    }
    if (firstBad >= 0) scSel = firstBad;
  } finally { scBusy = false; scBuild(); }
}

function scShowStep(i) {                          // click on a row: that moment on the drawing
  if (scBusy) return;
  const r = scResults[scSel], rv = scRevealCount();
  const x = r && (rv === null || i < rv) ? r.res.results[i] : null;       // not a row that has not run yet
  if (!x) return;
  scRow = i;
  if (x.snap && sim.sid) { sim.snap = x.snap; sim.t = x.t; render(); }
  scBuild();
}

// ------------------------------------------------------------------ edit
function scNew(steps) { return { name: _t("Scenario {0}", scList().length + 1), steps }; }
function scAddScenario() {
  snapshot();
  scEdit().push(scNew([{ n: 1, set: "", expect: "" }]));
  scSel = scList().length - 1; scRow = null; scPos = null;
  save(); scBuild();
}
function scDupScenario() {
  const c = scCur();
  if (!c) return;
  snapshot();
  const copy = JSON.parse(JSON.stringify(c));
  copy.name = _t("{0} (copy)", c.name);
  scEdit().splice(scSel + 1, 0, copy);
  scSel += 1; scRow = null; scPos = null;
  for (const k of Object.keys(scResults).map(Number).filter((k) => k >= scSel)) delete scResults[k];       // indexes moved
  save(); scBuild();
}
function scDelScenario() {
  if (!scCur() || !confirm(_t("Delete the scenario '{0}'?", scCur().name))) return;
  snapshot();
  scEdit().splice(scSel, 1);
  for (const k of Object.keys(scResults).map(Number).filter((k) => k >= scSel)) delete scResults[k];
  scSel = Math.max(0, Math.min(scSel, scList().length - 1)); scRow = null; scPos = null;
  save(); scBuild();
}
let scLastSnap = 0;
/* chip cells: one undo snapshot per burst of edits, then the step is already changed by fn */
function scCommit(fn) {
  const now = Date.now();
  if (now - scLastSnap > 1200) snapshot();
  scLastSnap = now;
  fn();
  scTouched();
  save();
  scPaintResults();
}

// ------------------------------------------------------------------ panel
function scPaintResults() {                       // result cells only (keeps the cursor in the fields)
  const root = $("tab-scenario");
  const sc = scCur(), r = scResults[scSel], res = r && r.res;
  const stale = r && r.sig !== projSig();
  const rv = scRevealCount();
  root.querySelectorAll("tr[data-step]").forEach((tr) => {
    const i = +tr.dataset.step, x = res && (rv === null || i < rv) ? res.results[i] : null;
    const noCheck = !!x && !String(((sc && sc.steps[i]) || {}).expect || "").trim();        // nothing to check in this row
    tr.classList.toggle("pass", !!x && x.ok && !noCheck);
    tr.classList.toggle("fail", !!x && !x.ok);
    tr.classList.toggle("stale", !!stale);
    tr.classList.toggle("sel", scRow === i);
    tr.classList.toggle("next", rv !== null && i === rv);
    tr.classList.toggle("shown", !!x);
    const cell = tr.querySelector(".scres");
    cell.textContent = x ? (noCheck && x.ok ? "–" : x.ok ? "✓ PASS" : "✗ FAIL") : (res && rv === null && i >= res.results.length ? "–" : "");
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("scmsg")) next.remove();
    if (x && !x.ok) {
      tr.after(h("tr", { class: "scmsg" }, h("td", { colspan: "7" }, ...x.msgs.map((t) => h("div", {}, "↳ " + t)))));
    }
  });
  const sum = root.querySelector(".scsum");
  if (sum && sc) {
    const c = scCount(res, sc);
    sum.textContent = res && rv === null ? `${c.pass} / ${c.total} ${_t("steps pass")}` + (stale ? " · " + _t("outdated") : "") : "";
    sum.className = "scsum" + (res && rv === null ? (c.pass === c.total && res.ok ? " ok" : " bad") : "") + (stale ? " stale" : "");
  }
  const sel = root.querySelector("select.scsel");
  if (sel) [...sel.options].forEach((o, i) => { o.textContent = `${scMark(i)}  ${scList()[i].name}`; });
  scUpdateTab();
}

function scBuild() {
  const root = $("tab-scenario");
  if (scProject !== project) {                    // another project, or undo / redo: results belong to the old one
    const keep = scProject !== null && scProject.scenarios && project.scenarios && scProject.package === project.package;
    scProject = project;
    for (const k in scResults) delete scResults[k];
    scRow = null; scPos = null;
    if (!keep) scSel = 0;
  }
  const keepScroll = (root.querySelector(".scwrap") || {}).scrollTop || 0;
  root.textContent = "";
  const list = scList();
  if (scSel >= list.length) scSel = Math.max(0, list.length - 1);
  const btn = (label, title, fn, cls) => { const b = h("button", { class: "mini " + (cls || ""), title }, label); b.addEventListener("click", fn); return b; };
  const sc = scCur();
  const ready = scenarioReady();

  // ---- toolbar: [scenario ▾] [✎ ⧉ ＋ ✕]  ...  status  [▶ Run] [▶▶ Run all]
  const bar = h("div", { class: "simbar scbar" });
  if (scRenaming && sc) {
    const nm = h("input", { type: "text", class: "scname", value: sc.name, spellcheck: "false" });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true; scRenaming = false;
      if (ok && nm.value.trim() && nm.value !== sc.name) { snapshot(); sc.name = nm.value.trim(); save(); }
      scBuild();
    };
    nm.addEventListener("keydown", (ev) => { if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
    nm.addEventListener("blur", () => finish(true));
    bar.append(nm);
    setTimeout(() => { nm.focus(); nm.select(); }, 0);
  } else {
    const sel = h("select", { class: "scsel", title: _t("Scenario") }, ...list.map((s, i) => h("option", { value: i, selected: i === scSel ? "selected" : null }, `${scMark(i)}  ${s.name}`)));
    sel.addEventListener("change", () => { scSel = +sel.value; scRow = null; scBuild(); });
    if (!list.length) sel.disabled = true;
    bar.append(sel);
  }
  bar.append(btn("✎", _t("Rename this scenario"), () => { scRenaming = true; scBuild(); }));
  bar.querySelector("button").disabled = !sc;
  const dup = btn("⧉", _t("Duplicate this scenario"), scDupScenario); dup.disabled = !sc;
  const del = btn("✕", _t("Delete this scenario"), scDelScenario); del.disabled = !sc;
  bar.append(dup, btn("＋ " + _t("New"), _t("Add a scenario"), scAddScenario), del);
  bar.append(h("span", { class: "scsum" }), h("span", { class: "grow" }));
  if (scStatus) bar.append(h("span", { class: "scstatus" }, scStatus));

  const stepping = !!sc && scStepping() && scPos < sc.steps.length;
  const run = btn("▶ " + _t("Run") + (stepping ? `  ${scPos} / ${sc.steps.length}` : ""),
    _t("Run the next step of the selected scenario: the first press runs row 1 (after X_Init), every further press the next row"), () => scRun(), "primary-ish");
  const runAll = btn("▶▶ " + _t("Run all"), _t("Play every scenario at once, one after the other (each starts with X_Init)"), () => scRunAll());
  if (!sc || !sc.steps.length || scBusy || !ready) run.disabled = true;
  if (!list.length || scBusy || !ready) runAll.disabled = true;
  bar.append(run);
  if (stepping) bar.append(btn("⟲", _t("Start this scenario over"), scRestart));
  bar.append(runAll);
  root.append(bar);

  // ---- notices
  if (!ready) {
    const b = h("button", { class: "mini primary-ish" }, "Build");
    b.addEventListener("click", () => build());
    root.append(h("div", { class: "simstale" }, _t("The drawing has no successful Build yet (or it changed since). Scenarios run the generated code: "), b));
  }
  if (sim.err) {
    root.append(h("div", { class: "simmsg err" }, h("b", {}, _t("The scenario could not run")), h("div", {}, sim.err.msg),
      sim.err.log ? h("pre", {}, sim.err.log) : null));
  }
  if (!sc) {
    const first = h("button", { class: "mini primary-ish" }, "＋ " + _t("New"));
    first.addEventListener("click", scAddScenario);
    root.append(h("div", { class: "scempty" },
      h("div", { class: "t" }, _t("No scenario yet")),
      h("div", {}, _t("A scenario is a unit test written as a table: each row sets some inputs, runs some 10 ms task calls and says what the outputs must be.")),
      first));
    scUpdateTab();
    return;
  }

  // ---- the table
  const head = h("tr", {}, h("th", {}, "#"),
    h("th", { title: _t("Call X_Init again before this row: inputs and variables back to their initial values; config values can be set here") }, "Init"),
    h("th", { title: _t("Task calls of 10 ms each (0 = only check)") }, _t("Calls")),
    h("th", { title: _t("Inputs that change before the calls — they keep the value until a later row changes them") }, _t("Set inputs")),
    h("th", { title: _t("Outputs, checked after the calls") }, _t("Expect")),
    h("th", {}, _t("Result")), h("th", {}, ""));
  const body = h("tbody", {});
  const addStep = (at) => {
    snapshot(); sc.steps.splice(at, 0, { n: 1, set: "", expect: "" }); scTouched(); save(); scBuild();
    const tr = $("tab-scenario").querySelector(`tr[data-step="${at}"]`);
    if (tr) tr.scrollIntoView({ block: "nearest" });
  };
  sc.steps.forEach((st, i) => {
    // calls: a number and what it means in time
    const calls = h("input", { type: "number", min: "0", max: String(SC_MAX_CALLS), value: String(st.n == null ? 1 : st.n), class: "scn", title: _t("Task calls of 10 ms each (0 = only check)") });
    const time = h("span", { class: "sctime" }, scTime(st.n == null ? 1 : st.n));
    let snapped = false;
    calls.addEventListener("focus", () => { snapped = false; });
    calls.addEventListener("input", () => {
      if (calls.value === "") { time.textContent = ""; return; }
      let v = Math.max(0, Math.min(SC_MAX_CALLS, parseInt(calls.value, 10) || 0));
      if (String(v) !== calls.value) calls.value = String(v);                    // never negative, never above the limit
      if (!snapped) { snapshot(); snapped = true; }
      st.n = v; time.textContent = scTime(v);
      scTouched(); save(); scPaintResults();
    });
    calls.addEventListener("blur", () => { if (calls.value === "") { calls.value = "1"; st.n = 1; time.textContent = scTime(1); scTouched(); save(); } });
    const set = scChipCell(st, "set", scCommit);
    const exp = scChipCell(st, "expect", scCommit);
    const init = h("input", { type: "checkbox", checked: !!st.init, class: "scinit", title: _t("Call X_Init again before this row") });
    init.addEventListener("change", () => { snapshot(); if (init.checked) st.init = true; else delete st.init; scTouched(); save(); scBuild(); });
    const mv = (d) => () => { snapshot(); const a = sc.steps; [a[i], a[i + d]] = [a[i + d], a[i]]; scTouched(); save(); scBuild(); };
    const dupRow = () => { snapshot(); sc.steps.splice(i + 1, 0, JSON.parse(JSON.stringify(st))); scTouched(); save(); scBuild(); };
    const delRow = () => { snapshot(); sc.steps.splice(i, 1); scTouched(); save(); scBuild(); };
    const tools = h("td", { class: "sctools" },
      btn("↑", _t("Move up"), mv(-1)), btn("↓", _t("Move down"), mv(1)), btn("⧉", _t("Duplicate this step"), dupRow), btn("✕", _t("Delete this step"), delRow));
    if (i === 0) tools.children[0].disabled = true;
    if (i === sc.steps.length - 1) tools.children[1].disabled = true;
    const tr = h("tr", { "data-step": i }, h("td", { class: "scidx" }, String(i + 1)), h("td", { class: "scinitc" }, init),
      h("td", { class: "sccalls" }, calls, time), h("td", {}, set), h("td", {}, exp), h("td", { class: "scres" }), tools);
    tr.addEventListener("click", (ev) => { if (!["INPUT", "BUTTON", "SELECT"].includes(ev.target.tagName)) scShowStep(i); });
    body.append(tr);
  });
  const addRow = h("tr", { class: "scaddrow" }, h("td", { colspan: "7" }, btn("＋ " + _t("Add step"), _t("Add a step at the end"), () => addStep(sc.steps.length))));
  body.append(addRow);
  const wrap = h("div", { class: "scwrap" }, h("table", { class: "sctable" }, h("thead", {}, head), body));
  root.append(wrap);
  wrap.scrollTop = keepScroll;                    // pressing Run must not throw the table back to the top
  scPaintResults();
}

// ------------------------------------------------------------------ wiring
$("scTabBtn").addEventListener("click", () => {
  scBuild(); scPrepare();
  requestAnimationFrame(() => requestAnimationFrame(zoomFit));          // the panel took half the screen: fit the drawing into what is left
});
scUpdateTab();
scBuild();
