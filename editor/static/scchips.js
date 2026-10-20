/* Statechart Studio - GUI cells of the scenario table: "Set inputs" (inputs; config values on an Init row) and
   "Expect" (outputs only) are chips you pick from the project itself (no typing of names). The table still stores the plain text
   ("button=1, coin=500" / "LAMP_ON, !IDLE, lamp=true, cnt>=3") that scenario.py reads, so a step is
   parsed into chips here and written back after every change; anything that does not resolve stays as a red
   chip with its original text and is never lost. */
"use strict";

const SC_OPS = ["!=", ">=", "<=", "==", "=", ">", "<"];       // the order scenario.py looks for them
const SC_CMP = ["=", "!=", ">=", "<=", ">", "<"];

function scMeta() {
  const cs = project.classes.map((c) => ({
    name: c.name,
    vars: (c.attributes || []).filter((a) => (a.name || "").trim()).map((a) => ({ name: a.name, type: (a.type || "int").trim(), dir: a.dir || "local" })),
    states: Object.values((c.chart || {}).nodes || {}).filter((n) => n.kind === "state" && (n.name || "").trim()).map((n) => n.name),
  }));
  return { cs, multi: cs.length > 1 };
}
const scIsBool = (t) => (t || "").replace("const", "").trim() === "bool";
const scNumeric = (t) => !/\*/.test(t || "") && !scIsBool(t);          // pointers and strings cannot be set / compared
function scSplit(text) { return (text || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean); }
function scTok(tok) {
  for (const op of SC_OPS) {
    const i = tok.indexOf(op);
    if (i >= 0) return { l: tok.slice(0, i).trim(), op, r: tok.slice(i + op.length).trim() };
  }
  return { l: tok.trim(), op: null, r: "" };
}
function scQual(l) { const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(l); return m ? { cls: m[1], name: m[2] } : { cls: null, name: l }; }
function scFindVar(meta, q, pred) {
  const hits = [];
  for (const c of meta.cs) if (!q.cls || c.name === q.cls) for (const v of c.vars) if (v.name === q.name && pred(v)) hits.push({ cls: c.name, v });
  return hits.length === 1 ? hits[0] : null;
}
const SC_RANGES = { uint8_t: [0, 255], uint16_t: [0, 65535], uint32_t: [0, 4294967295], int8_t: [-128, 127], int16_t: [-32768, 32767],
  int32_t: [-2147483648, 2147483647], int: [-2147483648, 2147483647], unsigned: [0, 4294967295], short: [-32768, 32767],
  "unsigned short": [0, 65535], char: [-128, 127], "unsigned char": [0, 255] };
/* a value C would cut off silently: null when it fits, else a short reason (the server refuses such a row too) */
function scRange(type, val) {
  const t = (type || "").replace("const", "").trim(), v = parseFloat(val);
  if (scIsBool(t)) return ["true", "false", "0", "1"].includes(String(val).trim()) ? null : _t("a bool is true or false");
  if (!Number.isFinite(v)) return _t("not a number");
  const r = SC_RANGES[t];
  if (!r) return null;
  if (v !== Math.floor(v)) return _t("{0} takes whole numbers", t);
  return v < r[0] || v > r[1] ? _t("does not fit {0} ({1} … {2})", t, r[0], r[1]) : null;
}
const scName = (meta, ch) => (meta.multi ? `${ch.cls}.${ch.name}` : ch.name);
const scTruthy = (val) => val === "true" || (val !== "false" && parseFloat(val) > 0);

// ------------------------------------------------------------------ text <-> chips
function scParseSet(text, meta) {
  return scSplit(text).map((tok) => {
    const { l, op, r } = scTok(tok), q = scQual(l);
    const f = (op === "=" || op === "==") ? scFindVar(meta, q, (v) => (v.dir === "in" || v.dir === "config") && (scIsBool(v.type) || scNumeric(v.type))) : null;
    if (!f) return { bad: true, raw: tok };
    return { cls: f.cls, name: q.name, dir: f.v.dir, type: f.v.type, bool: scIsBool(f.v.type), val: r };
  });
}
function scWriteSet(chips, meta) {
  return chips.map((c) => (c.bad ? c.raw : `${scName(meta, c)}=${c.val}`)).join(", ");
}
function scParseExpect(text, meta) {
  return scSplit(text).map((tok) => {
    const { l, op, r } = scTok(tok);
    if (op === null) return { bad: true, raw: tok };                 // a state: not checked any more
    const q = scQual(l), f = scFindVar(meta, q, (v) => v.dir === "out" && (scIsBool(v.type) || scNumeric(v.type)));      // outputs only
    return f ? { cls: f.cls, name: q.name, dir: f.v.dir, type: f.v.type, bool: scIsBool(f.v.type), op, val: r } : { bad: true, raw: tok };
  });
}
function scWriteExpect(chips, meta) {
  return chips.map((c) => (c.bad ? c.raw : `${scName(meta, c)}${c.op}${c.val}`)).join(", ");
}

