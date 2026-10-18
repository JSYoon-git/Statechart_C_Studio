"""Generate C code from statecharts.

    python sc2c.py <rhapsody project (.rpyx or folder) | statechart.json> -o out_dir [--class A,B]

Output: <pkg>_events.h/.c, one <Class>.h/.c per class, and a copy of the
runtime (sc_rt.h/.c). Build with any C89+ compiler:

    cc -I out_dir out_dir/*.c your_main.c
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sc_ir import AND, LEAF, OR, Node, State, cident, load_json, load_rhapsody  # noqa: E402

RUNTIME = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime")
KIND_C = {LEAF: "SC_LEAF", OR: "SC_OR", AND: "SC_AND"}


def indent(code, n):
    pad = " " * n
    return "\n".join(pad + ln if ln.strip() else "" for ln in code.splitlines())


def block(code, n):
    """User code as its own C block (keeps declarations legal in C89)."""
    code = (code or "").strip()
    if not code:
        return ""
    return indent("{\n" + indent(code, 4) + "\n}", n)


def ancestors(s):
    out = []
    while s is not None:
        out.append(s)
        s = s.parent
    return out


# ==========================================================================
class ClassGen:
    def __init__(self, pkg, cls):
        self.pkg, self.c, self.m = pkg, cls, cls.machine
        self.ev = {e.name: e for e in pkg.events}
        self.warn = []
        self.timers = []                    # (state, expr)
        if self.m:
            for t in self.m.transitions:
                if t.timeout and isinstance(t.src, State):
                    t._timer = len(self.timers)
                    self.timers.append((t.src, t.timeout))

    def S(self, s):
        return f"{self.c.name}_S_{s.cname}"

    # ---- compound transition emission -----------------------------------
    def follow_diagram(self, node):
        if node.outgoing or node.kind != "diagram":
            return node
        for n in self.m.nodes:
            if n is not node and n.kind == "diagram" and n.name == node.name and n.outgoing:
                return n
        self.warn.append(f"diagram connector '{node.name}' has no partner")
        return node

    def domain(self, src, tgt):
        """(LCA, main source to exit) for an external transition src -> tgt."""
        sa, ta = ancestors(src), ancestors(tgt)
        if tgt in sa:                       # to self or to an enclosing state
            lca = tgt.parent
        elif src in ta:                     # from a composite into its own substate
            lca = src.parent
        else:
            lca = next(a for a in sa if a in ta)
        while lca is not None and lca.kind == AND:  # across regions: leave the AND state
            lca = lca.parent
        if lca is None:
            lca = self.m.root
        main = next((a for a in sa if a.parent is lca), src)
        return lca, main

    def emit_target(self, mode, owner, dst, acts, ind):
        """Code that completes a transition from `owner` ending at `dst`."""
        out = []
        ret = "return 1;" if mode == "trans" else "return;"
        if isinstance(dst, Node):
            dst = self.follow_diagram(dst)
            if dst.kind in ("cond", "junction") or (dst.kind == "diagram" and dst.outgoing):
                branches = sorted(dst.outgoing, key=lambda b: b.guard.strip() == "else")
                first = True
                for b in branches:
                    g = b.guard.strip()
                    inner = self.emit_target(mode, owner, b.dst, acts + [b.action], ind + 4)
                    if g == "else" or (not g and dst.kind == "diagram"):
                        out.append(" " * ind + ("else {" if not first else "{"))
                    else:
                        out.append(" " * ind + f"{'if' if first else 'else if'} ({g or '1'}) {{")
                    out.append(inner)
                    out.append(" " * ind + "}")
                    first = False
                return "\n".join(out)
            if dst.kind == "history":
                target, hist = dst.parent, 1
            elif dst.kind == "term":
                code = []
                if mode == "trans":
                    code.append(f"SC_exit(&me->sc, {self.S(self.domain(owner, self.m.root)[1]) if owner.parent else self.S(owner)});")
                code += [block(a, 0) for a in acts if a.strip()]
                code += ["SC_terminate(&me->sc);", ret]
                return indent("\n".join(c for c in code if c), ind)
            else:
                self.warn.append(f"unsupported connector '{dst.kind}' in transition from {owner.name}")
                return indent("/* unsupported connector */", ind)
        else:
            target, hist = dst, 0

        code = []
        if mode == "trans":
            lca, main = self.domain(owner, target)
            code.append(f"SC_exit(&me->sc, {self.S(main)});")
        else:
            lca = owner
            if owner not in ancestors(target):
                self.warn.append(f"default transition of '{owner.name}' leaves the state")
        code += [block(a, 0) for a in acts if a.strip()]
        code.append(f"SC_enter(&me->sc, {self.S(lca)}, {self.S(target)}, {hist});")
        code.append(ret)
        return indent("\n".join(c for c in code if c), ind)

    def trigger_test(self, t):
        if t.timeout:
            return f"ev->id == SC_TIMEOUT_EVENT && ev->timer == {t._timer}"
        if t.event:
            return f"ev->id == {cident(t.event)}_id"
        return "ev->id == SC_NULL_EVENT"

    def emit_transition(self, t):
        lines = [f"if ({self.trigger_test(t)}) {{"]
        e = self.ev.get(t.event)
        if e is not None and e.args:
            lines.append(f"    const struct {cident(e.name)}_params *params = "
                         f"(const struct {cident(e.name)}_params *)&ev->params;")
            lines.append("    (void)params;")
        g = t.guard.strip()
        body_ind = 4
        if g and g != "else":
            lines.append(f"    if ({g}) {{")
            body_ind = 8
        if t.internal:
            lines.append(block(t.action, body_ind))
            lines.append(" " * body_ind + "return 1;")
        else:
            lines.append(self.emit_target("trans", t.src, t.dst, [t.action], body_ind))
        if body_ind == 8:
            lines.append("    }")
        lines.append("}")
        return "\n".join(ln for ln in lines if ln != "")

    # ---- files -------------------------------------------------------------
    def header(self):
        c, m = self.c, self.m
        n = c.name
        L = [f"#ifndef {n.upper()}_H", f"#define {n.upper()}_H", "",
             f'#include "{self.pkg.name}_events.h"', ""]
        L += [f"struct {o.name};" for o in self.pkg.classes]
        L += ["", f"typedef struct {n} {n};", ""]
        if m:
            states = m.states()
            L.append("enum {")
            L += [f"    {self.S(s)} = {s.index}," for s in states]
            L.append(f"    {n}_NSTATES = {len(states)}")
            L.append("};")
            L.append(f"#define {n}_NTIMERS {max(1, len(self.timers))}")
            L.append("")
        L.append(f"struct {n} {{")
        if m:
            L.append("    SC_Instance sc;")
        L += [f"    {a.type} {a.name};" for a in c.attributes]
        for a in c.assocs:
            L.append(f"    struct {a.other} *{a.name};" + ("  /* multiplicity > 1: first element only */" if a.many else ""))
        if m:
            L += [f"    int sc_sub[{n}_NSTATES];", f"    int sc_hist[{n}_NSTATES];", f"    int sc_tmr[2 * {n}_NTIMERS];"]
        if not (m or c.attributes or c.assocs):
            L.append("    int unused_;")
        L += ["};", "", f"void {n}_Init({n} *const me, const char *name);"]
        if m:
            L.append(f"void {n}_startBehavior({n} *const me);")
            L += [f"int {n}_{s.cname}_IN(const {n} *const me);" for s in m.states() if s.parent]
        for a in c.attributes:
            L.append(f"{a.type} {n}_get{a.name[:1].upper()}{a.name[1:]}(const {n} *const me);")
            L.append(f"void {n}_set{a.name[:1].upper()}{a.name[1:]}({n} *const me, {a.type} v);")
        for op in c.operations:
            L.append(f"{op.ret} {n}_{op.name}({self.params(op)});")
        L += ["", "#endif", ""]
        return "\n".join(L)

    def params(self, op):
        return ", ".join([f"{self.c.name} *const me"] + [f"{a.type} {a.name}" for a in op.args])

    def source(self):
        c, m, n = self.c, self.m, self.c.name
        L = [f"/* Generated by sc2c from the {n} statechart. */",
             "#include <string.h>", "#include <stdio.h>"]
        L += [f'#include "{o.name}.h"' for o in self.pkg.classes]
        L.append("")
        if m:
            states = m.states()
            L.append(f"#define IS_IN(s) SC_isIn(&me->sc, {n}_S_##s)")
            L.append("")

            def arr(ctype, name, vals):
                return f"static const {ctype} {n}_{name}[] = {{ {', '.join(vals)} }};"
            L.append(arr("int", "parent", [str(s.parent.index if s.parent else -1) for s in states]))
            L.append(arr("unsigned char", "kind", [KIND_C[s.kind] for s in states]))
            L.append(arr("int", "firstChild", [str(s.children[0].index if s.children else -1) for s in states]))
            sib = {}
            for s in states:
                for a, b in zip(s.children, s.children[1:]):
                    sib[a.index] = b.index
            L.append(arr("int", "nextSibling", [str(sib.get(s.index, -1)) for s in states]))
            L.append(arr("char *const", "stateName", [f'"{s.cname}"' for s in states]))
            L.append(arr("int", "timerState", [str(s.index) for s, _ in self.timers] or ["-1"]))
            L.append("")

            # entry / exit
            for kind in ("entry", "exit"):
                L.append(f"static void {n}_{kind}(void *self, int s)")
                L.append("{")
                L.append(f"    {n} *const me = ({n} *)self;")
                L.append("    (void)me;")
                L.append("    switch (s) {")
                for s in states:
                    code = getattr(s, kind)
                    if code.strip():
                        L.append(f"    case {self.S(s)}:")
                        L.append(block(code, 8))
                        L.append("        break;")
                L += ["    default: break;", "    }", "}", ""]

            # timers
            L.append(f"static int {n}_timerMs(void *self, int t)")
            L.append("{")
            L.append(f"    {n} *const me = ({n} *)self;")
            L.append("    (void)me;")
            L.append("    switch (t) {")
            for i, (_, expr) in enumerate(self.timers):
                L.append(f"    case {i}: return (int)({expr});")
            L += ["    default: return 0;", "    }", "}", ""]

            # default transitions
            L.append(f"static void {n}_initial(void *self, int s)")
            L.append("{")
            L.append(f"    {n} *const me = ({n} *)self;")
            L.append("    (void)me;")
            L.append("    switch (s) {")
            for s in states:
                if s.initial is not None:
                    L.append(f"    case {self.S(s)}:")
                    L.append(self.emit_target("init", s, s.initial.dst, [s.initial.action], 8))
                elif s.kind == OR and len(s.children) == 1:
                    # unambiguous: some sample models omit the arrow to a lone substate
                    L.append(f"    case {self.S(s)}:")
                    L.append(self.emit_target("init", s, s.children[0], [], 8))
                    self.warn.append(f"'{s.name or 'ROOT'}' has no default transition; "
                                     f"entering its only substate '{s.children[0].name}'")
                elif s.kind == OR and s.children:
                    self.warn.append(f"composite state '{s.name or 'ROOT'}' has no default transition")
            L += ["    default: break;", "    }", "}", ""]

            # transitions
            L.append(f"static int {n}_trans(void *self, int s, const SC_Event *ev)")
            L.append("{")
            L.append(f"    {n} *const me = ({n} *)self;")
            L.append("    (void)me;")
            L.append("    switch (s) {")
            by_src = {}
            for t in m.transitions:
                if isinstance(t.src, State):
                    by_src.setdefault(t.src.index, []).append(t)
            for s in states:
                ts = by_src.get(s.index)
                if not ts:
                    continue
                L.append(f"    case {self.S(s)}:")
                for t in ts:
                    L.append(indent(self.emit_transition(t), 8))
                L.append("        break;")
            L += ["    default: break;", "    }", "    return 0;", "}", ""]

            L.append(f"static const SC_Desc {n}_desc = {{")
            L.append(f'    "{n}", {n}_NSTATES, {len(self.timers)},')
            L.append(f"    {n}_parent, {n}_kind, {n}_firstChild, {n}_nextSibling, {n}_stateName,")
            L.append(f"    {self.pkg.name}_eventNames, {n}_timerState,")
            L.append(f"    {n}_entry, {n}_exit, {n}_initial, {n}_trans, {n}_timerMs")
            L.append("};")
            L.append("")

        # Init
        L.append(f"void {n}_Init({n} *const me, const char *name)")
        L.append("{")
        L.append("    memset(me, 0, sizeof *me);")
        for a in c.attributes:
            if a.default.strip():
                L.append(f"    me->{a.name} = {a.default};")
        if m:
            L.append(f"    SC_init(&me->sc, &{n}_desc, me, name, me->sc_sub, me->sc_hist, me->sc_tmr);")
        else:
            L.append("    (void)name;")
        if c.init_body.strip():
            L.append(block(c.init_body, 4))
        L += ["}", ""]
        if m:
            L += [f"void {n}_startBehavior({n} *const me)", "{", "    SC_start(&me->sc);", "}", ""]
            for s in m.states():
                if s.parent:
                    L += [f"int {n}_{s.cname}_IN(const {n} *const me)", "{",
                          f"    return SC_isIn(&me->sc, {self.S(s)});", "}", ""]
        for a in c.attributes:
            cap = a.name[:1].upper() + a.name[1:]
            L += [f"{a.type} {n}_get{cap}(const {n} *const me)", "{", f"    return me->{a.name};", "}", "",
                  f"void {n}_set{cap}({n} *const me, {a.type} v)", "{", f"    me->{a.name} = v;", "}", ""]
        for op in c.operations:
            L += [f"{op.ret} {n}_{op.name}({self.params(op)})", "{"]
            L.append(indent(op.body, 4) if op.body.strip() else ("    (void)me;" if op.ret == "void" else
                                                                  f"    (void)me;\n    return ({op.ret})0;"))
            L += ["}", ""]
        return "\n".join(L)


# ==========================================================================
def events_files(pkg):
    p = pkg.name
    H = [f"#ifndef {p.upper()}_EVENTS_H", f"#define {p.upper()}_EVENTS_H", "",
         '#include "sc_rt.h"', "",
         "#if defined(_MSC_VER)", "#define SC_INLINE __inline", "#else", "#define SC_INLINE inline", "#endif", "",
         "/* Rhapsody C action-language compatibility */",
         "#define RiCGEN(p, e) SC_send(&(p)->sc, (e))",
         "#define CGEN(p, e)   RiCGEN(p, e)",
         "#define GEN(e)       SC_send(&me->sc, (e))",
         "#ifndef RiCTRUE", "typedef int RiCBoolean;", "typedef int RhpBoolean;", "#define RiCTRUE 1", "#define RiCFALSE 0", "#endif", ""]
    if pkg.types:
        H.append("/* user types */")
        H += [t if t.rstrip().endswith((";", "}")) or t.lstrip().startswith("#") else t + ";" for t in pkg.types]
        H.append("")
    H.append("enum {")
    for i, e in enumerate(pkg.events):
        H.append(f"    {cident(e.name)}_id = SC_FIRST_USER_EVENT + {i},")
    H.append(f"    {p}_NEVENTS = SC_FIRST_USER_EVENT + {len(pkg.events)}")
    H += ["};", "", f"extern const char *const {p}_eventNames[];", ""]
    for e in pkg.events:
        en = cident(e.name)
        if e.args:
            H.append(f"struct {en}_params {{ " + " ".join(f"{a.type} {a.name};" for a in e.args) + " };")
            H.append(f"typedef char {en}_params_fit[sizeof(struct {en}_params) <= SC_MAX_PARAMS ? 1 : -1];")
        sig = ", ".join(f"{a.type} {a.name}" for a in e.args) or "void"
        H.append(f"static SC_INLINE SC_Event {en}({sig})")
        H.append("{")
        H.append(f"    SC_Event e = SC_makeEvent({en}_id);")
        if e.args:
            H.append(f"    struct {en}_params *p_ = (struct {en}_params *)&e.params;")
            H += [f"    p_->{a.name} = {a.name};" for a in e.args]
        H += ["    return e;", "}", ""]
    H += ["#endif", ""]
    C = [f'#include "{p}_events.h"', "",
         f"const char *const {p}_eventNames[] = {{",
         '    "null", "timeout",'] + [f'    "{e.name}",' for e in pkg.events] + ["    0", "};", ""]
    return "\n".join(H), "\n".join(C)


def generate(pkg, out):
    os.makedirs(out, exist_ok=True)
    h, c = events_files(pkg)
    files = {f"{pkg.name}_events.h": h, f"{pkg.name}_events.c": c}
    warnings = list(pkg.warnings)
    for cls in pkg.classes:
        g = ClassGen(pkg, cls)
        files[f"{cls.name}.h"] = g.header()
        files[f"{cls.name}.c"] = g.source()
        warnings += [f"{cls.name}: {w}" for w in g.warn]
    for fn, text in files.items():
        with open(os.path.join(out, fn), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    for fn in ("sc_rt.h", "sc_rt.c"):
        shutil.copy(os.path.join(RUNTIME, fn), os.path.join(out, fn))
    return list(files) + ["sc_rt.h", "sc_rt.c"], warnings


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("-o", "--out", default="gen")
    ap.add_argument("--class", dest="only", help="comma-separated class names to generate")
    ap.add_argument("--style", choices=["table", "rhapsody"], default="table",
                    help="table: compact sc_rt runtime (default); rhapsody: Rhapsody-style switch code on RiCLite")
    ap.add_argument("--with-statechart-only", action="store_true",
                    help="skip classes that have no statechart")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    pkg = load_json(a.model) if a.model.lower().endswith(".json") else load_rhapsody(a.model, only)
    if a.with_statechart_only:
        pkg.classes = [c for c in pkg.classes if c.machine]
    if a.style == "rhapsody":
        from rhp_c import generate as generate_rhp
        files, warnings = generate_rhp(pkg, a.out)
    else:
        files, warnings = generate(pkg, a.out)
    print(f"{pkg.name}: {len(pkg.classes)} classes, {len(pkg.events)} events -> {a.out}")
    for c in pkg.classes:
        if c.machine:
            print(f"  {c.name}: {len(c.machine.states())} states, {len(c.machine.transitions)} transitions")
    for w in warnings:
        print("  warning:", w)


if __name__ == "__main__":
    main()
