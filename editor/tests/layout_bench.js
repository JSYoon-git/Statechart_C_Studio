// How good is Tidy (static/layout.js) on charts that are NOT tiny?
//   node editor/tests/layout_bench.js [path/to/layout.js]     (default: static/layout.js)
//
// 30 seeded random charts (8-20 states, composite states, if / J / H / end connectors,
// self loops and back edges) are scrambled and tidied. Reported per size class: the average of
//   through   transitions that run through a state they do not touch
//   crossings pairs of transitions that cross
//   labels    label boxes that overlap a state or another label
//   score     the combined score (lower = better; see metrics() in layout.js)
// plus the run time. Exit code 1 when a hard rule is broken (a state outside its parent,
// overlapping siblings, changed parents) - the quality numbers are for comparing versions.
"use strict";
const fs = require("fs"), path = require("path");
const file = process.argv[2] || path.join(__dirname, "..", "static", "layout.js");
global.window = {};
eval(fs.readFileSync(file, "utf8"));
const optimize = window.optimizeLayout, metrics = window.layoutMetrics;
const NAME_H = 22;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function randomChart(seed, nStates) {
  const r = rng(seed);
  const N = {}, E = {};
  let eid = 0;
  const edge = (from, to, guard) => { E["e" + eid] = { id: "e" + eid, from, to, trigger: "", guard: guard || "", action: "", bend: 0 }; eid++; };
  const state = (id, parent, region) => { N[id] = { id, kind: "state", name: id, x: 0, y: 0, w: 140, h: 60, parent: parent || null, region: region || 0, entry: "cnt = 0;", exit: "", reactions: [] }; return id; };
  const pseudo = (id, kind, parent) => { N[id] = { id, kind, x: 0, y: 0, parent: parent || null, region: 0 }; return id; };
  // ~ a quarter of the states live inside 1-2 composite states
  const comps = [];
  const nComp = nStates >= 12 ? 2 : nStates >= 9 ? 1 : 0;
  const tops = [], inner = {};
  for (let i = 0; i < nComp; i++) { const c = state("C" + i); comps.push(c); tops.push(c); inner[c] = []; }
  const per = Math.max(2, Math.floor(nStates / 4));
  let made = 0;
  for (const c of comps) for (let k = 0; k < per; k++) { inner[c].push(state(`${c}_s${k}`, c)); made++; }
  let k = 0;
  while (made + nComp < nStates) { tops.push(state("S" + k++)); made++; }
  // default arrows and a connected skeleton
  pseudo("i0", "init"); edge("i0", tops[0]);
  for (const c of comps) { pseudo("i_" + c, "init", c); edge("i_" + c, inner[c][0]); for (let j = 0; j + 1 < inner[c].length; j++) edge(inner[c][j], inner[c][j + 1], "a" + j + " == true"); }
  for (let j = 0; j + 1 < tops.length; j++) edge(tops[j], tops[j + 1], "go" + j + " == true");
  // extra transitions: back edges, skips, self loops, between composites' children
  const all = Object.keys(N).filter((id) => N[id].kind === "state");
  const extra = Math.round(nStates * 0.9);
  for (let j = 0; j < extra; j++) {
    const a = all[Math.floor(r() * all.length)], b = all[Math.floor(r() * all.length)];
    if (a === b && r() < 0.6) continue;
    if (N[a].parent && N[b].parent && N[a].parent !== N[b].parent && r() < 0.7) continue;
    edge(a, b, "x" + j + " == true");
  }
  // connectors
  if (nStates >= 10) {
    pseudo("cd", "cond"); const t = tops[Math.floor(r() * tops.length)], u = tops[Math.floor(r() * tops.length)];
    edge(tops[0], "cd", "pick == true"); edge("cd", t, "ok == true"); edge("cd", u, "else");
    pseudo("jn", "junction"); edge(tops[1 % tops.length], "jn", "m == true"); edge("jn", tops[tops.length - 1], "");
  }
  if (comps.length) { pseudo("hh", "hist", comps[0]); edge(tops[tops.length - 1], "hh", "back == true"); }
  pseudo("te", "term"); edge(tops[tops.length - 1], "te", "stop == true");
  // scramble: a worst-case start
  let q = 0;
  for (const n of Object.values(N)) { n.x = 40 + Math.floor(r() * 300); n.y = 40 + Math.floor(r() * 240); q++; }
  return { N, E };
}

function hardRules(N) {
  const bad = [];
  const isState = (n) => n && n.kind === "state";
  for (const n of Object.values(N)) {
    const p = N[n.parent];
    if (!p) continue;
    const b = isState(n) ? { x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h } : { x0: n.x - 6, y0: n.y - 6, x1: n.x + 6, y1: n.y + 6 };
    if (b.x0 < p.x || b.x1 > p.x + p.w || b.y0 < p.y + NAME_H || b.y1 > p.y + p.h) bad.push(`${n.id} sticks out of ${p.id}`);
  }
  const st = Object.values(N).filter(isState);
  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
    const a = st[i], b = st[j];
    if (a.parent !== b.parent) continue;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push(`${a.id} overlaps ${b.id}`);
  }
  return bad;
}

const classes = [[8, 10], [12, 10], [16, 6], [20, 4]];
let total = { n: 0, through: 0, crossings: 0, labels: 0, score: 0, ms: 0 }, hard = 0;
console.log(`layout: ${path.relative(process.cwd(), file)}\n`);
console.log("states  charts  through  crossings  labels   score   ms/chart");
for (const [ns, count] of classes) {
  const a = { through: 0, crossings: 0, labels: 0, score: 0, ms: 0 };
  for (let i = 0; i < count; i++) {
    const { N, E } = randomChart(1000 * ns + i, ns);
    const parents = JSON.stringify(Object.values(N).map((n) => [n.id, n.parent, n.region]));
    const t0 = Date.now();
    optimize(N, E);
    a.ms += Date.now() - t0;
    const m = metrics(N, E);
    a.through += m.through; a.crossings += m.crossings; a.labels += m.labelHits; a.score += m.score;
    const bad = hardRules(N);
    if (bad.length || parents !== JSON.stringify(Object.values(N).map((n) => [n.id, n.parent, n.region]))) { hard++; console.log("  HARD", ns, i, bad.slice(0, 3).join("; ")); }
  }
  for (const k of Object.keys(a)) total[k] += a[k];
  total.n += count;
  const f = (x) => (x / count).toFixed(1).padStart(7);
  console.log(`${String(ns).padStart(5)}  ${String(count).padStart(6)}  ${f(a.through)}  ${f(a.crossings)}   ${f(a.labels)}  ${f(a.score)}   ${(a.ms / count).toFixed(0).padStart(5)}`);
}
const g = (x) => (x / total.n).toFixed(1);
console.log(`\nall ${total.n} charts: through ${g(total.through)}  crossings ${g(total.crossings)}  labels ${g(total.labels)}  score ${g(total.score)}  ${(total.ms / total.n).toFixed(0)} ms/chart`);
process.exit(hard ? 1 : 0);
