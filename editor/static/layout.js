/* Statechart auto layout ("Optimize").

   Each container (the top level, every composite state, every AND region) is laid out
   on its own, innermost first, so a composite state grows to fit what is inside it:
     1. columns  - states are put in columns by how many transitions they are from the
                   state the default transition (●→) enters, so the chart reads left to right
     2. rows     - inside a column, states are ordered to keep transitions short
                   (barycenter sweeps)
     3. spacing  - the gap between two columns is wide enough for the transition labels
                   crossing it
   Afterwards every transition that would run through another state gets bent around it,
   and two transitions between the same pair of states bow apart.

   Only positions, sizes and bends change - never parents, regions or labels - so the
   generated code stays the same. Several variants are laid out and scored (states crossed,
   transition crossings, label overlaps, aspect ratio); the best one wins, and the user's own
   drawing is kept if it already scores better. Exposes window.optimizeLayout(nodes, edges).  */
(function () {
  "use strict";
  const NAME_H = 22;          // state name compartment (must match editor.js)
  const PAD = 26;             // inner padding of a composite state
  const INIT_MARGIN = 46;     // room on the left for a default-transition dot
  const ROW_GAP = 56;
  const MIN_COL_GAP = 110, MAX_COL_GAP = 330;
  const BAND_GAP = 90;        // vertical room between wrapped rows (for labels)
  const PSEUDO = { init: 12, cond: 24, junction: 12, hist: 22, term: 20 };

  /* one layout pass; opts.maxCols = wrap width, opts.flip = reverse the order of
     same-column states (a different starting point for the row ordering) */
  function layoutOnce(N, E, opts) {
    const maxCols = opts.maxCols;
    const isState = (n) => n && n.kind === "state";
    const kids = {};                                   // container key -> member ids
    const keyOf = (n) => {
      const p = n.parent && N[n.parent];
      if (p && p.and) return p.id + "#" + (n.region || 0);
      return p ? p.id : "root";
    };
    for (const n of Object.values(N)) (kids[keyOf(n)] = kids[keyOf(n)] || []).push(n.id);
    const label = (e) => {
      let s = (e.trigger || "").trim();
      if ((e.guard || "").trim()) s += "[" + e.guard.trim() + "]";
      if ((e.action || "").trim()) s += "/" + e.action.trim().replace(/\s*\n\s*/g, " ");
      return Math.min(s.length, 46);
    };
    /* the member of container `key` that contains node id (or null) */
    const lift = (id, key) => {
      let n = N[id];
      while (n) {
        if (keyOf(n) === key) return n.id;
        n = n.parent && N[n.parent];
      }
      return null;
    };

    const rel = {};      // id -> position relative to its container's content origin
    const size = {};     // id -> {w, h}
    const regionH = {};  // AND state id -> height of each region

    function leafSize(n) {
      const lines = [(n.entry || "").trim() && 1, (n.exit || "").trim() && 1].filter(Boolean).length +
        (n.reactions || []).length;
      return { w: Math.max(150, n.name.length * 9 + 40), h: lines > 1 ? 74 : 60 };
    }

    function measure(id) {
      const n = N[id];
      if (!isState(n)) return { w: PSEUDO[n.kind] || 16, h: PSEUDO[n.kind] || 16 };
      const minW = Math.max(150, n.name.length * 9 + 60);
      if (n.and) {
        const R = Math.max(2, (n.regions || []).length);
        const inner = [];
        for (let i = 0; i < R; i++) inner.push(layout(id + "#" + i));
        const rh = Math.max(...inner.map((b) => b.h)) + 2 * PAD + 10;
        regionH[id] = rh;
        return { w: Math.max(minW, Math.max(...inner.map((b) => b.w)) + 2 * PAD), h: NAME_H + R * rh };
      }
      if ((kids[id] || []).length) {
        const inner = layout(id);
        return { w: Math.max(minW, inner.w + 2 * PAD), h: NAME_H + inner.h + 2 * PAD };
      }
      return leafSize(n);
    }

    /* lay out the members of one container; returns the content size */
    function layout(key) {
      const all = kids[key] || [];
      const inits = all.filter((id) => N[id].kind === "init");
      const hists = all.filter((id) => N[id].kind === "hist");
      // keep the user's reading order as the tie breaker
      const mem = all.filter((id) => !inits.includes(id) && !hists.includes(id))
        .sort((a, b) => (N[a].y - N[b].y) || (N[a].x - N[b].x));
      for (const id of mem) size[id] = measure(id);
      if (!mem.length) {
        const h = hists.length ? 40 : 0;
        hists.forEach((id) => { rel[id] = { x: 14, y: 14 }; });
        return { w: hists.length ? 60 : 0, h };
      }
      // graph between members (transitions between descendants count for their members)
      const out = {}, adj = {};
      mem.forEach((id) => { out[id] = []; adj[id] = new Set(); });
      for (const e of Object.values(E)) {
        if (N[e.from] && N[e.from].kind === "init") continue;
        const a = lift(e.from, key), b = lift(e.to, key);
        if (!a || !b || a === b || !(a in out) || !(b in out)) continue;
        out[a].push(b);
        adj[a].add(b); adj[b].add(a);
      }
      // 1. columns: BFS distance from where the default transition goes
      const initTarget = inits.map((i) => Object.values(E).find((e) => e.from === i))
        .map((e) => e && lift(e.to, key)).find((id) => id && id in out);
      const col = {}, order = [];
      const bfs = (start) => {
        col[start] = 0; order.push(start);
        const q = [start];
        while (q.length) {
          const a = q.shift();
          for (const b of out[a]) if (!(b in col)) { col[b] = col[a] + 1; order.push(b); q.push(b); }
        }
      };
      if (opts.layer === "lp") {
        // longest path over the chart without its back edges (found by DFS): every state sits
        // after all the states that lead to it, so loops close as one long edge going back
        const start = initTarget || mem[0], state = {}, fwd = {};
        mem.forEach((id) => { fwd[id] = []; });
        const dfs = (a) => {
          state[a] = 1;
          for (const b of out[a]) {
            if (state[b] === 1) continue;                 // back edge: dropped
            fwd[a].push(b);
            if (!state[b]) dfs(b);
          }
          state[a] = 2;
        };
        dfs(start);
        col[start] = 0; order.push(start);
        const topo = [], seen = {};
        const visit = (a) => { seen[a] = 1; for (const b of fwd[a]) if (!seen[b]) visit(b); topo.push(a); };
        visit(start);
        topo.reverse();
        for (const a of topo) for (const b of fwd[a]) col[b] = Math.max(col[b] === undefined ? 0 : col[b], col[a] + 1);
        for (const a of topo) if (a !== start) order.push(a);
        order.sort((x, y) => col[x] - col[y]);
      } else bfs(initTarget || mem[0]);
      for (const id of mem) if (!(id in col)) {
        // not reachable from the start: put it next to a neighbour that has a column
        const nb = [...adj[id]].find((x) => x in col);
        if (nb !== undefined) { col[id] = col[nb] + 1; order.push(id); } else bfs(id);
      }
      const ncol = Math.max(...mem.map((id) => col[id])) + 1;
      const cols = Array.from({ length: ncol }, () => []);
      for (const id of order) if (!cols[col[id]].includes(id)) cols[col[id]].push(id);
      if (opts.flip) cols.forEach((c) => c.reverse());
      // 2. rows: barycenter sweeps
      const pos = () => { const p = {}; cols.forEach((c) => c.forEach((id, i) => { p[id] = i; })); return p; };
      for (let it = 0; it < 6; it++) {
        const p = pos();
        const range = it % 2 ? [...cols.keys()].reverse() : [...cols.keys()];
        for (const c of range) {
          const bary = (id) => {
            const ns = [...adj[id]].filter((x) => Math.abs(col[x] - c) === 1);
            return ns.length ? ns.reduce((s, x) => s + p[x], 0) / ns.length : p[id];
          };
          cols[c].sort((a, b) => bary(a) - bary(b));
        }
      }
      // 2b. local search on the row order: swap / move states inside their column while the
      //     (cheap, abstract) cost - crossings, long vertical jumps, lines through states - drops
      const pairs = [];
      for (const a of mem) for (const b of out[a]) if (a !== b && col[a] !== col[b]) pairs.push([a, b]);
      const cost = () => {
        const yy = {};
        cols.forEach((c, ci) => c.forEach((id, i) => { yy[id] = i - (c.length - 1) / 2; }));
        let s = 0;
        const seg = pairs.map(([a, b]) => ({ a, b, p: { x: col[a], y: yy[a] }, q: { x: col[b], y: yy[b] } }));
        for (const g of seg) {
          s += 0.6 * Math.abs(g.p.y - g.q.y);
          const lo = Math.min(col[g.a], col[g.b]), hi = Math.max(col[g.a], col[g.b]);
          for (let c = lo + 1; c < hi; c++) {              // long edge: does it pass through a state in between?
            const t = (c - g.p.x) / (g.q.x - g.p.x), y = g.p.y + t * (g.q.y - g.p.y);
            if (cols[c].some((id) => Math.abs(yy[id] - y) < 0.6)) s += 12;
          }
        }
        for (let i = 0; i < seg.length; i++) for (let j = i + 1; j < seg.length; j++) {
          const u = seg[i], v = seg[j];
          if (u.a === v.a || u.a === v.b || u.b === v.a || u.b === v.b) continue;
          if (segCross(u.p, u.q, v.p, v.q)) s += 10;
        }
        return s;
      };
      if (pairs.length > 2 && mem.length <= 40) {
        let cur = cost();
        for (let pass = 0; pass < 8; pass++) {
          let improved = false;
          for (const c of cols) {
            for (let i = 0; i < c.length; i++) {
              const [id] = c.splice(i, 1);
              let bestAt = i, bestCost = Infinity;
              for (let k = 0; k <= c.length; k++) {
                c.splice(k, 0, id);
                const v = cost() + (k === i ? -1e-6 : 0);  // prefer staying put on ties
                if (v < bestCost) { bestCost = v; bestAt = k; }
                c.splice(k, 1);
              }
              c.splice(bestAt, 0, id);
              if (bestCost < cur - 1e-9) { cur = bestCost; improved = true; }
            }
          }
          if (!improved) break;
        }
      }
      // 3. spacing
      const gap = [];
      for (let c = 0; c < ncol - 1; c++) {
        let longest = 0;
        for (const e of Object.values(E)) {
          const a = lift(e.from, key), b = lift(e.to, key);
          if (a in col && b in col && Math.min(col[a], col[b]) === c && Math.max(col[a], col[b]) === c + 1)
            longest = Math.max(longest, label(e));
        }
        gap.push(Math.max(MIN_COL_GAP, Math.min(MAX_COL_GAP, longest * 6.6 + 40)));
      }
      const colW = cols.map((c) => Math.max(...c.map((id) => size[id].w)));
      const colH = cols.map((c) => c.reduce((s, id) => s + size[id].h, 0) + ROW_GAP * (c.length - 1));
      const left = inits.length ? INIT_MARGIN : 0;
      // long flows wrap after MAX_COLS columns; every other band runs right-to-left (zigzag),
      // so consecutive columns stay next to each other and cycles close into a loop
      const bands = [];
      for (let i = 0; i < ncol; i += maxCols) bands.push(cols.map((_, k) => k).slice(i, i + maxCols));
      const bandW = bands.map((b) => b.reduce((s, c, j) => s + colW[c] + (j < b.length - 1 ? gap[c] : 0), 0));
      const W = Math.max(...bandW);
      const putColumn = (ci, x, y0, bh) => {
        let y = y0 + (bh - colH[ci]) / 2;
        for (const id of cols[ci]) {
          const s = size[id];
          const cx = x + (colW[ci] - s.w) / 2;
          rel[id] = isState(N[id]) ? { x: cx, y } : { x: cx + s.w / 2, y: y + s.h / 2 };
          y += s.h + ROW_GAP;
        }
      };
      let y0 = 0;
      bands.forEach((b, bi) => {
        const bh = Math.max(...b.map((c) => colH[c]));
        if (bi % 2 === 0) {
          let x = left;
          for (const c of b) { putColumn(c, x, y0, bh); x += colW[c] + (gap[c] || 0); }
        } else {
          let x = left + W;
          for (const c of b) { x -= colW[c]; putColumn(c, x, y0, bh); x -= gap[c] || 0; }
        }
        y0 += bh + BAND_GAP;
      });
      const H = y0 - BAND_GAP;
      const x = left + W;
      // default-transition dots sit just left of the state they enter
      for (const i of inits) {
        const e = Object.values(E).find((x) => x.from === i);
        const t = e && lift(e.to, key);
        if (t && rel[t]) {
          const s = size[t];
          const cy = isState(N[t]) ? rel[t].y + Math.min(s.h / 2, 30) : rel[t].y;
          rel[i] = { x: (isState(N[t]) ? rel[t].x : rel[t].x - s.w / 2) - 30, y: cy };
        } else rel[i] = { x: 10, y: 10 };
      }
      let h = H;
      if (hists.length) { hists.forEach((id, k) => { rel[id] = { x: 14 + k * 30, y: H + 30 }; }); h = H + 44; }
      return { w: x, h };
    }

    function place(key, ox, oy) {
      for (const id of kids[key] || []) {
        const n = N[id], r = rel[id];
        if (!r) continue;
        if (!isState(n)) { n.x = Math.round(ox + r.x); n.y = Math.round(oy + r.y); continue; }
        n.x = Math.round(ox + r.x); n.y = Math.round(oy + r.y);
        n.w = Math.round(size[id].w); n.h = Math.round(size[id].h);
        if (n.and) {
          const R = Math.max(2, (n.regions || []).length);
          for (let i = 0; i < R; i++) place(id + "#" + i, n.x + PAD, n.y + NAME_H + i * regionH[id] + PAD + 10);
        } else place(id, n.x + PAD, n.y + NAME_H + PAD);
      }
    }

    layout("root");                 // recurses inward: a composite is measured after its content
    place("root", 60, 60);
    bendAround(N, E);
  }

  /* ---- transitions: bow apart pairs, bend around states in the way ---- */
  function bendAround(N, E) {
    const isState = (n) => n && n.kind === "state";
    const center = (n) => isState(n) ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: n.x, y: n.y };
    const anc = (n) => { const s = new Set(); while (n) { s.add(n.id); n = n.parent && N[n.parent]; } return s; };
    const descOf = (id) => { const s = new Set([id]); let grew = true;
      while (grew) { grew = false; for (const n of Object.values(N)) if (n.parent && s.has(n.parent) && !s.has(n.id)) { s.add(n.id); grew = true; } }
      return s; };
    const groups = {};
    for (const e of Object.values(E)) {
      delete e.lx; delete e.ly;
      const k = [e.from, e.to].sort().join("|");
      (groups[k] = groups[k] || []).push(e);
    }
    const curve = (a, b, bend, t) => {
      const ca = center(a), cb = center(b);
      const dx = cb.x - ca.x, dy = cb.y - ca.y, L = Math.hypot(dx, dy) || 1;
      const cx = (ca.x + cb.x) / 2 - dy / L * bend * 2, cy = (ca.y + cb.y) / 2 + dx / L * bend * 2;
      const u = 1 - t;
      return { x: u * u * ca.x + 2 * u * t * cx + t * t * cb.x, y: u * u * ca.y + 2 * u * t * cy + t * t * cb.y };
    };
    const blocked = (e, bend) => {
      const a = N[e.from], b = N[e.to];
      const skip = new Set([...anc(a), ...anc(b), ...descOf(a.id), ...descOf(b.id)]);
      const obstacles = Object.values(N).filter((n) => !skip.has(n.id) && n.kind !== "init");
      for (let i = 2; i <= 18; i++) {
        const p = curve(a, b, bend, i / 20);
        for (const o of obstacles) {
          if (isState(o)) {
            // only the states the line really enters; a composite's empty inside is fine to cross
            const inside = p.x > o.x - 6 && p.x < o.x + o.w + 6 && p.y > o.y - 6 && p.y < o.y + o.h + 6;
            if (inside && !Object.values(N).some((k) => k.parent === o.id && isState(k))) return true;
            if (inside && p.y < o.y + NAME_H + 4) return true;      // never across a name bar
          } else if (Math.hypot(p.x - o.x, p.y - o.y) < 18) return true;
        }
      }
      return false;
    };
    for (const g of Object.values(groups)) {
      for (const e of g) {
        if (e.from === e.to) continue;                       // self loop: leave as is
        if (N[e.from] && N[e.from].kind === "init") { e.bend = 0; continue; }
        const reverse = g.some((x) => x.from === e.to && x.to === e.from);
        const same = g.filter((x) => x.from === e.from && x.to === e.to);
        let base = 0;
        if (reverse) base = 24;                              // A->B and B->A bow to opposite sides
        if (same.length > 1) base = (same.indexOf(e) % 2 ? -1 : 1) * (26 + 22 * Math.floor(same.indexOf(e) / 2)) + (reverse ? 24 : 0);
        const tries = [base];
        for (const d of [40, 70, 100, 140, 190]) tries.push(base + d, base - d);
        e.bend = tries.find((b) => !blocked(e, b));
        if (e.bend === undefined) e.bend = base;
      }
    }
  }

  /* ---------------------------------------------------------------- scoring
     Geometry here mirrors editor.js render(): quadratic curves with control point
     mid + normal * bend * 2, self loops on the top-right corner, labels centred at
     the curve midpoint + (lx, ly). */
  const isStateN = (n) => n && n.kind === "state";
  const ctr = (n) => isStateN(n) ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : { x: n.x, y: n.y };
  function curvePoints(N, e, steps) {
    const a = N[e.from], b = N[e.to];
    if (!a || !b) return [];
    if (a === b) {
      const x = isStateN(a) ? a.x + a.w : a.x + 8, y = isStateN(a) ? a.y : a.y - 8, s = 26 + (e.bend || 0);
      const p0 = { x: x - 28, y }, c1 = { x: x - 28, y: y - s }, c2 = { x: x + s, y: y + 22 }, p1 = { x, y: y + 22 };
      const out = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        out.push({ x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
                   y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y });
      }
      return out;
    }
    const ca = ctr(a), cb = ctr(b), dx = cb.x - ca.x, dy = cb.y - ca.y, L = Math.hypot(dx, dy) || 1;
    const cx = (ca.x + cb.x) / 2 - dy / L * (e.bend || 0) * 2, cy = (ca.y + cb.y) / 2 + dx / L * (e.bend || 0) * 2;
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      out.push({ x: u * u * ca.x + 2 * u * t * cx + t * t * cb.x, y: u * u * ca.y + 2 * u * t * cy + t * t * cb.y });
    }
    return out;
  }
  function labelText(e) {
    let s = (e.trigger || "").trim();
    if ((e.guard || "").trim()) s += "[" + e.guard.trim() + "]";
    if ((e.action || "").trim()) s += "/" + e.action.trim().replace(/\s*\n\s*/g, " ");
    return s.length > 46 ? s.slice(0, 46) : s;
  }
  function labelBox(N, e, lx, ly) {
    const txt = labelText(e);
    if (!txt) return null;
    let mid;
    if (N[e.from] === N[e.to]) {
      const a = N[e.from], s = 26 + (e.bend || 0);
      const x = isStateN(a) ? a.x + a.w : a.x + 8, y = isStateN(a) ? a.y : a.y - 8;
      mid = { x: x + s * 0.45, y: y - s * 0.45 };
    } else mid = curvePoints(N, e, 20)[10];
    const w = txt.length * 6.6 + 6, x = mid.x + (lx || 0), y = mid.y + (ly != null ? ly : -6);
    return { x0: x - w / 2, x1: x + w / 2, y0: y - 11, y1: y + 3 };
  }
  const boxHit = (a, b, m) => a.x0 < b.x1 + m && b.x0 < a.x1 + m && a.y0 < b.y1 + m && b.y0 < a.y1 + m;
  const ancestry = (N, n) => { const s = new Set(); while (n) { s.add(n.id); n = n.parent && N[n.parent]; } return s; };
  function segCross(p, q, r, s) {
    const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = d(p, q, r), d2 = d(p, q, s), d3 = d(r, s, p), d4 = d(r, s, q);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }

  /* how messy a drawing is: lower is better */
  function metrics(N, E) {
    const st = Object.values(N).filter(isStateN);
    const leaves = st.filter((s) => !st.some((k) => k.parent === s.id));
    const ed = Object.values(E).filter((e) => N[e.from] && N[e.to]);
    const pts = ed.map((e) => curvePoints(N, e, 12));
    let through = 0, crossings = 0, labelHits = 0;
    // a line is drawn only between the borders of its two ends: drop the parts inside them
    const inside = (p, n) => isStateN(n) && p.x > n.x && p.x < n.x + n.w && p.y > n.y && p.y < n.y + n.h;
    ed.forEach((e, i) => { pts[i] = pts[i].filter((p) => !inside(p, N[e.from]) && !inside(p, N[e.to])); });
    ed.forEach((e, i) => {
      const skip = new Set([...ancestry(N, N[e.from]), ...ancestry(N, N[e.to])]);
      for (const o of leaves) {
        if (skip.has(o.id)) continue;
        if (pts[i].some((p) => p.x > o.x && p.x < o.x + o.w && p.y > o.y && p.y < o.y + o.h)) through++;
      }
    });
    for (let i = 0; i < ed.length; i++) for (let j = i + 1; j < ed.length; j++) {
      const a = ed[i], b = ed[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      let hit = false;
      for (let k = 0; k < pts[i].length - 1 && !hit; k++)
        for (let l = 0; l < pts[j].length - 1 && !hit; l++) hit = segCross(pts[i][k], pts[i][k + 1], pts[j][l], pts[j][l + 1]);
      crossings += hit ? 1 : 0;
    }
    const boxes = ed.map((e) => labelBox(N, e, e.lx, e.ly));
    boxes.forEach((b, i) => {
      if (!b) return;
      for (let j = i + 1; j < boxes.length; j++) if (boxes[j] && boxHit(b, boxes[j], 2)) labelHits++;
      for (const o of leaves) if (boxHit(b, { x0: o.x, x1: o.x + o.w, y0: o.y, y1: o.y + o.h }, 0)) labelHits++;
    });
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const n of Object.values(N)) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + (n.w || 0)); y1 = Math.max(y1, n.y + (n.h || 0));
    }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const aspect = Math.abs(Math.log((w / h) / 1.6));
    const score = 1000 * through + 200 * crossings + 60 * labelHits + 150 * aspect + (w * h) / 40000;
    return { through, crossings, labelHits, width: Math.round(w), height: Math.round(h), score: Math.round(score) };
  }

  /* move each label off states and other labels: try a few offsets around the curve midpoint */
  function placeLabels(N, E) {
    const st = Object.values(N).filter(isStateN);
    const leaves = st.filter((s) => !st.some((k) => k.parent === s.id));
    const placed = [];
    const offsets = [[0, -6], [0, 12], [0, -20], [0, 26], [-40, -6], [40, -6], [0, -34], [0, 40], [-70, -6], [70, -6]];
    for (const e of Object.values(E)) {
      if (!N[e.from] || !N[e.to] || N[e.from].kind === "init" || !labelText(e)) { delete e.lx; delete e.ly; continue; }
      let best = null;
      for (const [lx, ly] of offsets) {
        const b = labelBox(N, e, lx, ly);
        const bad = placed.filter((p) => boxHit(b, p, 3)).length +
          leaves.filter((o) => boxHit(b, { x0: o.x, x1: o.x + o.w, y0: o.y, y1: o.y + o.h }, 2)).length;
        if (!best || bad < best.bad) best = { lx, ly, bad, b };
        if (!bad) break;
      }
      if (best.lx || best.ly !== -6) { e.lx = best.lx; e.ly = best.ly; } else { delete e.lx; delete e.ly; }
      placed.push(best.b);
    }
  }

  /* ---------------------------------------------------------------- search
     Lay the chart out several ways, score each, keep the best. If the user's own drawing
     already scores better, it is left untouched. */
  const CANDIDATES = [];
  for (const layer of ["bfs", "lp"])
    for (const maxCols of [3, 4, 2, 5, 99])
      for (const flip of [false, true]) CANDIDATES.push({ maxCols, flip, layer });
  function optimizeLayout(N, E) {
    const before = metrics(N, E);
    const snapshot = JSON.stringify({ N, E });
    let best = null;
    for (const opts of CANDIDATES) {
      const c = JSON.parse(snapshot);
      layoutOnce(c.N, c.E, opts);
      placeLabels(c.N, c.E);
      const m = metrics(c.N, c.E);
      if (!best || m.score < best.m.score) best = { c, m, opts };
    }
    if (best.m.score >= before.score) return { changed: false, before, after: before };
    for (const [id, n] of Object.entries(best.c.N)) Object.assign(N[id], { x: n.x, y: n.y, w: n.w, h: n.h });
    for (const [id, e] of Object.entries(best.c.E)) {
      E[id].bend = e.bend;
      if (e.lx != null) E[id].lx = e.lx; else delete E[id].lx;
      if (e.ly != null) E[id].ly = e.ly; else delete E[id].ly;
    }
    return { changed: true, before, after: best.m, opts: best.opts };
  }

  window.optimizeLayout = optimizeLayout;
  window.layoutMetrics = metrics;
})();
