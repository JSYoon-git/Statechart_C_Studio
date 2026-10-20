/* Statechart Studio - draw statecharts, generate task-style C. */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const NAME_H = 22;                         // state name compartment
const $ = (id) => document.getElementById(id);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ------------------------------------------------------------------ model
let project = null;
let cur = 0;                               // current class index
let sel = null;                            // {t:'node'|'edge', id}
let tool = "select";
let view = { x: 0, y: 0, k: 1 };
const undoStack = [], redoStack = [];
let lastGen = null;                        // {pkg, files, warnings}
let curFile = null;
let buildErrors = [];                      // compiler errors / warnings of the last Build

/* the drawing without the scenarios (step tables): what Generate / Build / Simulate / Tidy compare against */
function projSig() { return JSON.stringify(project, (k, v) => (k === "scenarios" ? undefined : v)); }
function uid(p) { return p + Math.random().toString(36).slice(2, 9); }
function cls() { return project.classes[cur]; }
function chart() {
  const c = cls();
  if (!c.chart) c.chart = { nodes: {}, edges: {} };
  return c.chart;
}
function nodes() { return chart().nodes; }
/* notes: comments on the drawing for the people who read it. They live beside nodes / edges (chart.notes) and are
   never written into the C code. A note may be attached to a state (dashed line). */
function notes() { return chart().notes || {}; }
function notesW() { const c = chart(); return c.notes || (c.notes = {}); }
const noteKey = (n) => (LANG === "ko" ? "ko" : "text");               // one text per language: text = English, ko = 한국어
const noteText = (n) => n[noteKey(n)] || n[LANG === "ko" ? "text" : "ko"] || "";     // the other language when this one is empty
function wrapNote(text, w) {
  const maxW = Math.max(30, w - 22), lines = [];
  for (const para of String(text).split("\n")) {
    const wid = (ch) => (ch.charCodeAt(0) > 0x2e7f ? 12 : 6.4);
    let cur = "", cw = 0;
    for (const ch of para) {
      if (cw + wid(ch) > maxW && cur) {
        const k = ch !== " " && ch.charCodeAt(0) <= 0x2e7f ? cur.lastIndexOf(" ") : -1;     // Latin: break at the last space
        if (k > 0) { lines.push(cur.slice(0, k)); cur = cur.slice(k + 1); } else { lines.push(cur); cur = ""; }
        cw = [...cur].reduce((a, c) => a + wid(c), 0);
      }
      if (ch === " " && !cur) continue;
      cur += ch; cw += wid(ch);
    }
    lines.push(cur);
  }
  return lines;
}
function edges() { return chart().edges; }

function blankProject() {
  return {
    version: 4, package: "Default", types: ["#include <stdio.h>"], events: [],
    classes: [{ name: "Controller", attributes: [], operations: [], assocs: [], init: "",
                chart: { nodes: {}, edges: {} } }],
  };
}
/* every X_Main is called from the 10 ms task */
const TASK_US = 10000;

function snapshot() {
  editVersion++;
  undoStack.push(JSON.stringify(project));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  save();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(project));
  project = JSON.parse(undoStack.pop());
  cur = Math.min(cur, project.classes.length - 1);
  sel = null; refreshAll(); paintButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(project));
  project = JSON.parse(redoStack.pop());
  sel = null; refreshAll(); paintButtons();
}
function save() {
  try { localStorage.setItem("scstudio.project", JSON.stringify(project)); } catch (e) { /* ignore */ }
  paintButtons();
}
/* Generate C / Build: spinner while running; green while the result still matches the drawing (a snapshot of the
   whole project is compared, so any change at all turns the button blue again); Build: amber = warnings, red = failed */
let genSig = null, buildSig = null, buildState = "", genBusy = false, buildBusy = false;
function paintButtons() {
  const sig = projSig();
  const set = (el, st) => { el.classList.remove("busy", "ok", "warn", "fail"); if (st) el.classList.add(st); };
  set($("bGen"), genBusy ? "busy" : genSig === sig ? "ok" : "");
  set($("bCompile"), buildBusy ? "busy" : buildSig === sig ? buildState : "");
  $("untidy").hidden = !(tidySig && tidySig === sig);          // only while nothing was changed after Tidy
  const ready = scenarioReady();                                // Scenario tab: only for a drawing whose code was generated and built
  const tb = $("scTabBtn");
  tb.disabled = !ready;
  tb.title = ready ? _t("Unit test: a step table (inputs, expected states and values) that runs against the generated code")
                   : _t("Locked: press Build first — the scenarios run the generated code, so it must build without errors");
  if (typeof scOnReady === "function") scOnReady(ready);
}
/* Generate C + Build succeeded for the drawing as it is now (a warning is still a successful build) */
function scenarioReady() { return buildSig !== null && buildSig === projSig() && (buildState === "ok" || buildState === "warn"); }
let tidySig = null;

// ------------------------------------------------------------------ geometry helpers
function isState(n) { return n && n.kind === "state"; }
function children(id) { return Object.values(nodes()).filter((n) => n.parent === id); }
function descendants(id) {
  const out = [];
  const walk = (pid) => { for (const n of children(pid)) { out.push(n); walk(n.id); } };
  walk(id);
  return out;
}
function depth(n) { let d = 0; while (n && n.parent && nodes()[n.parent]) { d++; n = nodes()[n.parent]; } return d; }
function center(n) { return isState(n) ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: n.x, y: n.y }; }
function radius(n) { return { init: 7, cond: 15, junction: 12, hist: 12, term: 12 }[n.kind] || 8; }
function regionCount(n) { return n.and ? Math.max(2, (n.regions || []).length) : 1; }
function regionRect(n, i) {
  const R = regionCount(n), top = n.y + NAME_H, hh = (n.h - NAME_H) / R;
  return { x: n.x, y: top + i * hh, w: n.w, h: hh };
}
function regionAt(n, y) {
  const R = regionCount(n), hh = (n.h - NAME_H) / R;
  return Math.max(0, Math.min(R - 1, Math.floor((y - n.y - NAME_H) / hh)));
}
/* deepest state containing (x,y), skipping `skip` ids */
function containerAt(x, y, skip) {
  let best = null;
  for (const n of Object.values(nodes())) {
    if (!isState(n) || (skip && skip.has(n.id))) continue;
    if (x >= n.x && x <= n.x + n.w && y >= n.y + (n.and ? NAME_H : 0) && y <= n.y + n.h) {
      if (!best || n.w * n.h < best.w * best.h) best = n;
    }
  }
  return best;
}
function setParentAt(n, x, y) {
  const skip = new Set([n.id, ...descendants(n.id).map((d) => d.id)]);
  const p = containerAt(x, y, skip);
  n.parent = p ? p.id : null;
  n.region = p && p.and ? regionAt(p, y) : 0;
}
/* point where the ray center->toward leaves the shape */
function boundary(n, toward) {
  const c = center(n);
  let dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) dy = -1;
  if (isState(n)) {
    const hw = n.w / 2, hh = n.h / 2;
    const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return { x: c.x + dx * s, y: c.y + dy * s };
  }
  const L = Math.hypot(dx, dy), r = radius(n);
  return { x: c.x + dx / L * r, y: c.y + dy / L * r };
}

// ------------------------------------------------------------------ labels
function edgeLabel(e) {
  let s = (e.trigger || "").trim();
  if ((e.guard || "").trim()) s += "[" + e.guard.trim() + "]";
  if ((e.action || "").trim()) s += "/" + e.action.trim().replace(/\s*\n\s*/g, " ");
  return s;
}
/* ---- priority among transitions that leave the same state / connector ----
   X_takeTrigger checks them in this order and takes the first whose Guard (and tm) is true.
   Order = e.prio (1 = first), edges without prio after those in drawing order; transitions with
   no Guard and no tm() (or [else]) always come last - only the first of those can ever fire. */