// ------------------------------------------------------------------ small pop-up menu
let scMenuEl = null;
function scCloseMenu() { if (scMenuEl) { scMenuEl.remove(); scMenuEl = null; } }
document.addEventListener("click", scCloseMenu);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") scCloseMenu(); });
/* items: [{head: "Inputs"} | {label, tag, pick}] */
function scMenu(anchor, items, empty) {
  scCloseMenu();
  const m = h("div", { class: "scmenu" });
  for (const it of items) {
    if (it.head) { m.append(h("div", { class: "mhead" }, it.head)); continue; }
    const b = h("button", { class: "mitem" }, h("span", {}, it.label), it.tag ? h("span", { class: "tag" }, it.tag) : null);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); scCloseMenu(); it.pick(); });
    m.append(b);
  }
  if (!items.some((x) => !x.head)) m.append(h("div", { class: "mnone" }, empty || _t("nothing left to add")));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mh = Math.min(m.offsetHeight, 280);
  m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - m.offsetWidth - 6)) + "px";
  m.style.top = (r.bottom + mh > window.innerHeight - 4 ? Math.max(4, r.top - mh - 2) : r.bottom + 2) + "px";
  scMenuEl = m;
}

// ------------------------------------------------------------------ chips
/* one editable cell. `kind` is "set" or "expect"; `commit(fn)` takes an undo snapshot, runs fn (which changes the
   chips), writes the text back into the step and refreshes the results. */
let scEmpty = "";                                  // why a menu is empty (set by addItems)
function scChipCell(st, kind, commit) {
  const isSet = kind === "set";
  const box = h("div", { class: "scchips" });
  let meta = scMeta();
  const read = () => (isSet ? scParseSet(st.set, meta) : scParseExpect(st.expect, meta));
  const write = (chips) => { if (isSet) st.set = scWriteSet(chips, meta); else st.expect = scWriteExpect(chips, meta); };
  let chips = read();
  const change = (fn, rebuild) => { commit(() => { fn(); write(chips); }); if (rebuild) paint(); };

  function valueControl(c) {                                   // value of a chip: toggle for bool, number field otherwise
    if (c.bool && (isSet || c.op === "=")) {
      const b = h("button", { class: "scval toggle " + (scTruthy(c.val) ? "on" : "off"), title: _t("Click to switch true / false") }, scTruthy(c.val) ? "true" : "false");
      b.addEventListener("click", (ev) => { ev.stopPropagation(); change(() => { c.val = scTruthy(c.val) ? "false" : "true"; }, true); });
      return b;
    }
    const inp = h("input", { type: "number", class: "scval num", value: String(c.bool ? (scTruthy(c.val) ? 1 : 0) : c.val), step: "any" });
    let snapped = false;
    inp.addEventListener("focus", () => { snapped = false; });
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("input", () => {
      if (inp.value === "" || !Number.isFinite(parseFloat(inp.value))) return;      // wait for a number
      change(() => { c.val = inp.value; }, false);
      const chip = inp.closest(".scchip"), why = isSet ? scRange(c.type, c.val) : null;
      if (chip) { chip.classList.toggle("warn", !!why || (isSet && c.dir === "config" && !st.init)); chip.title = why || ""; }
    });
    return inp;
  }

  function chipEl(c, i) {
    const del = h("button", { class: "scx", title: _t("Remove") }, "✕");
    del.addEventListener("click", (ev) => { ev.stopPropagation(); change(() => { chips.splice(i, 1); }, true); });
    if (c.bad) {
      return h("span", { class: "scchip bad", title: _t("Not understood (a name that no longer exists?) — remove it or fix it in the drawing") }, c.raw, del);
    }
    const parts = [h("span", { class: "scname2", title: c.type + " · " + c.dir },
      meta.multi ? h("span", { class: "cls" }, c.cls + ".") : null, c.name)];
    if (isSet) parts.push(h("span", { class: "scop" }, "="));
    else if (c.bool && c.op === "=") parts.push(h("span", { class: "scop" }, "="));
    else {
      const sel = h("select", { class: "scopsel" }, ...SC_CMP.map((o) => h("option", { value: o, selected: o === (c.op === "==" ? "=" : c.op) ? "selected" : null }, o)));
      sel.addEventListener("click", (ev) => ev.stopPropagation());
      sel.addEventListener("change", () => change(() => { c.op = sel.value; }, false));
      parts.push(sel);
    }
    parts.push(valueControl(c));
    const range = isSet ? scRange(c.type, c.val) : null;
    const noInit = isSet && c.dir === "config" && !st.init;
    return h("span", { class: "scchip val" + (c.dir === "config" ? " cfg" : "") + (noInit || range ? " warn" : ""),
                       title: noInit ? _t("Config value: tick Init on this row, it is an X_Init parameter") : range || "" }, ...parts, del);
  }

  function addItems() {
    const items = [];
    const used = new Set(chips.filter((c) => !c.bad).map((c) => c.cls + "." + c.name));
    const tag = (c, v) => (meta.multi ? c.name + " · " : "") + v.type;
    if (isSet) {
      const add = (c, v) => items.push({ label: v.name, tag: tag(c, v), pick: () => change(() => {
        chips.push({ cls: c.name, name: v.name, dir: v.dir, type: v.type, bool: scIsBool(v.type), val: scIsBool(v.type) ? "true" : "0" });
      }, true) });
      for (const dirs of [["in"], ["config"]]) {
        if (dirs[0] === "config" && !st.init) continue;
        const list = [];
        for (const c of meta.cs) for (const v of c.vars) if (v.dir === dirs[0] && (scIsBool(v.type) || scNumeric(v.type)) && !used.has(c.name + "." + v.name)) list.push([c, v]);
        if (list.length) { items.push({ head: dirs[0] === "in" ? _t("Inputs") : _t("Config values (X_Init parameters)") }); list.forEach(([c, v]) => add(c, v)); }
      }
      if (!st.init && meta.cs.some((c) => c.vars.some((v) => v.dir === "config")))
        items.push({ head: _t("Tick Init on this row to set config values") });
      scEmpty = meta.cs.some((c) => c.vars.some((v) => v.dir === "in")) ? "" : _t("There is no Input variable yet — add one under Variables ▸ Input");
      return items;
    }
    const list = [];                                            // only outputs: inputs drive, states and internal variables stay inside
    for (const c of meta.cs) for (const v of c.vars) if (v.dir === "out" && (scIsBool(v.type) || scNumeric(v.type))) list.push([c, v]);
    if (list.length) items.push({ head: _t("Outputs") });
    for (const [c, v] of list) items.push({ label: v.name, tag: tag(c, v), pick: () => change(() => {
      chips.push({ cls: c.name, name: v.name, dir: v.dir, type: v.type, bool: scIsBool(v.type), op: "=", val: scIsBool(v.type) ? "true" : "0" });
    }, true) });
    scEmpty = meta.cs.some((c) => c.vars.some((v) => v.dir === "out")) ? "" : _t("There is no Output variable yet — add one under Variables ▸ Output");
    return items;
  }

  function paint() {
    meta = scMeta();
    chips = read();
    box.textContent = "";
    chips.forEach((c, i) => box.append(chipEl(c, i)));
    const plus = h("button", { class: "scadd", title: isSet ? _t("Add an input to change") : _t("Add something that must be true") }, "＋");
    plus.addEventListener("click", (ev) => { ev.stopPropagation(); scEmpty = ""; const items = addItems(); scMenu(plus, items, scEmpty); });
    box.append(plus);
  }
  paint();
  return box;
}

