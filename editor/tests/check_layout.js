// Applies static/layout.js to every example and checks the result.
//   node editor/tests/check_layout.js [outDir]
// Writes the optimized projects to outDir (default: a temp dir) so the simulation
// tests can be run on them too:  EXAMPLES_DIR=<outDir> python editor/tests/test_examples.py
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const here = __dirname;
global.window = {};
eval(fs.readFileSync(path.join(here, "..", "static", "layout.js"), "utf8"));
const MESSY = process.env.MESSY === "1";      // scramble positions first: a worst-case start
const optimize = window.optimizeLayout;
const exDir = path.join(here, "..", "static", "examples");
const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "sc_layout_"));
const NAME_H = 22;

let failures = 0;
for (const fn of fs.readdirSync(exDir).filter((f) => f.endsWith(".json")).sort()) {
  const project = JSON.parse(fs.readFileSync(path.join(exDir, fn), "utf8"));
  const problems = [];
  for (const c of project.classes) {
    const N = c.chart.nodes, E = c.chart.edges;
    for (const [id, n] of Object.entries(N)) n.id = id;
    for (const [id, e] of Object.entries(E)) e.id = id;
    if (MESSY) {          // pile everything up near the origin, keeping parents' boxes around children
      let k = 0;
      for (const n of Object.values(N)) { n.x = 40 + (k * 37) % 300; n.y = 40 + (k * 53) % 200; k++; }
      for (const e of Object.values(E)) { e.bend = 0; delete e.lx; delete e.ly; }
    }
    const before = JSON.stringify(Object.values(N).map((n) => [n.id, n.parent, n.region || 0]));
    const r = optimize(N, E);
    console.log(`     ${c.name.padEnd(13)} ${r.changed ? "정리" : "유지"}  관통 ${r.before.through}→${r.after.through}  교차 ${r.before.crossings}→${r.after.crossings}  라벨겹침 ${r.before.labelHits}→${r.after.labelHits}  점수 ${r.before.score}→${r.after.score}`);
    if (r.after.through) problems.push(`${c.name}: ${r.after.through} transition(s) still run through a state`);
    const after = JSON.stringify(Object.values(N).map((n) => [n.id, n.parent, n.region || 0]));
    if (before !== after) problems.push(`${c.name}: parents/regions changed`);
    const st = Object.values(N).filter((n) => n.kind === "state");
    const isState = (n) => n && n.kind === "state";
    // inside parent (and inside the right AND region band)
    for (const n of Object.values(N)) {
      const p = N[n.parent];
      if (!p) continue;
      const b = isState(n) ? { x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h } : { x0: n.x - 6, y0: n.y - 6, x1: n.x + 6, y1: n.y + 6 };
      let top = p.y + NAME_H, bot = p.y + p.h;
      if (p.and) {
        const R = Math.max(2, (p.regions || []).length), hh = (p.h - NAME_H) / R;
        top = p.y + NAME_H + (n.region || 0) * hh; bot = top + hh;
      }
      if (b.x0 < p.x || b.x1 > p.x + p.w || b.y0 < top || b.y1 > bot)
        problems.push(`${c.name}: '${n.name || n.kind}' sticks out of '${p.name}'`);
    }
    // siblings don't overlap
    for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
      const a = st[i], b = st[j];
      if (a.parent !== b.parent || (a.region || 0) !== (b.region || 0)) continue;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        problems.push(`${c.name}: '${a.name}' overlaps '${b.name}'`);
    }
    // transitions don't run through unrelated leaf states
    const center = (n) => isState(n) ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: n.x, y: n.y };
    const anc = (n) => { const s = new Set(); while (n) { s.add(n.id); n = N[n.parent]; } return s; };
    for (const e of Object.values(E)) {
      const a = N[e.from], b = N[e.to];
      if (!a || !b || a === b) continue;
      const skip = new Set([...anc(a), ...anc(b)]);
      const ca = center(a), cb = center(b), dx = cb.x - ca.x, dy = cb.y - ca.y, L = Math.hypot(dx, dy) || 1;
      const cx = (ca.x + cb.x) / 2 - dy / L * (e.bend || 0) * 2, cy = (ca.y + cb.y) / 2 + dx / L * (e.bend || 0) * 2;
      for (const o of st) {
        if (skip.has(o.id) || st.some((k) => k.parent === o.id) || anc(o).has(a.id) || anc(o).has(b.id)) continue;
        let hit = false;
        const inEnd = (x, y, n) => n.kind === "state" && x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h;
        for (let k = 2; k <= 18 && !hit; k++) {
          const t = k / 20, u = 1 - t;
          const x = u * u * ca.x + 2 * u * t * cx + t * t * cb.x, y = u * u * ca.y + 2 * u * t * cy + t * t * cb.y;
          if (inEnd(x, y, a) || inEnd(x, y, b)) continue;     // hidden: lines stop at the end shapes' borders
          hit = x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h;
        }
        if (hit) problems.push(`${c.name}: transition ${a.name || a.kind}->${b.name || b.kind} runs through '${o.name}'`);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, fn), JSON.stringify(project, null, 1));
  console.log(`${problems.length ? "FAIL" : "ok  "} ${fn}`);
  problems.forEach((p) => console.log("   " + p));
  failures += problems.length ? 1 : 0;
}
console.log(`\noptimized projects written to ${outDir}`);
process.exit(failures ? 1 : 0);