function isFree(e) { const g = (e.guard || "").trim(); return (!g || g === "else") && !(e.trigger || "").trim(); }
function outgoingOrdered(fromId, E, N) {
  E = E || edges(); N = N || nodes();
  const src = N[fromId];
  if (!src || src.kind === "init") return [];
  const list = Object.values(E).map((e, i) => [e, i]).filter(([e]) => e.from === fromId);
  const key = ([e, i]) => [isFree(e) ? 1 : 0, e.prio != null && e.prio !== "" ? +e.prio : 1e9, i];
  list.sort((x, y) => { const a = key(x), b = key(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
  return list.map(([e]) => e);
}
function prioRank(e) {
  const list = outgoingOrdered(e.from);
  return list.length > 1 ? { k: list.indexOf(e) + 1, n: list.length, list } : null;
}
function badge(k) { return String(k); }
/* move e one step earlier (-1) or later (+1) among the guarded transitions of its source */
function movePrio(e, dir) {
  const guarded = outgoingOrdered(e.from).filter((x) => !isFree(x));
  const i = guarded.indexOf(e), j = i + dir;
  if (i < 0 || j < 0 || j >= guarded.length) return;
  snapshot();
  [guarded[i], guarded[j]] = [guarded[j], guarded[i]];
  guarded.forEach((x, k) => { x.prio = k + 1; });
  refreshAll();
}
function shortText(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function parseArgs(text) {
  return (text || "").split(",").map((a) => a.trim()).filter(Boolean).map((a) => {
    const m = a.match(/^(.*?)([A-Za-z_]\w*)\s*$/);
    return m && m[1].trim() ? { type: m[1].trim(), name: m[2] } : { type: "int", name: a.replace(/\W/g, "") || "arg" };
  });
}
function argsText(args) { return (args || []).map((a) => `${a.type} ${a.name}`).join(", "); }

// ------------------------------------------------------------------ rendering
const world = $("world");
const svg = $("canvas");

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function applyView() { world.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`); }

/* problems found by validate() that point at an element of the class on screen:
   { node: {id: "err"|"warn"}, edge: {...} } - drawn as colored dashed outlines and a ⚠ */
let marks = { node: {}, edge: {} };
function markClass(kind, id) { const m = marks[kind][id]; return m ? " mark-" + m : ""; }
function render() {
  world.textContent = "";
  $("emptyHint").hidden = Object.keys(nodes()).length > 0;
  const ns = Object.values(nodes());
  const states = ns.filter(isState).sort((a, b) => depth(a) - depth(b));
  const live = typeof simActiveSet === "function" ? simActiveSet() : null;       // states of the running simulation (sim.js)
  const gS = el("g", {}, world), gE = el("g", {}, world), gP = el("g", {}, world), gH = el("g", {}, world);
  const gN = el("g", { class: "notes" }, null);
  world.insertBefore(gN, gH);                       // above states and transitions, below the handles
  for (const n of Object.values(notes())) {
    const isSel = sel && sel.t === "note" && sel.id === n.id;
    const lines = wrapNote(noteText(n), n.w);
    const h = Math.max(n.h, lines.length * 15 + 16);          // the text is never cut off
    const a = nodes()[n.attach];
    if (a && isState(a)) {
      const nc = { x: n.x + n.w / 2, y: n.y + h / 2 };
      const p1 = boundary({ kind: "state", x: n.x, y: n.y, w: n.w, h }, center(a)), p2 = boundary(a, nc);
      el("line", { class: "noteline", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, gN);
    }
    const g = el("g", { class: "note" + (isSel ? " sel" : ""), "data-note": n.id }, gN);
    el("path", { class: "body", d: `M${n.x} ${n.y} H${n.x + n.w - 14} L${n.x + n.w} ${n.y + 14} V${n.y + h} H${n.x} Z` }, g);
    el("path", { class: "fold", d: `M${n.x + n.w - 14} ${n.y} V${n.y + 14} H${n.x + n.w}` }, g);
    lines.forEach((s, i) => { const t = el("text", { x: n.x + 9, y: n.y + 17 + i * 15 }, g); t.textContent = s; });
    if (!noteText(n).trim()) { const t = el("text", { class: "ph", x: n.x + 9, y: n.y + 17 }, g); t.textContent = _t("(empty note)"); }
    if (isSel) el("rect", { class: "handle", x: n.x + n.w - 5, y: n.y + h - 5, width: 10, height: 10, "data-handle": "nresize", "data-note": n.id }, gH);
  }

  for (const n of states) {
    const isSel = sel && sel.t === "node" && sel.id === n.id;
    const lv = live && live.has(n.id) ? (children(n.id).length || n.and ? " activeParent" : " active") : "";
    const g = el("g", { class: "state" + lv + (isSel ? " sel" : "") + (dropTarget === n.id ? " drop" : "") + markClass("node", n.id), "data-id": n.id }, gS);
    el("rect", { class: "body", x: n.x, y: n.y, width: n.w, height: n.h, rx: 10, ry: 10 }, g);
    const t = el("text", { class: "name", x: n.x + 9, y: n.y + 15 }, g);
    t.textContent = n.name + (n.and ? "  ⫴" : "");
    const kids = children(n.id);
    if (kids.length || n.and) el("line", { class: "namesep", x1: n.x, y1: n.y + NAME_H, x2: n.x + n.w, y2: n.y + NAME_H }, g);
    // entry/exit/reactions summary for leaf states
    if (!kids.length && !n.and) {
      const lines = [];
      if ((n.entry || "").trim()) lines.push("entry/" + n.entry.trim().replace(/\s*\n\s*/g, " "));
      if ((n.exit || "").trim()) lines.push("exit/" + n.exit.trim().replace(/\s*\n\s*/g, " "));
      for (const r of n.reactions || []) lines.push(edgeLabel(r));
      const maxc = Math.max(8, Math.floor((n.w - 14) / 6.2));
      lines.slice(0, Math.max(0, Math.floor((n.h - NAME_H - 4) / 13))).forEach((s, i) => {
        const a = el("text", { class: "acts", x: n.x + 9, y: n.y + NAME_H + 14 + i * 13 }, g);
        a.textContent = shortText(s, maxc);
      });
    } else if ((n.reactions || []).length || (n.entry || "").trim() || (n.exit || "").trim()) {
      const a = el("text", { class: "acts", x: n.x + n.w - 8, y: n.y + 15, "text-anchor": "end" }, g);
      a.textContent = [(n.entry || "").trim() && "entry", (n.exit || "").trim() && "exit",
        (n.reactions || []).length && `${n.reactions.length} reaction`].filter(Boolean).join(" · ");
    }
    if (n.and) {
      const R = regionCount(n);
      for (let i = 0; i < R; i++) {
        const r = regionRect(n, i);
        if (i > 0) el("line", { class: "andline", x1: n.x, y1: r.y, x2: n.x + n.w, y2: r.y }, g);
        const rt = el("text", { class: "region", x: n.x + n.w - 8, y: r.y + 13, "text-anchor": "end" }, g);
        rt.textContent = ((n.regions || [])[i] || {}).name || `r${i}`;
      }
    }
    if (isSel) {
      el("rect", { class: "handle", x: n.x + n.w - 5, y: n.y + n.h - 5, width: 10, height: 10, "data-handle": "resize", "data-id": n.id }, gH);
    }
    if (hoverId === n.id && !drag) {
      for (const [hx, hy] of [[n.x + n.w + 14, n.y + n.h / 2], [n.x - 14, n.y + n.h / 2], [n.x + n.w / 2, n.y - 14], [n.x + n.w / 2, n.y + n.h + 14]])
        connectHandle(gH, hx, hy, n.id);
    }
  }

  for (const n of ns.filter((x) => !isState(x))) {
    const isSel = sel && ((sel.t === "node" && sel.id === n.id) || (n.kind === "init" && sel.t === "edge" && (edges()[sel.id] || {}).from === n.id));
    const g = el("g", { class: "pseudo k-" + n.kind + (isSel ? " sel" : "") + markClass("node", n.id), "data-id": n.id }, gP);
    const r = radius(n);
    // five different shapes and colors, so none is mistaken for another:
    //   default start = solid dark dot,  C = yellow diamond,  J = teal circle,  H = blue circle,  end = red circle with a cross
    const label = (txt) => { const tx = el("text", { x: n.x, y: n.y + 4, "text-anchor": "middle" }, g); tx.textContent = txt; };
    if (n.kind === "init") el("circle", { class: "fill", cx: n.x, cy: n.y, r }, g);
    else if (n.kind === "cond") {
      el("path", { class: "shape", d: `M${n.x} ${n.y - r} L${n.x + r} ${n.y} L${n.x} ${n.y + r} L${n.x - r} ${n.y} Z` }, g);
      label("C");
    } else if (n.kind === "junction") {
      el("circle", { class: "shape", cx: n.x, cy: n.y, r }, g);
      label("J");
    } else if (n.kind === "hist") {
      el("circle", { class: "shape", cx: n.x, cy: n.y, r }, g);
      label("H");
    } else if (n.kind === "term") {
      el("circle", { class: "shape", cx: n.x, cy: n.y, r }, g);
      const d = r * 0.55;
      el("path", { class: "shape x", d: `M${n.x - d} ${n.y - d} L${n.x + d} ${n.y + d} M${n.x + d} ${n.y - d} L${n.x - d} ${n.y + d}` }, g);
    }
    if (isSel && n.kind !== "init" && n.kind !== "term") connectHandle(gH, n.x + radius(n) + 18, n.y, n.id);
    if (dropTarget === n.id) el("circle", { class: "dropring", cx: n.x, cy: n.y, r: r + 7 }, g);
    const tip = el("title", {}, g);
    tip.textContent = { init: _t("Default transition start"), cond: _t("Condition connector (if / else)"), junction: _t("Junction (J): merges transitions"),
                        hist: _t("History connector (H)"), term: _t("Termination connector") }[n.kind] || n.kind;
    el("circle", { cx: n.x, cy: n.y, r: r + 5, fill: "transparent", "data-id": n.id }, g);
  }

  for (const e of Object.values(edges())) {
    const a = nodes()[e.from], b = nodes()[e.to];
    if (!a || !b) continue;
    const isSel = sel && sel.t === "edge" && sel.id === e.id;
    const g = el("g", { class: "edge" + (isSel ? " sel" : "") + markClass("edge", e.id), "data-edge": e.id }, gE);
    const geo = edgeGeom(e, a, b);
    el("path", { class: "hit", d: geo.d, "data-edge": e.id }, g);
    el("path", { class: "line", d: geo.d, "marker-end": isSel ? "url(#arrowSel)" : "url(#arrow)" }, g);
    const rank = prioRank(e);
    const lbl = edgeLabel(e);
    if (lbl) {
      const txt = shortText(lbl, 46);
      const lx = geo.mid.x + (e.lx || 0), ly = geo.mid.y + (e.ly != null ? e.ly : -6);
      const bgw = txt.length * 6.6 + 6;
      el("rect", { class: "lblbg", x: lx - bgw / 2, y: ly - 11, width: bgw, height: 14, rx: 3, "data-edge": e.id }, g);
      const t = el("text", { x: lx, y: ly, "text-anchor": "middle", class: isSel ? "sel" : "", "data-edge": e.id }, g);
      t.textContent = txt;
      const tt = el("title", {}, t); tt.textContent = lbl;
    }
    if (rank) {          // numbered badge where the transition leaves its source: the order they are tested in
      const bx = geo.start.x + geo.dir.x * 15, by = geo.start.y + geo.dir.y * 15;
      const pb = el("g", { class: "pbadge" + (rank.k === 1 ? " first" : ""), "data-edge": e.id }, g);
      el("circle", { cx: bx, cy: by, r: 9, "data-edge": e.id }, pb);
      const pt = el("text", { x: bx, y: by + 4, "text-anchor": "middle", "data-edge": e.id }, pb);
      pt.textContent = rank.k;
      const ptt = el("title", {}, pb);
      ptt.textContent = _t("Tested {0} of {1} among the transitions leaving this state — the first true guard wins", rank.k, rank.n);
    }
    if (isSel) {
      el("circle", { class: "bend", cx: geo.mid.x, cy: geo.mid.y, r: 5, "data-handle": "bend", "data-edge": e.id }, gH);
      if (a !== b) {                                   // drag an end: slide along the outline, or drop it on another state
        const ends = [[0, geo.start, a.kind !== "init"], [1, geo.end, true]];
        for (const [k, pt, ok] of ends) if (ok) {
          const c = el("circle", { class: "endpt", cx: pt.x, cy: pt.y, r: 8, "data-handle": "ep" + k, "data-edge": e.id }, gH);
          const tt = el("title", {}, c); tt.textContent = _t("Drag this end: slide it along the outline, or drop it on another state");
        }
      }
    }
  }

  // ⚠ next to every element with a problem
  for (const [id, kind] of Object.entries(marks.node)) {
    const n = nodes()[id];
    if (!n) continue;
    const bx = isState(n) ? n.x + n.w - 4 : n.x + radius(n) * 0.8, by = isState(n) ? n.y - 4 : n.y - radius(n) * 0.8 - 2;
    const b = el("text", { class: "warnbadge " + kind, x: bx, y: by, "text-anchor": "end" }, gH);
    b.textContent = "⚠";
  }
  for (const [id, kind] of Object.entries(marks.edge)) {
    const e = edges()[id], a = e && nodes()[e.from], bb = e && nodes()[e.to];
    if (!e || !a || !bb) continue;
    const geo = edgeGeom(e, a, bb);
    const b = el("text", { class: "warnbadge " + kind, x: geo.mid.x + (e.lx || 0) - 6, y: geo.mid.y + (e.ly != null ? e.ly : -6) - 14 }, gH);
    b.textContent = "⚠";
  }
  if (rubber) el("path", { class: "rubber", d: `M${rubber.x1} ${rubber.y1} L${rubber.x2} ${rubber.y2}`, "marker-end": "url(#arrowSel)" }, gH);
  if (rubber && rubber.snap) el("circle", { class: "snapdot", cx: rubber.snap.x, cy: rubber.snap.y, r: 5 }, gH);
  if (ghost) el("rect", { class: "ghost", x: Math.min(ghost.x1, ghost.x2), y: Math.min(ghost.y1, ghost.y2),
    width: Math.abs(ghost.x2 - ghost.x1), height: Math.abs(ghost.y2 - ghost.y1) }, gH);
}

/* the small ➜ next to the selected state / connector: drag it onto another state = transition, onto empty space = new state + transition */
function connectHandle(parent, x, y, id) {
  const g = el("g", { class: "connect", "data-handle": "connect", "data-id": id }, parent);
  el("circle", { cx: x, cy: y, r: 6, "data-handle": "connect", "data-id": id }, g);
  el("path", { d: `M${x - 3} ${y} H${x + 2} M${x} ${y - 2.5} L${x + 3} ${y} L${x} ${y + 2.5}` }, g);
  const t = el("title", {}, g); t.textContent = _t("Drag to another state to connect (Shift + drop on empty space = new state)");
}

function edgeGeom(e, a, b) {
  if (a === b) {                                   // self loop on the top-right corner
    const x = isState(a) ? a.x + a.w : a.x + 8, y = isState(a) ? a.y : a.y - 8;
    const s = 26 + (e.bend || 0);
    const p0 = { x: x - 28, y }, p1 = { x, y: y + 22 };
    return { d: `M${p0.x} ${p0.y} C${p0.x} ${y - s}, ${x + s} ${p1.y}, ${p1.x} ${p1.y}`, mid: { x: x + s * 0.45, y: y - s * 0.45 },
             start: p0, dir: { x: 0, y: -1 } };
  }
  const ca = center(a), cb = center(b);
  const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
  const dx = cb.x - ca.x, dy = cb.y - ca.y, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L, bend = e.bend || 0;
  const ctrl = { x: mx + nx * bend * 2, y: my + ny * bend * 2 };
  if (bend && !e.sa && !e.ta) {
    /* a bent line leaves / enters where the curve itself crosses the outlines (not where a straight ray would), so the
       arrow head always sits on the outline and points along the curve, even when the bend handle is dragged far away */
    const q = (t) => ({ x: (1 - t) * (1 - t) * ca.x + 2 * t * (1 - t) * ctrl.x + t * t * cb.x, y: (1 - t) * (1 - t) * ca.y + 2 * t * (1 - t) * ctrl.y + t * t * cb.y });
    const within = (n, pt) => isState(n) ? pt.x >= n.x && pt.x <= n.x + n.w && pt.y >= n.y && pt.y <= n.y + n.h : Math.hypot(pt.x - n.x, pt.y - n.y) <= radius(n);
    let lo = 0, hi = 0.5;                                // last t still inside a
    if (within(a, q(0.5))) lo = 0.5; else { for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (within(a, q(m))) lo = m; else hi = m; } }
    let l2 = 0.5, h2 = 1;                                // first t already inside b
    if (within(b, q(0.5))) h2 = 0.5; else { for (let i = 0; i < 24; i++) { const m = (l2 + h2) / 2; if (within(b, q(m))) h2 = m; else l2 = m; } }
    const t0 = lo, t1 = h2;
    if (t1 - t0 > 0.02) {
      const P0 = q(t0), P2 = q(t1);
      const k0 = (1 - t0) * (1 - t1), k1 = t0 * (1 - t1) + t1 * (1 - t0), k2 = t0 * t1;
      const C = { x: k0 * ca.x + k1 * ctrl.x + k2 * cb.x, y: k0 * ca.y + k1 * ctrl.y + k2 * cb.y };
      const sl = Math.hypot(C.x - P0.x, C.y - P0.y) || 1;
      return { d: `M${P0.x} ${P0.y} Q${C.x} ${C.y} ${P2.x} ${P2.y}`, mid: q((t0 + t1) / 2), nx, ny, ca, cb, start: P0, end: P2, dir: { x: (C.x - P0.x) / sl, y: (C.y - P0.y) / sl } };
    }
  }
  const p0 = e.sa && isState(a) ? anchorPt(a, e.sa) : boundary(a, bend ? ctrl : cb);
  const p1 = e.ta && isState(b) ? anchorPt(b, e.ta) : boundary(b, bend ? ctrl : ca);
  const mid = { x: 0.25 * p0.x + 0.5 * ctrl.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * ctrl.y + 0.25 * p1.y };
  const to = bend ? ctrl : p1, dl = Math.hypot(to.x - p0.x, to.y - p0.y) || 1;
  return { d: bend ? `M${p0.x} ${p0.y} Q${ctrl.x} ${ctrl.y} ${p1.x} ${p1.y}` : `M${p0.x} ${p0.y} L${p1.x} ${p1.y}`,
           mid, nx, ny, ca, cb, start: p0, end: p1, dir: { x: (to.x - p0.x) / dl, y: (to.y - p0.y) / dl } };
}

// ------------------------------------------------------------------ interaction
let drag = null, rubber = null, ghost = null, dropTarget = null, spaceDown = false;
let hoverId = null;                        // state under (or just next to) the pointer: shows its connect handles
let pending = null;                        // transition tool, first click done: waiting for the target click

function toWorld(ev) {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
}
function hitNodeId(target) {
  let t = target;
  while (t && t !== svg) {
    if (t.dataset && t.dataset.id && !t.dataset.handle) return t.dataset.id;
    t = t.parentNode;
  }
  return null;
}
/* where on the outline of state n the point p is: {u,v} as fractions of the box (it follows moves / resizes).
   null when p is farther than 14 px from the outline, unless forced - then the line just aims at the center as before */
function anchorFor(n, p, force) {
  if (!isState(n)) return null;
  let x = Math.min(Math.max(p.x, n.x), n.x + n.w), y = Math.min(Math.max(p.y, n.y), n.y + n.h);
  if (p.x > n.x && p.x < n.x + n.w && p.y > n.y && p.y < n.y + n.h) {          // inside: push out to the nearest side
    const d = [p.x - n.x, n.x + n.w - p.x, p.y - n.y, n.y + n.h - p.y], m = Math.min(...d);
    if (m === d[0]) x = n.x; else if (m === d[1]) x = n.x + n.w; else if (m === d[2]) y = n.y; else y = n.y + n.h;
  }
  if (!force && Math.hypot(p.x - x, p.y - y) > 14 / view.k) return null;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { u: r3((x - n.x) / n.w), v: r3((y - n.y) / n.h) };
}
function anchorPt(n, a) { return { x: n.x + a.u * n.w, y: n.y + a.v * n.h }; }
/* within 7 px of a state's outline, but not on its resize corner */
function onBorder(n, p) {
  const m = 7 / view.k, inX = p.x >= n.x - m && p.x <= n.x + n.w + m, inY = p.y >= n.y - m && p.y <= n.y + n.h + m;
  if (!inX || !inY) return false;
  const edge = p.x < n.x + m || p.x > n.x + n.w - m || p.y < n.y + m || p.y > n.y + n.h - m;
  const corner = Math.hypot(p.x - (n.x + n.w), p.y - (n.y + n.h)) < 12 / view.k;
  return edge && !corner && !(sel && sel.t === "node" && sel.id === n.id && corner);
}
/* a state whose outline is within 12 px of p (missing it by a little still counts) */
function nearState(p) {
  const m = 12 / view.k;
  let best = null, bd = 1e9;
  for (const n of Object.values(nodes())) {
    if (!isState(n)) continue;
    const dx = Math.max(n.x - p.x, 0, p.x - n.x - n.w), dy = Math.max(n.y - p.y, 0, p.y - n.y - n.h), d = Math.hypot(dx, dy);
    if (d <= m && d < bd) { best = n; bd = d; }
  }
  return best;
}
function nodeAtPoint(p, wantState) {
  // topmost: pseudo nodes first, then deepest state
  for (const n of Object.values(nodes())) {
    if (!isState(n) && !wantState && Math.hypot(p.x - n.x, p.y - n.y) <= radius(n) + 5) return n;
  }
  let best = null;
  for (const n of Object.values(nodes())) {
    if (isState(n) && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h)
      if (!best || n.w * n.h < best.w * best.h) best = n;
  }
  return best;
}

let stickyTool = false;                    // double-click a tool button: it stays selected after each use
function doneDrawing(ev) { if (!ev.shiftKey && !stickyTool) setTool("select"); }        // one line drawn: back to Select (Shift / double-click on the tool = keep drawing)
function setTool(t) {
  if (t !== tool) { stickyTool = false; pending = null; rubber = null; }
  tool = t;
  // picking a drawing tool means "I'm about to draw": close the properties card so it can't
  // sit over the spot the user is aiming at
  if (t !== "select" && sel && typeof project !== "undefined" && project) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    sel = null; refreshProps(); render();
  }
  document.querySelectorAll("#tools button[data-tool]").forEach((b) => {
    b.classList.toggle("on", b.dataset.tool === t);
    b.classList.toggle("sticky", b.dataset.tool === t && stickyTool && t !== "select");
  });
  svg.style.cursor = t === "select" ? "default" : "crosshair";
  const help = {
    select: _t("Select / move. Pull from a state's outline or its ➜ dots = transition. Drag empty space = pan, wheel = zoom, double-click empty space = new state, arrows = nudge, Ctrl+D = duplicate, Del = delete"),
    state: _t("Drag on empty space or inside a state to make a state (inside = substate)"),
    note: _t("Note: drag to size it, then type. Notes are comments for readers; they are not written into the C code"),
    trans: _t("Drag from a source state / connector to the target, or click the source then click the target (same state = self transition)"),
    init: _t("Default transition: just click the state that starts first. (Or drag from inside a container to the target state)"),
    cond: _t("Click where the condition connector goes"), junction: _t("Click where the junction goes"),
    hist: _t("History connector: click inside the composite state it restores"), term: _t("Click where the termination connector goes"),
  };
  $("status").textContent = help[t] || "";
}

function capture(ev) { try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic or already released */ } }
svg.addEventListener("pointerdown", (ev) => {
  svg.focus();
  const p = toWorld(ev);
  const tgt = ev.target;
  if (ev.button === 1 || spaceDown || (ev.button === 0 && tool === "select" && tgt.id === "bg" && !ev.shiftKey)) {
    drag = { kind: "pan", sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
    if (tool === "select" && tgt.id === "bg") { sel = null; refreshProps(); render(); }
    capture(ev);
    return;
  }
  if (ev.button !== 0) return;
  capture(ev);
  const handle = tgt.dataset && tgt.dataset.handle;
  const edgeId = tgt.dataset && tgt.dataset.edge;

  if (tool === "select") {
    if (handle === "resize") {
      const n = nodes()[tgt.dataset.id];
      snapshot();
      drag = { kind: "resize", n, ox: p.x, oy: p.y, w: n.w, h: n.h };
      return;
    }
    if (handle === "nresize") {
      const n = notes()[tgt.dataset.note];
      snapshot();
      drag = { kind: "nresize", n, ox: p.x, oy: p.y, w: n.w, h: n.h };
      return;
    }
    /* pressing an edge (or the selected edge) close to one of its ends grabs that end at once - no need to hit the little circle */
    const nearEdge = handle ? null : edgeId ? edges()[edgeId] : sel && sel.t === "edge" ? edges()[sel.id] : null;
    if (nearEdge && nodes()[nearEdge.from] && nodes()[nearEdge.to] && nodes()[nearEdge.from] !== nodes()[nearEdge.to]) {
      const g = edgeGeom(nearEdge, nodes()[nearEdge.from], nodes()[nearEdge.to]), r = 12 / view.k;
      const d0 = nodes()[nearEdge.from].kind === "init" ? 1e9 : Math.hypot(p.x - g.start.x, p.y - g.start.y), d1 = Math.hypot(p.x - g.end.x, p.y - g.end.y);
      if (Math.min(d0, d1) <= r) {
        sel = { t: "edge", id: nearEdge.id };
        snapshot();
        drag = { kind: "ep", e: nearEdge, end: d1 <= d0 ? 1 : 0 };
        refreshProps(); render();
        return;
      }
    }
    if (handle === "ep0" || handle === "ep1") {
      snapshot();
      drag = { kind: "ep", e: edges()[edgeId], end: +handle[2] };
      return;
    }
    if (handle === "connect") {
      const n = nodes()[tgt.dataset.id], sa = anchorFor(n, p, true), c = anchorPt(n, sa);
      rubber = { from: n.id, x1: c.x, y1: c.y, x2: p.x, y2: p.y, fromHandle: true, sa };
      drag = { kind: "rubber" };
      return;
    }
    if (handle === "bend") {
      snapshot();
      drag = { kind: "bend", e: edges()[edgeId] };
      return;
    }
    const noteEl = tgt.closest ? tgt.closest("[data-note]") : null;
    if (noteEl && notes()[noteEl.dataset.note]) {
      const n = notes()[noteEl.dataset.note];
      sel = { t: "note", id: n.id };
      drag = { kind: "nmove", n, start: p, ox: n.x, oy: n.y, moved: false };
      refreshProps(); render();
      return;
    }
    if (edgeId) { sel = { t: "edge", id: edgeId }; refreshProps(); render(); return; }
    let id = hitNodeId(tgt);
    if (id && isState(nodes()[id]) && onBorder(nodes()[id], p) && !ev.shiftKey) {       // grab the outline = pull a transition out of the state
      const n = nodes()[id], sa = anchorFor(n, p, true), c = anchorPt(n, sa);
      rubber = { from: id, x1: c.x, y1: c.y, x2: p.x, y2: p.y, fromHandle: true, sa };
      drag = { kind: "rubber" };
      return;
    }
    if (id) {
      sel = { t: "node", id };
      const n = nodes()[id];
      const own = n.kind === "init" ? Object.values(edges()).find((e) => e.from === id) : null;
      if (own) sel = { t: "edge", id: own.id };          // dot and line are one thing: selecting either selects both
      const moving = [n, ...(isState(n) ? descendants(id) : [])];
      const stuck = Object.values(notes()).filter((t) => moving.some((m) => m.id === t.attach));      // notes attached to them follow
      drag = { kind: "move", n, start: p, orig: [...moving, ...stuck].map((m) => ({ m, x: m.x, y: m.y })), moved: false };
      refreshProps(); render();
      return;
    }
    sel = null; refreshProps(); render();
    return;
  }
  if (tool === "state" || tool === "note") { ghost = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }; drag = { kind: "ghost" }; return; }
  if (tool === "trans" && pending) {                              // second click of a click-click transition
    const r = pending; pending = null;
    const tgt = nodeAtPoint(p) || nearState(p);
    if (!tgt || tgt.kind === "init") { rubber = null; render(); flash(_t("Click a target state or connector")); return; }
    finishTransition(r, tgt, ev, false, p);
    return;
  }
  if (tool === "trans") {
    const n = nodeAtPoint(p) || nearState(p);
    if (!n || n.kind === "init") { flash(_t("Start on a source state or connector")); return; }
    const sa = anchorFor(n, p), c = sa ? anchorPt(n, sa) : center(n);
    rubber = { from: n.id, x1: c.x, y1: c.y, x2: p.x, y2: p.y, sa };
    drag = { kind: "rubber" };
    return;
  }
  if (tool === "init") {
    rubber = { from: null, x1: p.x, y1: p.y, x2: p.x, y2: p.y, init: true };
    drag = { kind: "rubber" };
    return;
  }
  if (["cond", "junction", "hist", "term"].includes(tool)) {
    snapshot();
    const n = { id: uid("n"), kind: tool, x: Math.round(p.x), y: Math.round(p.y), parent: null, region: 0 };
    setParentAt(n, p.x, p.y);
    if (tool === "hist" && !n.parent) { undoStack.pop(); flash(_t("A history connector goes inside a composite state")); return; }
    nodes()[n.id] = n;
    sel = { t: "node", id: n.id };
    doneDrawing(ev);
    refreshAll();
  }
});

svg.addEventListener("pointermove", (ev) => {
  const p = toWorld(ev);
  $("status").dataset.pos = `${Math.round(p.x)}, ${Math.round(p.y)}`;
  if (!drag && tool === "select") {
    const t = hitNodeId(ev.target), n = t && nodes()[t];
    svg.style.cursor = n && isState(n) && onBorder(n, p) ? "crosshair" : "default";
  }
  if (!drag && !pending && tool === "select") {
    let best = null;
    for (const n of Object.values(nodes()))
      if (isState(n) && p.x >= n.x - 26 && p.x <= n.x + n.w + 26 && p.y >= n.y - 26 && p.y <= n.y + n.h + 26 && (!best || n.w * n.h < best.w * best.h)) best = n;
    if ((best ? best.id : null) !== hoverId) { hoverId = best ? best.id : null; render(); }
  }
  if (!drag && pending) {
    rubber.x2 = p.x; rubber.y2 = p.y;
    const n = nodeAtPoint(p); dropTarget = n && isState(n) ? n.id : null;
    render(); return;
  }
  if (!drag) return;
  if (drag.kind === "pan") {
    view.x = drag.vx + ev.clientX - drag.sx; view.y = drag.vy + ev.clientY - drag.sy; applyView(); return;
  }
  if (drag.kind === "move") {
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    if (!ev.altKey) { dx = Math.round(dx / 5) * 5; dy = Math.round(dy / 5) * 5; }
    for (const o of drag.orig) { o.m.x = o.x + dx; o.m.y = o.y + dy; }
    const c = center(drag.n);
    const skip = new Set(drag.orig.map((o) => o.m.id));
    const t = containerAt(c.x, c.y, skip);
    dropTarget = t ? t.id : null;
    render(); return;
  }
  if (drag.kind === "nmove") {
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    if (!ev.altKey) { dx = Math.round(dx / 5) * 5; dy = Math.round(dy / 5) * 5; }
    drag.n.x = drag.ox + dx; drag.n.y = drag.oy + dy;
    render(); return;
  }
  if (drag.kind === "nresize") {
    drag.n.w = Math.max(70, Math.round((drag.w + p.x - drag.ox) / 5) * 5);
    drag.n.h = Math.max(36, Math.round((drag.h + p.y - drag.oy) / 5) * 5);
    render(); return;
  }
  if (drag.kind === "resize") {
    drag.n.w = Math.max(60, Math.round((drag.w + p.x - drag.ox) / 5) * 5);
    drag.n.h = Math.max(36, Math.round((drag.h + p.y - drag.oy) / 5) * 5);
    render(); return;
  }
  if (drag.kind === "bend") {
    const e = drag.e, a = nodes()[e.from], b = nodes()[e.to];
    if (a === b) { e.bend = Math.max(-10, Math.round(Math.hypot(p.x - (a.x + (a.w || 0)), p.y - a.y) - 26)); }
    else {
      const ca = center(a), cb = center(b);
      const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
      const dx = cb.x - ca.x, dy = cb.y - ca.y, L = Math.hypot(dx, dy) || 1;
      e.bend = Math.round(((p.x - mx) * -dy / L + (p.y - my) * dx / L));
      if (Math.abs(e.bend) < 4) e.bend = 0;
    }
    render(); return;
  }
  if (drag.kind === "ghost") { ghost.x2 = p.x; ghost.y2 = p.y; render(); return; }
  if (drag.kind === "rubber") {
    rubber.x2 = p.x; rubber.y2 = p.y;
    const n = nodeAtPoint(p) || (rubber.init ? null : nearState(p));
    dropTarget = n && n.kind !== "init" ? n.id : null;
    const a = n && isState(n) ? anchorFor(n, p) : null;
    rubber.snap = a ? anchorPt(n, a) : null;
    render();
    return;
  }
  if (drag.kind === "ep") {
    const e = drag.e, node = nodes()[drag.end ? e.to : e.from], other = nodes()[drag.end ? e.from : e.to];
    const n = nodeAtPoint(p);
    const key = drag.end ? "ta" : "sa", okey = drag.end ? "sa" : "ta";
    if (n && n.id !== node.id && n.kind !== "init" && !(drag.end === 0 && n.kind === "term")) {      // hovering another node: preview a reconnect
      dropTarget = n.id;
      const o = isState(other) && e[okey] ? anchorPt(other, e[okey]) : center(other);
      const a = isState(n) ? anchorFor(n, p) : null;
      rubber = { x1: o.x, y1: o.y, x2: p.x, y2: p.y, snap: a ? anchorPt(n, a) : null };
    } else {
      dropTarget = null; rubber = null;
      if (isState(node)) e[key] = anchorFor(node, p, true);       // slide along the outline of its own state
    }
    render();
    return;
  }
});

svg.addEventListener("pointerup", (ev) => {
  const p = toWorld(ev);
  const d = drag;
  drag = null;
  // after a click (not a drag) or a new element: make sure the properties card doesn't hide it
  if (!d || d.kind !== "pan" && !(d.kind === "move" && d.moved) && d.kind !== "resize" && d.kind !== "bend")
    setTimeout(() => requestAnimationFrame(placeCard), 0);
  const dt = dropTarget; dropTarget = null;
  if (!d) return;
  if (d.kind === "move" && d.moved) {
    const c = center(d.n);
    setParentAt(d.n, c.x, c.y);
    // pseudo children of moved states keep their container; states inside keep theirs
    save(); refreshAll(); return;
  }
  if (d.kind === "ep") {
    rubber = null;
    const e = d.e, node = nodes()[d.end ? e.to : e.from], n = nodeAtPoint(p);
    if (n && n.id !== node.id && n.kind !== "init" && !(d.end === 0 && n.kind === "term")) {
      const a = anchorFor(n, p);
      if (d.end) { e.to = n.id; e.ta = a; } else { e.from = n.id; e.sa = a; }
      if (e.from === e.to) { e.sa = e.ta = null; }
    }
    save(); refreshAll(); return;
  }
  if (d.kind === "resize" || d.kind === "bend" || d.kind === "nresize" || (d.kind === "nmove" && d.moved)) { save(); refreshAll(); return; }
  if (d.kind === "ghost" && tool === "note") {
    const g = ghost; ghost = null;
    let x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2), w = Math.abs(g.x2 - g.x1), h = Math.abs(g.y2 - g.y1);
    if (w < 40 || h < 30) { w = 170; h = 70; x = g.x1 - 10; y = g.y1 - 10; }
    snapshot();
    const n = { id: uid("t"), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), text: "", attach: null };
    notesW()[n.id] = n;
    sel = { t: "note", id: n.id };
    doneDrawing(ev);
    refreshAll();
    focusProp("pNoteText");
    return;
  }
  if (d.kind === "ghost") {
    const g = ghost; ghost = null;
    let x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2), w = Math.abs(g.x2 - g.x1), h = Math.abs(g.y2 - g.y1);
    if (w < 30 || h < 20) { w = 130; h = 60; x = g.x1 - 10; y = g.y1 - 10; }
    snapshot();
    const n = { id: uid("n"), kind: "state", name: freshName("state"), x: Math.round(x), y: Math.round(y),
                w: Math.round(w), h: Math.round(h), parent: null, region: 0, entry: "", exit: "", reactions: [] };
    setParentAt(n, g.x1, g.y1);
    nodes()[n.id] = n;
    sel = { t: "node", id: n.id };
    doneDrawing(ev);
    refreshAll();
    focusProp("pName");
    return;
  }
  if (d.kind === "rubber") {
    const r = rubber; rubber = null;
    const tgt = nodeAtPoint(p) || (r.init ? null : nearState(p));
    const moved = Math.hypot(p.x - r.x1, p.y - r.y1) > 8;
    if (!moved && r.init) {                    // Default transition tool: a plain click on a state is enough
      if (tgt && isState(tgt)) { autoInit(tgt, ev); return; }
      render(); return;
    }
    if (!moved && r.from && !r.fromHandle && tool === "trans") {    // click the source, then click the target
      pending = r; rubber = { ...r, x2: p.x, y2: p.y }; render();
      flash(_t("Now click the target state"), true);
      return;
    }
    if (!tgt && r.fromHandle && moved && !ev.shiftKey) { rubber = null; render(); flash(_t("Dropped on empty space: nothing created (hold Shift while dropping to make a new state)")); return; }
    if (!tgt && r.fromHandle && moved) {       // Shift + drop on empty space: new state + transition
      snapshot();
      const n = { id: uid("n"), kind: "state", name: freshName("state"), x: Math.round((p.x - 65) / 5) * 5, y: Math.round((p.y - 30) / 5) * 5,
                  w: 130, h: 60, parent: null, region: 0, entry: "", exit: "", reactions: [] };
      setParentAt(n, p.x, p.y);
      nodes()[n.id] = n;
      finishTransition(r, n, ev, true);
      return;
    }
    if (!tgt || tgt.kind === "init" || (r.fromHandle && !moved)) { render(); return; }
    finishTransition(r, tgt, ev, false, p);
  }
  void dt;
});

/* connect r.from (or a new default-transition dot) to tgt and select the new transition */
function finishTransition(r, tgt, ev, snapped, endP) {
  if (!snapped) snapshot();
  r.ta = endP && isState(tgt) ? anchorFor(tgt, endP) : null;
  let from = r.from;
  if (r.init) {
    const c = containerAt(r.x1, r.y1, new Set());
    const n = { id: uid("n"), kind: "init", x: Math.round(r.x1), y: Math.round(r.y1), parent: c ? c.id : null,
                region: c && c.and ? regionAt(c, r.y1) : 0 };
    if (tgt.id === (c && c.id)) { undoStack.pop(); flash(_t("A default transition must point at a state inside its container")); rubber = null; render(); return; }
    nodes()[n.id] = n;
    from = n.id;
  }
  const e = addEdge(from, tgt.id);
  if (!r.init && r.from !== tgt.id) { e.sa = r.sa || null; e.ta = r.ta || null; }
  rubber = null;
  sel = null;                                      // no card popping up over the drawing; double-click the line to type guard / action
  doneDrawing(ev);
  refreshAll();
  if (!r.init) flash(_t("Transition drawn. Double-click it to type a guard / action"), true);
}
function addEdge(from, to) {
  // a second edge between the same pair bows out so the two don't overlap
  const twin = Object.values(edges()).some((x) => (x.from === from && x.to === to) || (x.from === to && x.to === from));
  const e = { id: uid("e"), from, to, trigger: "", guard: "", action: "", bend: twin && from !== to ? 22 : 0 };
  if (twin) for (const x of Object.values(edges()))
    if (x.from === to && x.to === from && !x.bend) x.bend = 22;
  edges()[e.id] = e;
  return e;
}
/* Default transition tool, plain click on a state: put the dot where it is free (above / left / right / below the state,
   inside the same container) and connect it. */
function autoInit(s, ev) {
  const c = nodes()[s.parent] || null;
  const spots = [[s.x + 16, s.y - 28], [s.x - 28, s.y + 18], [s.x + s.w + 28, s.y + 18], [s.x + 16, s.y + s.h + 28]];
  const free = (x, y) => {
    const home = containerAt(x, y, new Set());
    if ((home ? home.id : null) !== (c ? c.id : null)) return false;
    if (Object.values(nodes()).some((n) => !isState(n) && Math.hypot(n.x - x, n.y - y) < 20)) return false;
    return !(c && c.and && regionAt(c, y) !== (s.region || 0));
  };
  const [x, y] = spots.find(([px, py]) => free(px, py)) || spots[0];
  snapshot();
  const n = { id: uid("n"), kind: "init", x: Math.round(x), y: Math.round(y), parent: c ? c.id : null, region: c && c.and ? regionAt(c, y) : 0 };
  nodes()[n.id] = n;
  addEdge(n.id, s.id);
  rubber = null;
  sel = null;
  doneDrawing(ev);
  refreshAll();
}

/* two fingers = pinch zoom + pan (the one-finger drag that may already have started is dropped) */
(() => {
  const pts = new Map();
  let pinch = null;
  const local = (ev) => { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const geom = () => {
    const [a, b] = [...pts.values()];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    pts.set(ev.pointerId, local(ev));
    if (pts.size === 2) { drag = null; dropTarget = null; pinch = { ...geom(), v: { ...view } }; render(); }
    if (pts.size >= 2) ev.stopImmediatePropagation();
  }, true);
  svg.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "touch" || !pts.has(ev.pointerId)) return;
    pts.set(ev.pointerId, local(ev));
    if (!pinch || pts.size < 2) return;
    ev.stopImmediatePropagation();
    const g = geom();
    const k = Math.max(0.2, Math.min(4, pinch.v.k * g.d / pinch.d));
    view.x = g.mx - (pinch.mx - pinch.v.x) * k / pinch.v.k;
    view.y = g.my - (pinch.my - pinch.v.y) * k / pinch.v.k;
    view.k = k;
    applyView();
  }, true);
  const end = (ev) => {
    if (ev.pointerType !== "touch") return;
    const was = pinch;
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (was) ev.stopImmediatePropagation();
  };
  svg.addEventListener("pointerup", end, true);
  svg.addEventListener("pointercancel", end, true);
})();

svg.addEventListener("dblclick", (ev) => {
  const noteEl = ev.target.closest ? ev.target.closest("[data-note]") : null;
  if (noteEl && notes()[noteEl.dataset.note]) { sel = { t: "note", id: noteEl.dataset.note }; refreshProps(); render(); focusProp("pNoteText"); return; }
  const id = hitNodeId(ev.target);
  const n = id && nodes()[id];
  if (!id && !ev.target.dataset.edge && tool === "select" && !ev.target.closest(".handle, .connect")) {     // empty canvas: a state right here
    const p = toWorld(ev);
    snapshot();
    const s = { id: uid("n"), kind: "state", name: freshName("state"), x: Math.round((p.x - 65) / 5) * 5, y: Math.round((p.y - 30) / 5) * 5,
                w: 130, h: 60, parent: null, region: 0, entry: "", exit: "", reactions: [] };
    setParentAt(s, p.x, p.y);
    nodes()[s.id] = s;
    sel = { t: "node", id: s.id };
    refreshAll(); focusProp("pName");
    return;
  }
  if (n && isState(n)) {
    sel = { t: "node", id }; refreshProps(); focusProp("pName");
  } else if (ev.target.dataset && ev.target.dataset.edge) {
    sel = { t: "edge", id: ev.target.dataset.edge }; refreshProps(); focusProp(nodes()[edges()[sel.id].from].kind === "init" ? "pAction" : "pGuard");
  }
});

svg.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const k = Math.max(0.2, Math.min(4, view.k * Math.exp(-ev.deltaY * 0.0015)));
  view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
  applyView();
}, { passive: false });

function zoomFit() {
  const ns = [...Object.values(nodes()), ...Object.values(notes())];
  if (!ns.length) { view = { x: 80, y: 40, k: 1 }; applyView(); return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of ns) {
    const w = n.w || 0, h = n.h || 0;
    x0 = Math.min(x0, n.x - 20); y0 = Math.min(y0, n.y - 30); x1 = Math.max(x1, n.x + w + 40); y1 = Math.max(y1, n.y + h + 20);
  }
  const r = svg.getBoundingClientRect();
  const top = 62, bottom = 34;          // keep clear of the tool bar and the help line
  const k = Math.max(0.3, Math.min(1.4, Math.min((r.width - 80) / (x1 - x0), (r.height - top - bottom) / (y1 - y0))));
  view = { k, x: 60 + (r.width - 60 - (x1 - x0) * k) / 2 - x0 * k, y: top + (r.height - top - bottom - (y1 - y0) * k) / 2 - y0 * k };
  applyView();
}

function deleteSelection() {
  if (!sel) return;
  snapshot();
  if (sel.t === "note") delete notes()[sel.id];
  else if (sel.t === "edge") {
    delete edges()[sel.id];
    for (const x of Object.values(nodes()))        // a default-transition dot left without its line would just be a stray dot
      if (x.kind === "init" && !Object.values(edges()).some((e) => e.from === x.id)) delete nodes()[x.id];
  } else {
    const n = nodes()[sel.id];
    const gone = new Set([sel.id, ...(n && isState(n) ? descendants(sel.id).map((d) => d.id) : [])]);
    for (const id of gone) delete nodes()[id];
    for (const t of Object.values(notes())) if (gone.has(t.attach)) t.attach = null;
    for (const e of Object.values(edges())) if (gone.has(e.from) || gone.has(e.to)) delete edges()[e.id];
    // init dots whose only edge vanished
    for (const x of Object.values(nodes()))
      if (x.kind === "init" && !Object.values(edges()).some((e) => e.from === x.id)) delete nodes()[x.id];
  }
  sel = null;
  refreshAll();
}

document.addEventListener("keydown", (ev) => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !inField) { ev.preventDefault(); undo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y" && !inField) { ev.preventDefault(); redo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); downloadProject(); return; }
  if (inField) return;
  if (ev.key === " ") { spaceDown = true; svg.style.cursor = "grab"; ev.preventDefault(); return; }
  if (ev.key === "Delete" || ev.key === "Backspace") { deleteSelection(); ev.preventDefault(); return; }
  if (sel && sel.t !== "edge" && sel.t !== "class" && ev.key.startsWith("Arrow")) {       // nudge: 5 px (Shift = 20)
    const st = ev.shiftKey ? 20 : 5, dx = { ArrowLeft: -st, ArrowRight: st }[ev.key] || 0, dy = { ArrowUp: -st, ArrowDown: st }[ev.key] || 0;
    const n = sel.t === "note" ? notes()[sel.id] : nodes()[sel.id];
    if (n) {
      snapshot();
      const moving = sel.t === "node" ? [n, ...(isState(n) ? descendants(n.id) : [])] : [n];
      const stuck = sel.t === "node" ? Object.values(notes()).filter((t) => moving.some((m) => m.id === t.attach)) : [];
      for (const m of [...moving, ...stuck]) { m.x += dx; m.y += dy; }
      save(); render(); ev.preventDefault(); return;
    }
  }
  if (ev.key === "Enter" && sel && sel.t === "node" && isState(nodes()[sel.id])) { focusProp("pName"); ev.preventDefault(); return; }
  if (ev.key === "Enter" && sel && sel.t === "edge") { focusProp(nodes()[edges()[sel.id].from].kind === "init" ? "pAction" : "pGuard"); ev.preventDefault(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") { ev.preventDefault(); duplicateSelection(); return; }
  if (ev.key === "Escape") { setTool("select"); rubber = ghost = null; pending = null; drag = null; sel = null; refreshProps(); render(); return; }
  const map = { v: "select", s: "state", t: "trans", d: "init", c: "cond", j: "junction", h: "hist", x: "term", n: "note" };
  if (map[ev.key.toLowerCase()] && !ev.ctrlKey) setTool(map[ev.key.toLowerCase()]);
  if (ev.key.toLowerCase() === "f") zoomFit();
});
document.addEventListener("keyup", (ev) => { if (ev.key === " ") { spaceDown = false; setTool(tool); } });

/* Ctrl+D: copy of the selected state (with everything inside it and the transitions among them), a little to the lower right */
function duplicateSelection() {
  if (!sel || sel.t !== "node" || !isState(nodes()[sel.id])) return flash(_t("Select a state first, then Ctrl+D"));
  snapshot();
  const root = nodes()[sel.id], set = [root, ...descendants(root.id)], map = {};
  for (const n of set) map[n.id] = uid("n");
  for (const n of set) {
    const c = JSON.parse(JSON.stringify(n));
    c.id = map[n.id]; c.x += 30; c.y += 30;
    c.parent = n === root ? root.parent : map[n.parent];
    if (n === root) c.name = freshName(root.name.replace(/\d+$/, ""));
    nodes()[c.id] = c;
  }
  for (const e of Object.values(edges()))
    if (map[e.from] && map[e.to]) { const c = JSON.parse(JSON.stringify(e)); c.id = uid("e"); c.from = map[e.from]; c.to = map[e.to]; edges()[c.id] = c; }
  sel = { t: "node", id: map[root.id] };
  refreshAll();
}
function freshName(base) {
  const used = new Set(Object.values(nodes()).filter(isState).map((n) => n.name));
  for (let i = 0; ; i++) if (!used.has(base + i)) return base + i;
}
function flash(msg, neutral) {
  const s = $("status");
  s.textContent = msg; s.style.color = neutral ? "var(--accent)" : "var(--err)";
  setTimeout(() => { s.style.color = ""; setTool(tool); }, 2200);
}

// ------------------------------------------------------------------ properties panel
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === "on") for (const ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
    else if (k === "value") e.value = attrs[k];
    else if (k === "checked") e.checked = attrs[k];
    else if (attrs[k] != null) e.setAttribute(k, attrs[k]);          // null / undefined: leave the attribute out
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
/* text input bound to obj[key]; one undo snapshot per focus */
function bound(obj, key, opts) {
  opts = opts || {};
  const tag = opts.area ? "textarea" : "input";
  let snapped = false;
  const e = h(tag, { id: opts.id || "", type: "text", rows: opts.rows || 3, spellcheck: "false",
                     class: opts.cls || "", placeholder: opts.ph || "", value: obj[key] == null ? "" : obj[key] });
  e.addEventListener("focus", () => { snapped = false; });
  // Enter = "done": leave the field; in the name / trigger field of the properties card it also
  // closes the card, so the next drawing step has the whole canvas
  if (!opts.area) e.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    e.blur(); svg.focus();
    if (opts.id === "pName" || opts.id === "pTrigger" || opts.id === "pGuard") { sel = null; refreshProps(); render(); }
  });
  e.addEventListener("input", () => {
    if (!snapped) { snapshot(); snapped = true; }
    obj[key] = opts.parse ? opts.parse(e.value) : e.value;
    save();
    if (opts.onchange) opts.onchange();
    render();
  });
  return e;
}
function focusProp(id) {
  const f = () => { const e = $(id); if (e && document.activeElement !== e) { e.focus(); if (e.select) e.select(); } };
  f(); setTimeout(f, 0);
}

/* Task-style models have no events. A word typed as a Trigger (button, evGo) becomes a bool
   input variable (Event signal in the simulator) and moves into the Guard. Runs when the user is
   done typing: field left, selection changed, Generate / Build, project loaded. */
const DIRS = ["in", "out", "local", "config"];
function migrateClass(c) {
  const added = [];
  c.attributes = c.attributes || [];
  const names = new Set(c.attributes.map((a) => a.name));
  const N = (c.chart || {}).nodes || {}, E = (c.chart || {}).edges || {};
  const items = Object.values(E).concat(Object.values(N).flatMap((n) => n.reactions || []));
  for (const e of items) {
    const t = (e.trigger || "").trim();
    if (!t || /^tm\s*\(/.test(t)) continue;
    const name = t.replace(/\(.*$/, "").trim();
    if (!IDENT.test(name)) continue;
    if (!names.has(name)) {
      c.attributes.push({ type: "bool", name, default: "false", dir: "in" });
      names.add(name); added.push(name);
    }
    const g = (e.guard || "").trim();
    e.guard = g ? `(${name} == true) && (${g})` : `${name} == true`;
    e.trigger = "";
  }
  // there is no tm() any more: entry/ cnt_S = 0;  reaction/ cnt_S++;  [cnt_S >= N]  (same as model.py)
  const P = +(c.periodUs || project.periodUs) || TASK_US;
  for (const [sid, n] of Object.entries(N)) {
    const own = Object.values(E).filter((e) => e.from === sid).concat(n.reactions || []);
    const timed = own.filter((e) => /^tm\s*\(/.test((e.trigger || "").trim()));
    if (!timed.length) continue;
    if (n.kind !== "state") { timed.forEach((e) => { e.trigger = ""; }); continue; }
    let v = ("cnt_" + (n.name || sid)).replace(/\W/g, "_");
    while (names.has(v)) v += "_";
    names.add(v); added.push(v);
    c.attributes.push({ type: "uint32_t", name: v, default: "0", dir: "local" });
    n.entry = `${v} = 0;` + ((n.entry || "").trim() ? "\n" + n.entry : "");
    n.reactions = [{ trigger: "", guard: "", action: `${v}++;` }].concat(n.reactions || []);
    for (const e of timed) {
      const expr = e.trigger.trim().replace(/^tm\s*\(/, "").replace(/\)\s*$/, "").trim();
      const cond = /^\d+$/.test(expr) ? `${v} >= ${Math.max(1, Math.ceil(+expr * 1000 / P))}u` : `${v} >= (uint32_t)(${expr}) * 1000u / ${P}u`;
      const g = (e.guard || "").trim();
      e.guard = g ? `(${cond}) && (${g})` : cond;
      e.trigger = "";
    }
  }
  delete c.periodUs;
  for (const a of c.attributes) {
    if (!DIRS.includes(a.dir)) a.dir = "local";
    delete a.sig; delete a.pulse; delete a.min; delete a.max;
  }
  return added;
}
function autoDeclareEvents() {
  const added = project.classes.flatMap((c) => migrateClass(c));
  if (!added.length) return;
  save(); refreshLeft(); validate(); render();
  flash(_t("Old events / tm() turned into variables: {0}", added.join(", ")), true);
}
let lastPropsKey = "";
function refreshProps() {
  autoDeclareEvents();
  const P = $("props");
  P.textContent = "";
  if (sel && sel.t === "node" && !nodes()[sel.id]) sel = null;
  if (sel && sel.t === "edge" && !edges()[sel.id]) sel = null;
  if (sel && sel.t === "note" && !notes()[sel.id]) sel = null;
  $("right").hidden = !sel;        // floats over the canvas: opening/closing never moves the drawing
  const key = sel ? sel.t + ":" + sel.id : "";
  if (sel && key !== lastPropsKey && isPhone()) setBottom(false);      // phone: picking something gives the room to its properties
  lastPropsKey = key;
  if (!sel) return;
  requestAnimationFrame(placeCard);
  requestAnimationFrame(followCode);
  if (sel.t === "class") return classProps(P);
  if (sel.t === "edge") return edgeProps(P, edges()[sel.id]);
  if (sel.t === "note") return noteProps(P, notes()[sel.id]);
  const n = nodes()[sel.id];
  if (isState(n)) return stateProps(P, n);
  return pseudoProps(P, n);
}
/* the properties card floats on the side of the canvas away from the selection, so it never
   covers what you are editing and the drawing never has to move */
function placeCard() {
  const card = $("right");
  if (card.hidden) return;
  const cv = $("center").getBoundingClientRect(), main = $("main").getBoundingClientRect();
  let onLeft = false;
  if (sel && sel.t !== "class") {
    const el = world.querySelector(sel.t === "edge" ? `[data-edge="${sel.id}"]` : sel.t === "note" ? `[data-note="${sel.id}"]` : `g[data-id="${sel.id}"]`);
    if (el) {
      const b = el.getBoundingClientRect();
      onLeft = (b.left + b.right) / 2 > cv.left + cv.width / 2;
    }
  }
  if (onLeft) { card.style.left = (cv.left - main.left + 12) + "px"; card.style.right = "auto"; }
  else { card.style.left = "auto"; card.style.right = "12px"; }
}
/* opening/closing a side panel resizes the canvas; keep the drawing where it was on screen */
let lastCanvasLeft = null;
function keepCanvasStill() {
  const r = svg.getBoundingClientRect();
  if (lastCanvasLeft !== null) { view.x -= r.left - lastCanvasLeft; applyView(); }
  lastCanvasLeft = r.left;
}


function noteProps(P, n) {
  P.append(h("h2", {}, _t("Note")));
  P.append(h("label", {}, _t("Text")), bound(n, noteKey(n), { id: "pNoteText", area: true, rows: 5, ph: noteText(n) !== (n[noteKey(n)] || "") ? noteText(n) : "" }));
  P.append(h("div", { class: "hint" }, _t("Shown in the current language. Switch the language button (English / 한국어) to write the other text.")));
  P.append(h("label", {}, _t("Attached to")));
  const pick = h("select", { id: "pNoteAttach" }, h("option", { value: "" }, _t("(nothing: free note)")));
  for (const s of Object.values(nodes()).filter(isState)) pick.append(h("option", { value: s.id }, s.name));
  pick.value = n.attach && nodes()[n.attach] ? n.attach : "";
  pick.addEventListener("change", () => { snapshot(); n.attach = pick.value || null; save(); render(); });
  P.append(pick);
  P.append(h("div", { class: "hint" }, _t("A note is for the people who read the drawing. It is not written into the C code.")));
  P.append(h("button", { class: "danger", on: { click: deleteSelection } }, _t("Delete note")));
}

function stateProps(P, n) {
  const parent = nodes()[n.parent];
  P.append(h("h2", {}, "State"));
  P.append(h("label", {}, "Name"), bound(n, "name", { id: "pName", cls: "ident" }));
  P.append(h("div", { class: "hint" }, _t("Inside: ") + (parent ? parent.name + (parent.and ? ` / ${((parent.regions || [])[n.region] || {}).name || "r" + n.region}` : "") : _t("(top level)"))));
  const andBox = h("input", { type: "checkbox", checked: !!n.and, on: { change: () => {
    snapshot(); n.and = andBox.checked;
    if (n.and && !(n.regions || []).length) n.regions = [{ name: n.name + "_r0" }, { name: n.name + "_r1" }];
    refreshAll();
  } } });
  P.append(h("label", {}, h("span", { class: "row" }, andBox, _t(" AND state (parallel regions)"))));
  if (n.and) {
    const card = h("div", { class: "card" });
    (n.regions || []).forEach((r, i) => {
      card.append(h("div", { class: "row" }, bound(r, "name", { cls: "ident" }),
        h("button", { class: "del", title: _t("Delete region"), on: { click: () => {
          if (n.regions.length <= 2) return flash(_t("An AND state needs at least 2 regions"));
          snapshot(); n.regions.splice(i, 1);
          for (const c of children(n.id)) if (c.region >= i) c.region = Math.max(0, c.region - 1);
          refreshAll();
        } } }, "✕")));
    });
    card.append(h("button", { class: "mini", on: { click: () => {
      snapshot(); n.regions.push({ name: `${n.name}_r${n.regions.length}` }); refreshAll();
    } } }, "+ region"));
    P.append(h("label", {}, _t("Regions (top → bottom)")), card);
  }
  P.append(h("label", {}, "Entry action"), bound(n, "entry", { area: true, rows: 3, ph: "cnt = 0;\nled = true;" }));
  P.append(h("label", {}, "Exit action"), bound(n, "exit", { area: true, rows: 2, ph: "led = false;" }));
  P.append(h("label", {}, _t("Internal reactions (no exit / entry)")));
  n.reactions = n.reactions || [];
  const box = h("div", {});
  n.reactions.forEach((r, i) => {
    box.append(h("div", { class: "card" },
      h("div", { class: "row" }, bound(r, "guard", { cls: "code", ph: _t("guard — empty = every call") }),
        h("button", { class: "del", on: { click: () => { snapshot(); n.reactions.splice(i, 1); refreshAll(); } } }, "✕")),
      bound(r, "action", { area: true, rows: 2, ph: "action" })));
  });
  P.append(box, h("button", { class: "mini", on: { click: () => {
    snapshot(); n.reactions.push({ trigger: "", guard: "", action: "" }); refreshAll();
  } } }, "+ reaction"));
  P.append(h("p", { class: "help" }, _t("Actions use variables by name ("), h("code", {}, "count++;"), ", ", h("code", {}, "led = true;"),
    _t("), state test: "), h("code", {}, "IS_IN(state)"), _t(". Internal reactions run on every call (10 ms) while the state is active, before the transitions (outer state first). "),
    _t("Counting time: entry "), h("code", {}, "cnt = 0;"), _t(", reaction "), h("code", {}, "cnt++;"), _t(", transition "), h("code", {}, "[cnt >= 50u]"), " = 500 ms."));
}

function pseudoProps(P, n) {
  const names = { init: "Default transition start", cond: "Condition connector", junction: "Junction",
                  hist: "History connector (shallow)", term: "Termination connector" };
  P.append(h("h2", {}, names[n.kind] || n.kind));
  const parent = nodes()[n.parent];
  P.append(h("div", { class: "hint" }, _t("Inside: ") + (parent ? parent.name : _t("(top level)"))));
  const help = {
    cond: _t("Give every outgoing transition a [guard]; one of them is best [else]."),
    junction: _t("Merges several transitions into one. The outgoing transition can have a guard / action."),
    hist: _t("Entering through this connector returns to the substate the parent was last in. One outgoing transition sets the default when there is no history yet."),
    term: _t("Reaching this ends the object's state machine."),
    init: _t("Points at the state entered first when the container is entered."),
  };
  P.append(h("p", { class: "help" }, help[n.kind] || ""));
}

function edgeProps(P, e) {
  const a = nodes()[e.from], b = nodes()[e.to];
  const nm = (n) => !n ? "?" : isState(n) ? n.name : { init: "●", cond: "◇", junction: "•", hist: "H", term: "⊗" }[n.kind];
  const isInit = a && a.kind === "init";
  P.append(h("h2", {}, isInit ? "Default transition" : "Transition"));
  P.append(h("div", { class: "hint" }, `${nm(a)} → ${nm(b)}`));
  if (!isInit) {
    P.append(h("label", {}, _t("Guard  [condition] — plain C, variables by name")),
             bound(e, "guard", { id: "pGuard", cls: "code", ph: "(button == true) && (cnt >= 50u)" }));
  }
  P.append(h("label", {}, "Action"), bound(e, "action", { id: "pAction", area: true, rows: 4, ph: "count = 0;" }));
  const prev = h("div", { class: "label-preview" }, edgeLabel(e) || "(no label)");
  P.append(h("label", {}, "Label"), prev);
  P.addEventListener("input", () => { prev.textContent = edgeLabel(e) || "(no label)"; });
  const rank = isInit ? null : prioRank(e);
  if (rank) {
    const free = isFree(e), guarded = rank.list.filter((x) => !isFree(x));
    const gi = guarded.indexOf(e);
    P.append(h("label", {}, h("span", { class: "pbadge-i" + (rank.k === 1 ? " first" : "") }, rank.k), " ", _t("Tested {0} of {1} — the first true guard wins", rank.k, rank.n)));
    P.append(h("div", { class: "row prio" },
      h("button", { class: "mini", id: "prioUp", title: _t("Test earlier (wins when guards are true at the same time)"),
                    disabled: free || gi <= 0 ? "" : null, on: { click: () => movePrio(e, -1) } }, _t("▲ Earlier")),
      h("button", { class: "mini", id: "prioDown", title: _t("Test later"),
                    disabled: free || gi < 0 || gi >= guarded.length - 1 ? "" : null, on: { click: () => movePrio(e, +1) } }, _t("▼ Later"))));
    const ol = h("ol", { class: "priolist" });
    for (const x of rank.list) {
      const nm2 = (n) => !n ? "?" : isState(n) ? n.name : { cond: "◇", junction: "•", hist: "H", term: "⊗" }[n.kind] || n.kind;
      ol.append(h("li", { class: x === e ? "on" : "", title: _t("Click to select this transition"), on: { click: () => { sel = { t: "edge", id: x.id }; refreshProps(); render(); } } },
        h("span", { class: "pbadge-i" + (rank.list.indexOf(x) === 0 ? " first" : "") }, rank.list.indexOf(x) + 1),
        ` → ${nm2(nodes()[x.to])}  ${edgeLabel(x) || _t("(no guard)")}` + (isFree(x) ? _t("  — no guard: always last") : "")));
    }
    P.append(ol);
    if (free) P.append(h("p", { class: "help" }, _t("A transition without a guard is always tested last (when all the others are false).")));
  }
  P.append(h("p", { class: "help" }, _t("One X_Main call fires at most one transition: inner states first, and among the transitions of one state the first true one in the priority order above.")));
  P.append(h("p", { class: "help" }, _t("Drag the blue dot in the middle to bend it.")));
}

function classProps(P) {
  const c = cls();
  P.append(h("h2", {}, "Class"));
  const cname = bound(c, "name", { cls: "ident", onchange: refreshLeft });
  if (typeof scWatchName === "function") scWatchName(cname, () => c.name, (o, n) => scRenameClass(o, n));         // scenarios follow a renamed class
  P.append(h("label", {}, "Name"), cname);
  const tbl = (title, rows, cols, mk) => {
    P.append(h("label", {}, title));
    const t = h("table", { class: "tbl" });
    rows.forEach((r, i) => {
      const tr = h("tr", {});
      for (const [k, ph, w] of cols) tr.append(h("td", { style: `width:${w}` }, bound(r, k, { ph, cls: "code" })));
      tr.append(h("td", { style: "width:16px" }, h("button", { class: "del", on: { click: () => { snapshot(); rows.splice(i, 1); refreshAll(); } } }, "✕")));
      t.append(tr);
    });
    P.append(t, h("button", { class: "mini", on: { click: () => { snapshot(); rows.push(mk()); refreshAll(); } } }, "+ add"));
  };
  c.attributes = c.attributes || []; c.operations = c.operations || []; c.assocs = c.assocs || [];
  P.append(h("label", {}, _t("X_Main arguments")));
  const io = h("select", { on: { change: () => { snapshot(); if (io.value === "struct") c.ioStyle = "struct"; else delete c.ioStyle; refreshAll(); } } },
    h("option", { value: "params" }, _t("parameters (i_ / return / o_)")), h("option", { value: "struct" }, _t("structs (X_In / X_Out)")));
  io.value = c.ioStyle === "struct" ? "struct" : "params";
  const [hint, warn] = argHint(c);
  P.append(io, h("pre", { class: "sig" }, sigPreviewText(c)), h("div", { class: "hint" + (warn ? " warn" : "") }, hint));
  P.append(h("label", {}, _t("X_Main body (empty = {0}_takeTrigger(me);)", c.name)),
           bound(c, "main", { area: true, rows: 3, ph: `${c.name}_takeTrigger(me);` }));
  P.append(h("label", {}, _t("Operations (call them as Class_op(me, …))")));
  c.operations.forEach((o, i) => {
    P.append(h("div", { class: "card" },
      h("div", { class: "row" }, bound(o, "ret", { cls: "code", ph: "void" }),
        bound(o, "name", { cls: "code", ph: "name" }),
        h("button", { class: "del", on: { click: () => { snapshot(); c.operations.splice(i, 1); refreshAll(); } } }, "✕")),
      (() => { const x = bound({ v: argsText(o.args) }, "v", { cls: "code", ph: "int a, int b" });
               x.addEventListener("input", () => { o.args = parseArgs(x.value); save(); }); return x; })(),
      bound(o, "body", { area: true, rows: 3, ph: _t("body (variables as me->name)") })));
  });
  P.append(h("button", { class: "mini", on: { click: () => {
    snapshot(); c.operations.push({ name: "op" + c.operations.length, ret: "void", args: [], body: "" }); refreshAll();
  } } }, "+ operation"));
  tbl("Associations (link name / target class)", c.assocs, [["name", "itsX", "50%"], ["class", "Class", "50%"]],
      () => ({ name: "its" + (project.classes.find((x) => x !== c) || c).name, class: (project.classes.find((x) => x !== c) || c).name }));
  P.append(h("label", {}, _t("Initializer code (runs in X_Init before startBehavior)")), bound(c, "init", { area: true, rows: 2 }));
  P.append(h("p", { class: "help" },
    _t("Drawing: make boxes with the state tool (S), drag between states with the transition tool (T), mark the start with the default transition (D). "),
    _t("A composite state is a state drawn inside a bigger one. Generate C shows the code, Build checks it for compiler errors and warnings.")));
}

// ------------------------------------------------------------------ left panel
function refreshLeft() {
  $("pkgName").value = project.package || "";
  const ul = $("classList");
  ul.textContent = "";
  project.classes.forEach((c, i) => {
    const li = h("li", { class: i === cur ? "on" : "" }, h("span", {}, c.name),
      h("span", { class: "x", title: _t("Delete class"), on: { click: (ev) => {
        ev.stopPropagation();
        if (project.classes.length === 1) return flash(_t("There must be at least one class"));
        if (!confirm(_t("Delete class '{0}'?", c.name))) return;
        snapshot(); project.classes.splice(i, 1); cur = 0; sel = null; refreshAll(); zoomFit();
      } } }, "✕"));
    li.addEventListener("click", () => {
      const switching = cur !== i;
      cur = i; sel = { t: "class" }; refreshAll();
      if (switching) zoomFit();
    });
    ul.append(li);
  });
  $("types").value = (project.types || []).join("\n");
  // variables of the class on the canvas, in four groups; the group is the direction, so a row is
  // just  type / name / initial value / delete, and + in a group's title adds a variable to it
  const c = cls();
  c.attributes = c.attributes || [];
  $("varOwner").textContent = project.classes.length > 1 ? "· " + c.name : "";
  const vl = $("varList");
  vl.textContent = "";
  if (!$("typelist")) { const dl = h("datalist", { id: "typelist" }); for (const t of TYPES) dl.append(h("option", { value: t })); document.body.append(dl); }
  const GROUPS = [["in", _t("Input"), _t("input = X_Main parameter i_name"), _t("goes into X_Main")],
                  ["out", _t("Output"), _t("output = the return value (one) or o_name pointers (several)"), _t("comes out of X_Main")],
                  ["config", _t("Config"), _t("config = X_Init parameter c_name, set once"), _t("fixed value, set in X_Init")],
                  ["local", _t("Internal"), _t("internal = struct member (counters, state data)"), _t("your own data: counters, flags")]];
  // column names, so a first-time reader knows which box is which
  vl.append(h("div", { class: "vhead" }, h("span", { title: _t("the C type, e.g. bool, uint8_t, uint16_t, int") }, _t("Type")),
    h("span", { title: _t("the name you use in guards and actions") }, _t("Name")),
    h("span", { title: _t("the value it starts with (a config value is the value main.c passes to X_Init)") }, _t("Initial")), h("span")));
  for (const [dir, title, tip, sub] of GROUPS) {
    const mine = c.attributes.map((a, i) => [a, i]).filter(([a]) => (a.dir || "local") === dir);
    vl.append(h("div", { class: "vgroup " + dir, title: tip },
      h("span", { class: "vtitle" }, title, mine.length ? h("span", { class: "vcount" }, ` ${mine.length}`) : null),
      h("span", { class: "vsub" }, sub),
      h("button", { class: "mini", "data-addvar": dir, title: _t("Add to {0}", title), on: { click: () => addVariable(dir) } }, "+")));
    for (const [a, i] of mine) {
      const typ = bound(a, "type", { cls: "code vtype", ph: "int", onchange: validate });
      typ.setAttribute("list", "typelist");
      const nm = bound(a, "name", { cls: "code vname", ph: "name", onchange: validate });
      if (typeof scWatchName === "function") scWatchName(nm, () => a.name, (o, n) => scRenameVar(c.name, o, n));       // scenarios follow a renamed variable
      const prob = varProblem(c, a, i);
      if (prob) { nm.classList.add("bad"); nm.title = prob; }
      vl.append(h("div", { class: "vrow" }, typ, nm,
        bound(a, "default", { cls: "code vinit", ph: (a.type || "").trim() === "bool" ? "false" : "0", title: _t("initial value") }),
        h("button", { class: "del", title: _t("Delete variable"), on: { click: () => { snapshot(); c.attributes.splice(i, 1); refreshAll(); } } }, "✕")));
    }
  }
}
const DEFAULT_DECL = { in: ["bool", "false"], out: ["bool", "false"], config: ["uint16_t", "0u"], local: ["int", "0"] };
function addVariable(dir) {
  const c = cls();
  snapshot();
  c.attributes = c.attributes || [];
  const used = new Set(c.attributes.map((a) => a.name));
  const stem = { in: "in", out: "out", config: "cfg", local: "var" }[dir] || "var";
  let k = c.attributes.filter((a) => a.dir === dir).length; while (used.has(stem + k)) k++;
  const [type, def] = DEFAULT_DECL[dir] || DEFAULT_DECL.local;
  c.attributes.push({ type, name: stem + k, default: def, dir });
  refreshAll();
  const rows = $("varList").querySelectorAll(`.vgroup.${dir} ~ .vrow`);
  const mine = [...c.attributes.keys()].filter((i) => c.attributes[i].dir === dir).length;
  const all = [...$("varList").children];
  const start = all.findIndex((el) => el.classList.contains("vgroup") && el.classList.contains(dir));
  const inputs = [];
  for (let x = start + 1; x < all.length && !all[x].classList.contains("vgroup"); x++) inputs.push(all[x].querySelector("input.vname"));
  const last = inputs[inputs.length - 1];
  if (last) { last.focus(); last.select(); }
}
$("pkgName").addEventListener("input", (ev) => { project.package = ev.target.value; save(); });
$("types").addEventListener("change", (ev) => { snapshot(); project.types = ev.target.value.split("\n").filter((s) => s.trim()); save(); });
$("addClass").addEventListener("click", () => {
  snapshot();
  const used = new Set(project.classes.map((c) => c.name));
  let k = project.classes.length; while (used.has("Class" + k)) k++;
  project.classes.push({ name: "Class" + k, attributes: [], operations: [], assocs: [], init: "", chart: { nodes: {}, edges: {} } });
  cur = project.classes.length - 1; sel = null; refreshAll(); zoomFit();
});
function refreshAll() { refreshLeft(); refreshProps(); render(); validate(); save(); }

// ------------------------------------------------------------------ structure checks
/* Mistakes in the drawing that make the generated C do something other than what the picture shows.
   Each problem is [kind, message, {c, t, id} target, confirm]; confirm = ask before Generate / Build. */
function structureProblems(c) {
  const N = (c.chart || {}).nodes || {}, E = (c.chart || {}).edges || {};
  const out = [];
  const add = (kind, msg, t, id, confirmIt) => out.push([kind, msg, { c: c.name, t, id }, !!confirmIt]);
  const ins = {}, outs = {};
  for (const e of Object.values(E)) {
    if (!N[e.from] || !N[e.to]) { add("err", _t("{0}: a transition has a missing end", c.name), "edge", e.id, false); continue; }
    (outs[e.from] = outs[e.from] || []).push(e);
    (ins[e.to] = ins[e.to] || []).push(e);
  }
  const nm = (n) => !n ? "?" : isState(n) ? n.name : { cond: "C", junction: "J", hist: "H", term: "⊗", init: "●" }[n.kind];
  const KIND = { cond: _t("condition connector (C)"), junction: _t("junction (J)"), hist: _t("history connector (H)"), term: _t("termination connector (⊗)") };
  const free = (e) => { const g = (e.guard || "").trim(); return !g || g === "else"; };
  for (const n of Object.values(N)) {
    const nin = (ins[n.id] || []).length, nout = (outs[n.id] || []).length;
    if (n.kind === "init" && !nout) add("warn", _t("{0}: a default transition (●) points nowhere", c.name), "node", n.id, true);
    if (KIND[n.kind]) {
      if (!nin && !nout) add("warn", _t("{0}: the {1} is not connected to anything", c.name, KIND[n.kind]), "node", n.id, true);
      else if (!nin) add("warn", _t("{0}: nothing leads into the {1}, so it is never used", c.name, KIND[n.kind]), "node", n.id, true);
      else if (!nout && (n.kind === "cond" || n.kind === "junction"))
        add("warn", _t("{0}: the {1} has no outgoing transition — the transitions entering it would go nowhere", c.name, KIND[n.kind]), "node", n.id, true);
    }
    if (n.kind === "term" && nout) add("warn", _t("{0}: nothing can leave a termination connector", c.name), "node", n.id, true);
    if (n.kind === "cond" && nin && nout) {
      const o = outs[n.id];
      if (o.length === 1) add("warn", _t("{0}: a condition connector needs at least two branches (a [guard] and an [else])", c.name), "node", n.id, true);
      else {
        if (o.filter(free).length > 1) add("warn", _t("{0}: two branches of a condition connector have no guard — only the first can be taken", c.name), "node", n.id, true);
        if (!o.some(free)) add("warn", _t("{0}: the condition connector has no [else] branch — when no guard is true nothing happens", c.name), "node", n.id, false);
      }
    }
  }
  // two transitions of one source with the same guard: the later one can never fire
  const bySrc = {};
  for (const e of Object.values(E)) if (N[e.from] && N[e.from].kind !== "init") (bySrc[e.from] = bySrc[e.from] || []).push(e);
  for (const [src, list] of Object.entries(bySrc)) {
    const ordered = outgoingOrdered(src, E, N);
    const seen = new Map();
    for (const e of ordered) {
      const g = (e.guard || "").trim().replace(/\s+/g, " ") || "else";
      const key = g;
      if (seen.has(key) && g !== "else")
        add("warn", _t("{0}: the transition {1} → {2} [{3}] can never fire — an earlier transition from '{1}' has the same guard", c.name, nm(N[src]), nm(N[e.to]), g), "edge", e.id, true);
      else if (!seen.has(key)) seen.set(key, e);
    }
  }
  // states that can never be entered: walk from the default transitions
  const tops = Object.values(N).filter((n) => n.kind === "init" && !n.parent);
  if (tops.length && Object.values(N).some(isState)) {
    // enter(id, byDefault): the state / connector is active; its parents are too (deep entry), its
    // outgoing transitions are live, and when entered by default a composite also starts its
    // default arrows (every region of an AND state), a history connector may restore any substate
    const reach = new Set(), started = new Set();
    const enter = (id, byDefault) => {
      const n = N[id];
      if (!n) return;
      if (!reach.has(id)) {
        reach.add(id);
        if (n.parent) enter(n.parent, false);
        for (const e of outs[id] || []) enter(e.to, true);
      }
      if (byDefault && !started.has(id)) {
        started.add(id);
        if (isState(n)) { for (const k of Object.values(N)) if (k.parent === id && k.kind === "init") for (const e of outs[k.id] || []) enter(e.to, true); }
        else if (n.kind === "hist") { for (const k of Object.values(N)) if (k.parent === n.parent && isState(k)) enter(k.id, true); }
      }
    };
    for (const t of tops) for (const e of outs[t.id] || []) enter(e.to, true);
    for (const n of Object.values(N)) if (isState(n) && !reach.has(n.id))
      add("warn", _t("{0}: state '{1}' can never be entered (no transition or default arrow leads to it)", c.name, n.name), "node", n.id, true);
    // a state that is never left: nothing leaves it or any of its parents
    for (const n of Object.values(N)) {
      if (!isState(n) || !reach.has(n.id) || Object.values(N).some((k) => k.parent === n.id && isState(k))) continue;
      let p = n, leaves = false;
      while (p && !leaves) { leaves = (outs[p.id] || []).length > 0; p = N[p.parent]; }
      if (!leaves && Object.values(N).filter(isState).length > 1)
        add("warn", _t("{0}: once entered, state '{1}' is never left (no transition leaves it or its parents)", c.name, n.name), "node", n.id, false);
    }
  }
  return out;
}

// ------------------------------------------------------------------ validation
const C_KEYWORDS = new Set(("auto break case char const continue default do double else enum extern float for goto if " +
  "inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void " +
  "volatile while _Bool _Complex _Imaginary bool true false NULL").split(" "));
/* same naming rules as the server (model.py check_names) */
function nameProblem(name, keywordOk) {
  if (!IDENT.test(name || "")) return _t("letters, digits and _ only, not starting with a digit");
  if (!keywordOk && C_KEYWORDS.has(name)) return _t("a C keyword");
  return "";
}
function validate() {
  const probs = [];
  const bad = (what, name, keywordOk) => { const m = nameProblem(name, keywordOk); if (m) probs.push(["err", `${what} '${name}': ${m}`]); };
  bad(_t("Package name"), project.package);
  const cnames = new Set();
  for (const c of project.classes) {
    bad(_t("Class"), c.name);
    if (cnames.has(c.name)) probs.push(["err", _t("Class name '{0}' is used twice", c.name)]);
    cnames.add(c.name);
    { const n = mainArgs(c).ps.length;
      if (c.ioStyle !== "struct" && n > ARG_REGS)
        probs.push(["warn", _t("{0}_Main has {1} arguments: on ARM more than {2} go on the stack — choose 'X_Main arguments: structs' in the class card", c.name, n, ARG_REGS)]); }
    const N = (c.chart || {}).nodes || {}, E = (c.chart || {}).edges || {};
    (c.attributes || []).forEach((a, i) => {
      const m = varProblem(c, a, i);
      if (m) probs.push(["err", _t("{0}, variable '{1}': {2}", c.name, a.name, m)]);
      if (a.dir === "in" && !m && !varUses(c, a.name)) probs.push(["warn", _t("{0}: no guard or action reads the input '{1}'", c.name, a.name)]);
    });
    const seen = new Map();
    for (const n of Object.values(N)) {
      if (n.kind !== "state") continue;
      { const m = nameProblem(n.name, true); if (m) probs.push(["err", _t("{0}, state '{1}': {2}", c.name, n.name, m)]); }
      if (c.ioStyle === "struct" && (n.name === "In" || n.name === "Out"))
        probs.push(["err", _t("{0}, state '{1}': clashes with the struct type {0}_{1}", c.name, n.name)]);
      if (seen.has(n.name)) probs.push(["warn", _t("{0}: state name '{1}' is used twice (the C names get the parent's name)", c.name, n.name)]);
      seen.set(n.name, n);
    }
    // containers needing a default transition
    const conts = [{ id: null, name: "(top level)", region: null }];
    for (const n of Object.values(N)) if (n.kind === "state") {
      if (n.and) (n.regions || []).forEach((r, i) => conts.push({ id: n.id, region: i, name: `${n.name}/${r.name}` }));
      else conts.push({ id: n.id, region: null, name: n.name });
    }
    for (const k of conts) {
      const inside = Object.values(N).filter((n) => (n.parent || null) === k.id && (k.region == null || (n.region || 0) === k.region));
      const st = inside.filter((n) => n.kind === "state");
      const ini = inside.filter((n) => n.kind === "init");
      if (st.length && !ini.length && !(k.id && N[k.id] && N[k.id].and && k.region == null))
        probs.push([st.length > 1 || k.id === null ? "err" : "warn", _t("{0}: '{1}' has no default transition (●→)", c.name, k.name)]);
      if (ini.length > 1) probs.push(["warn", _t("{0}: '{1}' has {2} default transitions", c.name, k.name, ini.length)]);
    }
    for (const x of Object.values(E).concat(Object.values(N).flatMap((n) => n.reactions || [])))
      if (/^tm\s*\(/.test((x.trigger || "").trim())) probs.push(["err", _t("{0}: there is no tm() — count with a variable (entry/ cnt = 0; reaction/ cnt++; [cnt >= 50u])", c.name)]);
    for (const e of Object.values(E)) {
      const t0 = (e.trigger || "").trim();
      if (t0 && !/^tm\s*\(/.test(t0)) probs.push(["warn", _t("{0}: event '{1}' becomes an input variable", c.name, t0)]);
      if (/params->/.test((e.guard || "") + (e.action || ""))) probs.push(["err", _t("{0}: there is no params-> (event arguments) — use input variables", c.name)]);
      const src = N[e.from];
      if (src && src.kind !== "init" && isFree(e)) {
        const free = outgoingOrdered(e.from, E, N).filter(isFree);
        if (free.length > 1 && free[0] !== e)
          probs.push(["warn", _t("{0}: '{1}' has {2} transitions without a guard — only the first can fire, the rest (→ {3}) never do", c.name, src.name || src.kind, free.length, (N[e.to] || {}).name || "?")]);
      }
      if (src && src.kind === "cond" && !(e.guard || "").trim())
        probs.push(["warn", _t("{0}: a transition leaving a condition connector has no guard (taken as else)", c.name)]);
    }
  }
  for (const c of project.classes) for (const p of structureProblems(c)) probs.push(p);
  lastProblems = probs;
  // mark the elements of the class on screen
  const nm2 = { node: {}, edge: {} };
  for (const p of probs) {
    const tg = p[2];
    if (!tg || tg.c !== cls().name) continue;
    const m = nm2[tg.t];
    if (m[tg.id] !== "err") m[tg.id] = p[0] === "err" ? "err" : (m[tg.id] || "warn");
  }
  const changed = JSON.stringify(nm2) !== JSON.stringify(marks);
  marks = nm2;
  const ul = $("problems");
  ul.textContent = "";
  const all = probs.concat((lastGen && lastGen.warnings || []).map((w) => ["warn", "generator: " + w]),
                          buildErrors.map((w) => [/warning/i.test(w) ? "warn" : "err", "build: " + w]));
  if (!all.length) ul.append(h("li", { class: "ok" }, _t("No problems")));
  for (const [k, m, tg] of all) {
    const li = h("li", { class: k + (tg ? " jump" : "") }, m);
    if (tg) {            // click = select the element and bring it to the middle of the canvas
      li.title = _t("Click to show it in the drawing");
      li.addEventListener("click", () => showElement(tg));
    }
    ul.append(li);
  }
  const errs = probs.filter((p) => p[0] === "err").length;
  $("probCount").textContent = all.length ? `(${all.length})` : "";
  $("probCount").className = probs.some((p) => p[0] === "err") ? "bad" : probs.some((p) => p[3]) ? "defect" : "";
  if (changed && typeof render === "function" && $("world")) render();
  return errs;
}
let lastProblems = [];
/* problems that would make the generated code differ from the drawing */
function defects() { return lastProblems.filter((p) => p[3]); }
function confirmDefects(verb) {
  const d = defects();
  if (!d.length) return true;
  const list = d.slice(0, 8).map((p) => "• " + p[1]).join("\n") + (d.length > 8 ? "\n• …" : "");
  const ok = confirm(_t("The statechart has {0} problem(s) — the generated C will not do what the drawing shows:\n\n{1}\n\n{2} anyway?", d.length, list, verb));
  if (!ok) { showTab("problems"); const first = d.find((p) => p[2]); if (first) showElement(first[2]); }
  return ok;
}
function showElement(tg) {
  const ci = project.classes.findIndex((c) => c.name === tg.c);
  if (ci < 0) return;
  if (ci !== cur) { cur = ci; refreshAll(); }
  const n = tg.t === "node" ? nodes()[tg.id] : null, e = tg.t === "edge" ? edges()[tg.id] : null;
  sel = { t: tg.t, id: tg.id };
  refreshProps(); render();
  let p = null;
  if (n) p = center(n);
  else if (e && nodes()[e.from] && nodes()[e.to]) p = edgeGeom(e, nodes()[e.from], nodes()[e.to]).mid;
  if (p) {                // put it in the middle of the visible canvas
    const r = svg.getBoundingClientRect();
    view.x = r.width / 2 - p.x * view.k; view.y = r.height / 2 - p.y * view.k; applyView();
  }
}

// ------------------------------------------------------------------ variables / X_Main signature
/* Every variable has a direction: input (X_Main parameter i_x, latched into me->x), output (return
   value when there is one, o_x pointers when there are several), config (X_Init parameter c_x) or internal. */
const TYPES = ["bool", "uint8_t", "int8_t", "uint16_t", "int16_t", "uint32_t", "int32_t", "float", "int"];
const RESERVED_SUFFIX = /_(subState|lastState)$/;
function isNumType(t) { t = (t || "").trim(); return !/\*/.test(t) && t !== "bool"; }
function varUses(c, name) {
  if (!IDENT.test(name || "")) return 0;
  const re = new RegExp(`\\b${name}\\b`);
  let n = 0;
  const N = (c.chart || {}).nodes || {}, E = (c.chart || {}).edges || {};
  for (const e of Object.values(E)) if (re.test(e.guard || "") || re.test(e.action || "") || re.test(e.trigger || "")) n++;
  for (const x of Object.values(N)) {
    if (re.test(x.entry || "") || re.test(x.exit || "")) n++;
    for (const r of x.reactions || []) if (re.test(r.guard || "") || re.test(r.action || "") || re.test(r.trigger || "")) n++;
  }
  if (re.test(c.main || "") || re.test(c.init || "")) n++;
  for (const o of c.operations || []) if (re.test(o.body || "")) n++;
  return n;
}
function varProblem(c, a, i) {
  const m = nameProblem(a.name);
  if (m) return m;
  if (["ric_reactive", "me", "dummy_"].includes(a.name) || RESERVED_SUFFIX.test(a.name)) return _t("a name the generated code uses itself");
  if ((c.attributes || []).findIndex((x) => x.name === a.name) !== i) return _t("the name is used twice");
  if (!(a.type || "").trim()) return _t("the type is empty");
  if (c.ioStyle === "struct" && (a.name === "in" || a.name === "out")) return _t("with struct arguments 'in' / 'out' are X_Main's parameter names");
  return "";
}
/* X_Main's arguments: parameter style (i_ / return / o_) or struct style (X_In / X_Out) */
function mainArgs(c) {
  const at = c.attributes || [];
  const ins = at.filter((a) => a.dir === "in"), outs = at.filter((a) => a.dir === "out");
  if (c.ioStyle === "struct")
    return { ret: "void", ps: [`${c.name}* const me`, ...(ins.length ? [`const ${c.name}_In* const in`] : []),
                                ...(outs.length ? [`${c.name}_Out* const out`] : [])], ins, outs };
  const ps = [`${c.name}* const me`, ...ins.map((a) => `${a.type} i_${a.name}`)];
  if (outs.length > 1) ps.push(...outs.map((a) => `${a.type}* const o_${a.name}`));
  return { ret: outs.length === 1 ? outs[0].type : "void", ps, ins, outs };
}
function mainSignature(c) { const m = mainArgs(c); return `${m.ret} ${c.name}_Main(${m.ps.join(", ")});`; }
function sigPreviewText(c) {
  const m = mainArgs(c), L = [];
  if (c.ioStyle === "struct") {
    if (m.ins.length) L.push(`typedef struct { ${m.ins.map((a) => `${a.type} ${a.name};`).join(" ")} } ${c.name}_In;`);
    if (m.outs.length) L.push(`typedef struct { ${m.outs.map((a) => `${a.type} ${a.name};`).join(" ")} } ${c.name}_Out;`);
  }
  const cfg = (c.attributes || []).filter((x) => x.dir === "config").map((x) => `, ${x.type} c_${x.name}`).join("");
  return L.concat([`void ${c.name}_Init(${c.name}* const me${cfg});`, mainSignature(c)]).join("\n");
}
const ARG_REGS = 4;                  // ARM AAPCS: the first 4 arguments travel in registers
function argHint(c) {
  const n = mainArgs(c).ps.length;
  if (c.ioStyle === "struct") return [_t("arguments: {0} (struct pointers)", n), false];
  return n > ARG_REGS ? [_t("arguments: {0} — more than {1} go on the stack; struct arguments recommended", n, ARG_REGS), true] : [_t("arguments: {0}", n), false];
}
// ------------------------------------------------------------------ code view
const KW = /\b(if|else|switch|case|default|break|return|for|while|do|static|const|struct|typedef|enum|union|sizeof|extern|void)\b/;
const TY = /\b(int|char|short|long|unsigned|float|double|bool|u?int(?:8|16|32|64)_t|size_t)\b/;
function highlight(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(^[ \t]*#[^\n]*)|\b(\d+[uUlL]*)\b|([A-Za-z_]\w*)/gm;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const s = esc(m[0]);
    if (m[1]) out += `<span class="cm">${s}</span>`;
    else if (m[2]) out += `<span class="st">${s}</span>`;
    else if (m[3]) out += `<span class="pp">${s}</span>`;
    else if (m[4]) out += `<span class="nu">${s}</span>`;
    else if (KW.test(m[5]) && m[5].match(KW)[0] === m[5]) out += `<span class="kw">${s}</span>`;
    else if (TY.test(m[5]) && m[5].match(TY)[0] === m[5]) out += `<span class="ty">${s}</span>`;
    else out += s;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}
/* which group a generated file belongs to, and a one-line explanation for beginners */
function fileKind(n) {
  if (n === "main.c") return "example";
  return "mine";
}
function fileHelp(n, pkg) {
  const k = fileKind(n);
  if (k === "example") return typeof project.mainC === "string"
    ? _t("main.c — your edited version (saved in the project, not regenerated when the chart changes).")
    : _t("main.c — example: X_Init() once (config values as arguments), X_Main() from the 10 ms task. Press Edit to adapt it to your board.");
  if (n === pkg + ".h" && !project.classes.some((c) => c.name === pkg)) return _t("My statechart: the types (#include) the classes share.");
  return n.endsWith(".h") ? _t("My statechart: state enum, struct (inputs, outputs, config, variables, states), X_Init / X_Main / X_isIn") :
                            _t("My statechart: X_Init (once) → X_Main (every 10 ms) → X_takeTrigger() runs the internal reactions, then at most one transition. No framework: put this .c/.h pair into the MCU project.");
}
function clearCode() {
  curFile = null;
  $("fileTabs").textContent = "";
  $("fileNote").textContent = ""; $("fileNote").className = "fnote";
  $("codeEdit").hidden = true; $("code").hidden = false;
  $("code").innerHTML = '<span class="dim" data-i18n>Press Generate C to see the generated code here.</span>';
  if (typeof applyLanguage === "function") applyLanguage();
}
function showFiles(gen) {
  lastGen = gen;
  const ft = $("fileTabs");
  ft.textContent = "";
  const names = Object.keys(gen.files).sort((a, b) => a.localeCompare(b));
  const groups = [["mine", _t("My statechart")], ["example", _t("Example")]];
  if (!names.includes(curFile)) curFile = names.find((n) => n === cls().name + ".c") || names[0];
  for (const [k, title] of groups) {
    const files = names.filter((n) => fileKind(n) === k);
    if (!files.length) continue;
    const g = h("div", { class: "fgroup" }, h("span", { class: "glabel" }, title));
    for (const n of files) g.append(fileBtn(n, gen));
    ft.append(g);
  }
  const note = $("fileNote");
  note.textContent = curFile ? fileHelp(curFile, gen.pkg) : "";
  note.className = curFile ? "fnote " + fileKind(curFile) : "fnote";
  const editing = curFile === "main.c" && typeof project.mainC === "string";
  if (curFile === "main.c") {
    note.append(editing
      ? h("button", { class: "mini", on: { click: () => {
          if (!confirm(_t("Drop your edited main.c and go back to the generated one?"))) return;
          snapshot(); delete project.mainC; save(); generateC(); } } }, _t("Back to generated"))
      : h("button", { class: "mini", on: { click: () => {
          snapshot(); project.mainC = gen.files["main.c"]; save(); showFiles(gen); $("codeEdit").focus(); } } }, _t("✎ Edit")));
  }
  $("codeEdit").hidden = !editing;
  $("code").hidden = editing;
  if (editing) { if ($("codeEdit").value !== project.mainC) $("codeEdit").value = project.mainC; }
  else $("code").innerHTML = curFile ? highlight(gen.files[curFile]) : "";
  validate();
}
function fileBtn(n, gen) {
  return h("button", { class: n === curFile ? "on" : "", title: fileHelp(n, gen.pkg),
                       on: { click: () => { curFile = n; showFiles(gen); } } }, n);
}
(() => {
  let snapped = false;
  $("codeEdit").addEventListener("focus", () => { snapped = false; });
  $("codeEdit").addEventListener("input", () => {
    if (!snapped) { snapshot(); snapped = true; }
    project.mainC = $("codeEdit").value;
    if (lastGen) lastGen.files["main.c"] = project.mainC;
    save();
  });
  $("codeEdit").addEventListener("keydown", (ev) => {     // Tab inserts spaces instead of leaving the editor
    if (ev.key !== "Tab") return;
    ev.preventDefault();
    const t = ev.target, a = t.selectionStart;
    t.setRangeText("    ", a, t.selectionEnd, "end");
    t.dispatchEvent(new Event("input"));
  });
})();
$("copyCode").addEventListener("click", () => {
  if (lastGen && curFile) navigator.clipboard.writeText(lastGen.files[curFile]);
});
$("dlCode").addEventListener("click", () => {
  if (lastGen && curFile) downloadText(curFile, lastGen.files[curFile]);
});

const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
function setBottom(open) {
  if (open && isPhone()) $("right").hidden = true;          // phone: the code panel covers the screen, the properties sheet goes away
  $("bottom").classList.toggle("closed", !open);
  $("splitter").classList.toggle("closed", !open);
  $("bottomToggle").textContent = open ? "▾" : "▴";
}
function showTab(name) {
  document.querySelectorAll("#tabs button[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  setBottom(true);
  if (name === "code") requestAnimationFrame(followCode);

}
document.querySelectorAll("#tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("bottomToggle").addEventListener("click", () => setBottom($("bottom").classList.contains("closed")));
/* drag the edge of the left panel to resize it (double-click = back to 260 px); remembered */
(() => {
  const MIN = 200, MAX = 640, DEF = 260;
  const set = (w) => {
    w = Math.max(MIN, Math.min(MAX, Math.round(w)));
    document.documentElement.style.setProperty("--left-w", w + "px");
    return w;
  };
  try { set(+localStorage.getItem("scstudio.leftW") || DEF); } catch (e) { set(DEF); }
  const bar = $("leftResize");
  let drag = null;
  bar.addEventListener("pointerdown", (ev) => { drag = { x: ev.clientX, w: $("left").offsetWidth }; bar.setPointerCapture(ev.pointerId); bar.classList.add("on"); });
  bar.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    set(drag.w + ev.clientX - drag.x);
    keepCanvasStill();
  });
  const end = () => {
    if (!drag) return;
    drag = null; bar.classList.remove("on");
    try { localStorage.setItem("scstudio.leftW", String($("left").offsetWidth)); } catch (e) { /* ignore */ }
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("dblclick", () => { set(DEF); keepCanvasStill(); try { localStorage.removeItem("scstudio.leftW"); } catch (e) { /* ignore */ } });
})();
$("leftToggle").addEventListener("click", () => {
  const c = $("left").classList.toggle("collapsed");
  $("leftToggle").textContent = c ? "›" : "‹";
  $("leftResize").hidden = c;
  keepCanvasStill();
});
if (window.matchMedia("(max-width: 760px)").matches) { $("leftToggle").click(); requestAnimationFrame(zoomFit); }   // phones: drawer closed, drawing fitted


// ------------------------------------------------------------------ code follows the selection
/* When the generated code is on screen, selecting a state or a transition scrolls the code
   to the part generated from it and marks those lines. */
let editVersion = 0;                 // bumped on every edit (snapshot) - tells when the code is stale
const indentOf = (l) => l.length - l.trimStart().length;
function edgeTraceLabel(e) {
  const N = nodes(), a = N[e.from], b = N[e.to];
  const nm = (n) => !n ? "?" : isState(n) ? n.name : n.kind === "hist" ? `${(N[n.parent] || {}).name}.H`
    : n.kind === "cond" ? "cond" : n.kind;
  if (a.kind === "init") {
    const p = a.parent && N[a.parent];
    if (!p) return `ROOT>${nm(b)}`;
    if (p.and) {                                   // inside an AND state the owner is the region
      const r = (p.regions || [])[a.region || 0];
      return `${(r && (r.name || "").trim()) || `${p.name}_r${a.region || 0}`}>${nm(b)}`;
    }
    return `${p.name}>${nm(b)}`;
  }
  return `${nm(a)}>${nm(b)}`;
}
/* lines [start, end] of `file` that came from the current selection */
function locateSelection(gen) {
  if (!sel || sel.t === "class" || sel.t === "note") return null;
  const file = cls().name + ".c", src = gen.files[file];
  if (!src) return null;
  const L = src.split("\n");
  const dispatch = L.findIndex((l) => (l.startsWith("static int handleEvent(") || l.startsWith("static RiCTakeEventStatus rootState_dispatchEvent(") || l.startsWith("static bool rootState_dispatch(")) && l.trimEnd().endsWith("{"));
  const isTrace = (l, lbl) => l.includes(`TRACE("${lbl}")`) || l.includes(`RIC_TR_TRANS, "${lbl}"`) || l.includes(`/*## transition ${lbl} */`);
  const blockEnd = (i) => {                       // a line ... up to where its indentation closes
    const ind = indentOf(L[i]);
    let j = i + 1;
    while (j < L.length && (L[j].trim() === "" || indentOf(L[j]) > ind)) j++;
    return j < L.length && L[j].trim().startsWith("}") && indentOf(L[j]) === ind ? j : j - 1;
  };
  if (sel.t === "node") {
    const n = nodes()[sel.id];
    if (!isState(n)) return null;
    const caseLine = `case ${cls().name}_${n.name}:`;
    let i = dispatch >= 0 ? L.findIndex((l, k) => k > dispatch && l.trim() === caseLine) : -1;
    if (i >= 0) {                                 // the state's case: up to the next case/default
      const ind = indentOf(L[i]);
      let j = i + 1;
      while (j < L.length && !(indentOf(L[j]) === ind && /^(case |default:)/.test(L[j].trim()))) j++;
      return { file, start: i, end: j - 1 };
    }
    i = L.findIndex((l) => l.startsWith(`static void ${n.name}_entDef(`) && l.trimEnd().endsWith("{"));
    if (i >= 0) return { file, start: i, end: blockEnd(i) };
    i = L.findIndex((l) => l.includes(`/*#[ state ${n.name}.(Entry) */`));
    if (i >= 0) return { file, start: i, end: L.findIndex((l, k) => k > i && l.includes("/*#]*/")) };
    i = L.findIndex((l) => l.includes(`RIC_TR_ENTER, "${n.name}"`));
    return i >= 0 ? { file, start: i, end: i } : null;
  }
  const e = edges()[sel.id];
  if (!e) return null;
  const N = nodes(), from = N[e.from];
  // a branch leaving a condition connector / junction: find its [guard] (or the else part)
  if (from && (from.kind === "cond" || from.kind === "junction")) {
    const g = (e.guard || "").trim();
    let i = -1;
    if (g && g !== "else") i = L.findIndex((l) => { const t = l.trim(); return t === `if (${g}) {` || t === `else if (${g}) {`; });
    else {
      const into = Object.values(edges()).find((x) => x.to === from.id);
      const lbl = into ? edgeTraceLabel(into) : null;
      const hits = L.map((l, k) => (lbl && isTrace(l, lbl) ? k : -1)).filter((k) => k >= 0);
      if (hits.length) { i = hits[hits.length - 1]; while (i > 0 && !L[i].trim().startsWith("else")) i--; }
    }
    return i >= 0 ? { file, start: i, end: blockEnd(i) } : null;
  }
  const lbl = edgeTraceLabel(e);
  const hits = L.map((l, k) => (isTrace(l, lbl) ? k : -1)).filter((k) => k >= 0);
  if (!hits.length) return null;
  // the `if (guard) {` line that opens a transition: the first line above the trace marker
  // with less indentation
  const opener = (t) => {
    let i = t;
    const ind = indentOf(L[t]);
    while (i > 0) {
      i--;
      if (L[i].trim() !== "" && indentOf(L[i]) < ind) return i;
    }
    return t;
  };
  // several transitions with the same label (A>B [x], A>B [y]): tell them apart by the guard,
  // compared without me->, spaces and parentheses
  const norm = (x) => x.replace(/me->/g, "").replace(/[\s()]/g, "");
  const g = (e.guard || "").trim();
  const pick = hits.find((t) => {
    const o = L[opener(t)].trim();
    if (g && g !== "else") return /^(else )?if /.test(o) && norm(o).includes(norm(g));
    return /^(else )?\{$/.test(o);
  }) ?? hits[0];
  const start = opener(pick);
  if (/^static /.test(L[start]) || /^case /.test(L[start].trim())) return { file, start: pick, end: pick };
  return { file, start, end: blockEnd(start) };
}
let followBusy = false;
async function followCode() {
  if (followBusy || !lastGen || $("bottom").classList.contains("closed") || !$("tab-code").classList.contains("on")) return;
  if (!sel || sel.t === "class" || sel.t === "note") return;
  followBusy = true;
  try {
    if (lastGen.version !== editVersion) {          // the drawing changed: regenerate quietly
      if (validate()) return;
      const sig = projSig();
      const g = await api("/api/generate", project);
      g.version = editVersion; genSig = sig;
      showFiles(g);
      paintButtons();
    }
    const loc = locateSelection(lastGen);
    if (!loc) return;
    curFile = loc.file;
    showFiles(lastGen);
    markCode(loc.start, loc.end);
  } catch (e) { /* code view is a convenience; never block editing */ }
  finally { followBusy = false; }
}
function markCode(start, end) {
  const pre = $("code");
  if (pre.hidden) return;
  pre.querySelectorAll(".codemark").forEach((m) => m.remove());
  const cs = getComputedStyle(pre);
  const lh = parseFloat(cs.lineHeight) || 18, top = parseFloat(cs.paddingTop) || 8;
  const m = document.createElement("div");
  m.className = "codemark";
  m.style.top = (top + start * lh) + "px";
  m.style.height = ((end - start + 1) * lh) + "px";
  pre.prepend(m);
  pre.scrollTop = Math.max(0, top + start * lh - pre.clientHeight * 0.25);
}

// ------------------------------------------------------------------ server calls
let serverMode = null;          // true: Python server answers /api; false: GitHub Pages (Pyodide + wasm clang)
async function api(path, body) {
  if (serverMode === null) serverMode = await Backend.available();
  if (!serverMode) {
    if (path === "/api/generate") return Backend.generate(body);
    if (path === "/api/build") return Backend.build(body);
  }
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" },
                                                         body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
async function generateC() {
  autoDeclareEvents();
  if (validate()) { showTab("problems"); flash(_t("Fix the errors in the Problems tab first")); return null; }
  if (!confirmDefects(_t("Generate"))) return null;
  const sig = projSig();
  genBusy = true; paintButtons();
  try {
    const g = await api("/api/generate", project);
    g.version = editVersion;
    genSig = sig;
    showFiles(g); showTab("code");
    requestAnimationFrame(followCode);
    return g;
  } catch (e) { alert(_t("Generation failed: ") + e.message); return null; }
  finally { genBusy = false; paintButtons(); }
}
$("bGen").addEventListener("click", generateC);
$("bZip").addEventListener("click", async () => {
  const g = await generateC();
  if (!g) return;
  if (serverMode) { location.href = "/api/zip?pkg=" + encodeURIComponent(g.pkg); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await Backend.zip(project));
  a.download = g.pkg + "_c.zip"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------ build
/* Build = generate + compile every .c (MSVC /W4). Errors and warnings go to the Problems tab. */
let building = false;
async function build() {
  if (building) return false;
  autoDeclareEvents();
  if (validate()) { showTab("problems"); flash(_t("Fix the errors in the Problems tab first")); return false; }
  if (!confirmDefects(_t("Build"))) return false;
  building = true;
  const sig = projSig();
  buildBusy = true; buildSig = null; paintButtons();
  try {
    const b = await api("/api/build", project);
    if (sig !== projSig()) return false;          // another project (or an edit) arrived while compiling: this result is not for what is on screen
    b.version = editVersion;
    showFiles(b);
    buildErrors = b.log.split("\n").filter((l) => l.trim());
    validate();
    buildSig = sig; genSig = sig;                       // Build also produced the code on screen
    buildState = !b.ok ? "fail" : buildErrors.length ? "warn" : "ok";
    if (!b.ok) { showTab("problems"); flash(_t("Build failed — see the Problems tab")); }
    else if (buildErrors.length) { showTab("problems"); flash(_t("Built with warnings — see the Problems tab"), true); }
    else flash(_t(serverMode ? "Built — no warnings (/W4)" : "Built — no warnings (clang, C89)"), true);
    return b.ok;
  } catch (e) { flash(_t("Build failed: ") + e.message); return false; }
  finally { building = false; buildBusy = false; paintButtons(); }
}
$("bCompile").addEventListener("click", build);
/* a project is opened already generated and built (green buttons, code on screen, Scenario tab unlocked):
   an example, and the saved work at start. Quiet: a drawing with errors or defects is left alone (no dialogs),
   and only with the local server - in the browser-only build the wasm compiler would be downloaded first */
async function autoBuild() {
  try {
    if (serverMode === null) serverMode = await Backend.available();
    if (!serverMode) return;
    while (building) await new Promise((r) => setTimeout(r, 150));         // a build of the previous drawing is still running: let it end first
    if (scenarioReady()) return;                                           // this drawing is already built
    if (!project.classes.some((c) => Object.values((c.chart || {}).nodes || {}).some(isState))) return;     // nothing drawn yet
    autoDeclareEvents();
    if (validate() || defects().length) return;
    if (await build() && buildState === "ok" && !isPhone()) showTab("code");        // show the generated code (a phone keeps the drawing)
  } catch (e) { /* the Build button reports problems when pressed */ }
}


// ------------------------------------------------------------------ files
function downloadText(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function downloadProject() { downloadText((project.package || "statechart") + ".json", JSON.stringify(project, null, 1)); }
function loadProject(p) {
  if (!p || !Array.isArray(p.classes)) { alert(_t("Not a project file")); return; }
  snapshot();
  project = p;
  project.events = project.events || []; project.types = project.types || [];

  for (const c of project.classes) {
    c.chart = c.chart || { nodes: {}, edges: {} };
    for (const [id, n] of Object.entries(c.chart.nodes)) n.id = id;
    for (const [id, e] of Object.entries(c.chart.edges)) e.id = id;
    for (const [id, t] of Object.entries(c.chart.notes || {})) t.id = id;
    migrateClass(c);                   // old projects: event triggers -> inputs, tm() -> counters
  }
  delete project.periodUs; delete project.utTest;
  cur = 0; sel = null; lastGen = null; buildErrors = []; genSig = buildSig = null;
  clearCode();                         // the code pane must not keep showing the previous project

  refreshAll(); zoomFit();
}
$("bNew").addEventListener("click", (ev) => { ev.stopPropagation(); $("newMenu").hidden = !$("newMenu").hidden; });
document.addEventListener("click", () => { $("newMenu").hidden = true; });
document.querySelectorAll("#newMenu button").forEach((b) => b.addEventListener("click", async () => {
  $("newMenu").hidden = true;
  try {
    if (b.dataset.new === "blank") { loadProject(blankProject()); return; }
    else loadProject(await (await fetch(`examples/${b.dataset.new}.json`)).json());
    flash(_t("Ctrl+Z brings the previous project back"), true);
    autoBuild();
  } catch (e) { alert(e.message); }
}));
$("bSave").addEventListener("click", downloadProject);
$("bOpen").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try { loadProject(JSON.parse(await f.text())); } catch (e) { alert(_t("Open failed: ") + e.message); }
  ev.target.value = "";
});
// bottom panel splitter
(() => {
  const sp = $("splitter"), bottom = $("bottom");
  let y0 = null, h0 = 0;
  sp.addEventListener("pointerdown", (ev) => { y0 = ev.clientY; h0 = bottom.offsetHeight; sp.setPointerCapture(ev.pointerId); });
  sp.addEventListener("pointermove", (ev) => { if (y0 != null) bottom.style.height = Math.max(80, Math.min(innerHeight - 200, h0 - (ev.clientY - y0))) + "px"; });
  sp.addEventListener("pointerup", () => { y0 = null; });
})();

document.querySelectorAll("#tools button[data-tool]").forEach((b) => {
  b.addEventListener("click", () => setTool(b.dataset.tool));
  b.addEventListener("dblclick", () => {            // double-click a tool = keep it (draw many in a row); Esc / V ends it
    if (b.dataset.tool === "select") return;
    setTool(b.dataset.tool); stickyTool = true; setTool(tool);
    flash(_t("Tool kept: draw as many as you like. Esc ends it"), true);
  });
});
$("zoomFit").addEventListener("click", zoomFit);
$("propsClose").addEventListener("click", () => { sel = null; refreshProps(); render(); svg.focus(); });
$("optimize").addEventListener("click", () => {
  if (!Object.values(nodes()).some(isState)) return flash(_t("No states to tidy"));
  snapshot();
  const was = Object.fromEntries(Object.values(nodes()).map((n) => [n.id, { x: n.x, y: n.y }]));
  const anch = Object.values(edges()).map((e) => [e, e.sa, e.ta]);
  for (const [e] of anch) { e.sa = e.ta = null; }                // Tidy routes the lines itself
  const r = window.optimizeLayout(nodes(), edges());
  if (!r.changed) for (const [e, sa, ta] of anch) { e.sa = sa; e.ta = ta; }
  if (!r.changed) { undoStack.pop(); return flash(_t("The current layout is already tidier — nothing changed"), true); }
  for (const t of Object.values(notes())) {                     // a note stays at the same place beside its state
    const a = was[t.attach], b = nodes()[t.attach];
    if (a && b) { t.x += b.x - a.x; t.y += b.y - a.y; }
  }
  save(); render(); zoomFit();
  tidySig = projSig(); paintButtons();
  const b = r.before, a = r.after;
  flash(_t("Tidied — lines through states {0}→{1}, crossings {2}→{3}, label overlaps {4}→{5} (Ctrl+Z to undo)",
          b.through, a.through, b.crossings, a.crossings, b.labelHits, a.labelHits), true);
});
$("untidy").addEventListener("click", () => {
  if (!tidySig || tidySig !== projSig()) return;
  tidySig = null;
  undo();                                  // the snapshot Tidy took is the layout before it
  zoomFit();
  flash(_t("Back to the layout before Tidy (Ctrl+Y to tidy again)"), true);
});

// ------------------------------------------------------------------ boot
/* EN / 한국어: the static page is translated by i18n.js, the panels are drawn again with _t() */
$("bTour").addEventListener("click", startTour);
$("bLang").addEventListener("click", () => {
  setLanguage(LANG === "ko" ? "en" : "ko");
  refreshAll();
  if (lastGen) showFiles(lastGen);
  setTool(tool);
});

(async function boot() {
  applyLanguage();
  let p = null, firstVisit = false;
  try { p = JSON.parse(localStorage.getItem("scstudio.project") || "null"); } catch (e) { p = null; }
  try { firstVisit = !localStorage.getItem("scstudio.welcomed"); } catch (e) { firstVisit = true; }
  if (!p) {
    try { p = await (await fetch("examples/blink.json")).json(); } catch (e) { p = blankProject(); }
  }
  project = p;
  loadProject(p);
  autoBuild();                                   // whatever is on screen at start (example or the saved work) is built, if it can be
  undoStack.length = 0;
  setTool("select");
  requestAnimationFrame(() => { lastCanvasLeft = svg.getBoundingClientRect().left; zoomFit(); });
  if (firstVisit) welcomeNewVisitor();
})();

/* First visit: a short guided tour (spotlight + card). The "?" button in the top bar starts it again. */
const TOUR = [
  { sel: "#bNew", t: "Start from an example", b: "New ▾ has ready-made examples, easiest first. LED blink is open now - you are looking at a working statechart." },
  { sel: "#world", t: "This is a statechart", b: "Boxes are states, arrows are transitions, ●→ marks the state that starts first. Here LED_OFF turns into LED_ON when the counter reaches blinkTicks, and back again.", pad: 18 },
  { sel: "#tools", t: "Draw with these tools", b: "▭ state, → transition, ●→ default transition. Faster: point at a state and pull from its outline, or double-click empty space for a new state. Esc / V goes back to Select." },
  { sel: "#left", t: "Variables", b: "INPUT comes in from outside (a button), OUTPUT goes out (an LED), CONFIG is a fixed setting, INTERNAL is the chart's own memory such as counters. In guards and actions just write the name.", phone: false },
  { sel: "#bGen", t: "Generate C", b: "Turns the drawing into C code (X.c / X.h). Change the drawing and press it again." },
  { sel: "#bCompile", t: "Build", b: "Compiles that C code right here in your browser and lists warnings and errors in Problems. Nothing is sent to a server." },
  { sel: "#bSave", t: "Keep your work", b: "Your drawing stays in this browser. Save stores it as a file on your computer; Open loads it back." },
];
let tourStep = 0, tourOn = false;
function startTour() {
  if (tourOn) return;
  tourOn = true; tourStep = 0;
  $("newMenu").hidden = true;
  const ov = h("div", { id: "tour" }), hole = h("div", { id: "tourHole" }), card = h("div", { id: "tourCard" });
  ov.append(hole, card);
  document.body.append(ov);
  const steps = () => TOUR.filter((s) => !(isPhone() && s.phone === false) && document.querySelector(s.sel) && document.querySelector(s.sel).getBoundingClientRect().width > 0);
  const end = () => {
    tourOn = false; ov.remove(); $("bNew").classList.remove("pulse");
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", show);
    try { localStorage.setItem("scstudio.welcomed", "1"); } catch (e) { /* ignore */ }
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); end(); }
    else if (ev.key === "ArrowRight" || ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); go(1); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); ev.stopPropagation(); go(-1); }
  };
  const go = (d) => { const n = steps().length; if (tourStep + d >= n) return end(); tourStep = Math.max(0, tourStep + d); show(); };
  function show() {
    const list = steps(), s = list[Math.min(tourStep, list.length - 1)];
    if (!s) return end();
    const el = document.querySelector(s.sel);
    let r = el.getBoundingClientRect();
    if (s.sel === "#world") {                          // the drawing: its real extent, kept inside the canvas
      const c = $("center").getBoundingClientRect();
      r = { left: Math.max(r.left, c.left + 8), top: Math.max(r.top, c.top + 8), right: Math.min(r.right, c.right - 8), bottom: Math.min(r.bottom, c.bottom - 8) };
    }
    const pad = s.pad || 6;
    Object.assign(hole.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.right - r.left + 2 * pad + "px", height: r.bottom - r.top + 2 * pad + "px" });
    card.textContent = "";
    const last = tourStep >= list.length - 1;
    card.append(
      h("div", { class: "tstep" }, `${tourStep + 1} / ${list.length}`),
      h("div", { class: "ttitle" }, _t(s.t)),
      h("div", { class: "tbody" }, _t(s.b)),
      h("div", { class: "tbtns" },
        h("button", { class: "tskip", on: { click: end } }, last ? "" : _t("Skip")),
        tourStep > 0 ? h("button", { on: { click: () => go(-1) } }, _t("Back")) : null,
        h("button", { class: "primary", on: { click: () => go(1) } }, last ? _t("Start drawing") : _t("Next"))));
    const cw = Math.min(320, window.innerWidth - 24), ch = card.offsetHeight || 170;
    card.style.width = cw + "px";
    let top = r.bottom + pad + 12;
    if (top + ch > window.innerHeight - 8) top = Math.max(8, r.top - pad - 12 - ch);
    if (top + ch > window.innerHeight - 8 || top < 8) top = Math.max(8, window.innerHeight - ch - 12);      // big target: card inside it, low
    const left = Math.min(Math.max(8, r.left + (r.right - r.left) / 2 - cw / 2), window.innerWidth - cw - 8);
    Object.assign(card.style, { left: left + "px", top: top + "px" });
    card.querySelector(".primary").focus({ preventScroll: true });
  }
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", show);
  show();
}
function welcomeNewVisitor() {
  try { if (localStorage.getItem("scstudio.welcomed")) return; } catch (e) { /* no storage: show it every time */ }
  $("bNew").classList.add("pulse");
  setTimeout(startTour, 400);
}

// ------------------------------------------------------------------ hover help
/* Every control's title becomes a quick tooltip (the native one appears late and is easy to miss). */
(() => {
  const tip = document.createElement("div");
  tip.id = "tip"; tip.hidden = true;
  document.body.append(tip);
  let timer = null, cur = null;
  const hide = () => { clearTimeout(timer); tip.hidden = true; cur = null; };
  document.addEventListener("mouseover", (ev) => {
    const t = ev.target.closest && ev.target.closest("[title],[data-tip]");
    if (!t || t === cur || t instanceof SVGElement) return;
    if (t.hasAttribute("title")) { t.dataset.tip = t.getAttribute("title"); t.removeAttribute("title"); }
    if (!t.dataset.tip) return;
    hide(); cur = t;
    timer = setTimeout(() => {
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const r = t.getBoundingClientRect(), w = tip.offsetWidth, hgt = tip.offsetHeight;
      let x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      let y = r.bottom + 6;
      if (t.closest(".menu")) { x = Math.min(r.right + 10, innerWidth - w - 8); y = r.top; }   // don't cover the next items
      if (y + hgt > innerHeight - 8) y = r.top - hgt - 6;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    }, 300);
  });
  document.addEventListener("mouseout", (ev) => { if (cur && !cur.contains(ev.relatedTarget)) hide(); });
  document.addEventListener("pointerdown", hide);
})();