// ------------------------------------------------------------------ renaming in the drawing keeps the scenarios working
/* The editor does not rewrite guards when a variable is renamed, but the scenarios only name variables through
   these chips, so they follow: an entry that named `old` now names `new` (and `Old.x` after a class rename). */
function scRewrite(fn) {
  let n = 0;
  for (const sc of project.scenarios || []) for (const st of sc.steps) for (const key of ["set", "expect"]) {
    const out = scSplit(st[key]).map((tok) => {
      const { l, op, r } = scTok(tok), q = scQual(l), res = fn(q, op);
      if (!res) return tok;
      n++;
      return `${res}${op === null ? "" : op + r}`;
    }).join(", ");
    if (out !== (st[key] || "")) st[key] = out;
  }
  return n;
}
function scRenameVar(cname, oldN, newN) {
  if (!oldN || !newN || oldN === newN || !project.scenarios) return;
  const others = project.classes.filter((c) => c.name !== cname && (c.attributes || []).some((a) => a.name === oldN)).length;
  if (scRewrite((q) => (q.name === oldN && (q.cls === cname || (!q.cls && !others)) ? (q.cls ? `${q.cls}.${newN}` : newN) : null))) { save(); if (typeof scBuild === "function") scBuild(); }
}
function scRenameClass(oldN, newN) {
  if (!oldN || !newN || oldN === newN || !project.scenarios) return;
  if (scRewrite((q) => (q.cls === oldN ? `${newN}.${q.name}` : null))) { save(); if (typeof scBuild === "function") scBuild(); }
}
/* remember the name when the field gets focus, apply the rename when it is left (not on every key) */
function scWatchName(input, getName, apply) {
  let before = null;
  input.addEventListener("focus", () => { before = getName(); });
  input.addEventListener("change", () => { if (before !== null && getName() !== before) apply(before, getName()); before = getName(); });
}
