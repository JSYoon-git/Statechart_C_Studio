"""Web-editor project JSON -> sc_ir.Package.

Project layout (what static/editor.js saves):

  { "package": "Default", "types": ["#include <stdio.h>", ...],
    "events":  [{"name": "evGo", "args": [{"type": "int", "name": "n"}]}],
    "classes": [{
        "name": "Oven", "init": "",
        "attributes": [{"type": "int", "name": "x", "default": "0"}],
        "operations": [{"name": "f", "ret": "void", "args": [...], "body": "..."}],
        "assocs":     [{"name": "itsLamp", "class": "Lamp"}],
        "chart": {
          "nodes": {"n1": {"kind": "state", "name": "idle", "parent": null, "region": 0,
                           "and": false, "regions": [{"name": "r0"}],
                           "entry": "", "exit": "",
                           "reactions": [{"trigger": "evX", "guard": "", "action": ""}],
                           "x": 0, "y": 0, "w": 120, "h": 60},
                    "n2": {"kind": "init" | "cond" | "junction" | "hist" | "term", "parent": "n1", ...}},
          "edges": {"e1": {"from": "n2", "to": "n1", "trigger": "evGo" | "tm(500)", "guard": "", "action": ""}}
        }}]}
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "codegen"))

from sc_ir import (Arg, Assoc, Attribute, Class, Event, Machine, Node, Operation,  # noqa: E402
                   Package, State, Trans, cident)

TM = re.compile(r"^\s*tm\s*\((.*)\)\s*$", re.S)
KIND = {"cond": "cond", "junction": "junction", "hist": "history", "term": "term"}


def parse_trigger(text):
    """'evGo' -> ('evGo', ''), 'tm(500)' -> ('', '500'), 'evGo(a,b)' -> ('evGo', '')."""
    text = (text or "").strip()
    m = TM.match(text)
    if m:
        return "", m.group(1).strip() or "0"
    return re.sub(r"\(.*", "", text).strip(), ""


IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
C_KEYWORDS = set("""auto break case char const continue default do double else enum extern float for goto if
inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void
volatile while _Bool _Complex _Imaginary bool true false NULL""".split())
RESERVED_MEMBERS = {"ric_reactive", "dummy_", "me"}    # struct members the generator adds itself
DIRS = {"in", "out", "local", "config"}


def check_names(spec):
    """Reject names that would not compile, with a message the user can act on."""
    errs = []

    def ident(what, name, keyword_ok=False):
        if not IDENT.match(name or ""):
            errs.append(f"{what} '{name}': letters, digits and _ only, not starting with a digit")
        elif not keyword_ok and name in C_KEYWORDS:
            errs.append(f"{what} '{name}': a C keyword")

    ident("package name", spec.get("package") or "Default")
    classes = [c.get("name", "") for c in spec.get("classes", [])]
    seen = set()
    for e in spec.get("events", []):
        ident("event", e.get("name", ""))
        if e.get("name") in seen:
            errs.append(f"event '{e['name']}': declared twice")
        seen.add(e.get("name"))
        if e.get("name") in classes:
            errs.append(f"event '{e['name']}': same as a class name (the C struct names would clash)")
        for a in e.get("args", []):
            ident(f"argument of event '{e.get('name')}'", a.get("name", ""))
    for c in spec.get("classes", []):
        cn = c.get("name", "")
        ident("class", cn)
        for a in c.get("attributes", []):
            n = a.get("name", "")
            ident(f"{cn}, variable", n)
            if n in RESERVED_MEMBERS or n.endswith(("_subState", "_lastState")):
                errs.append(f"{cn}, variable '{n}': a name the generated code uses itself")
            if c.get("ioStyle") == "struct" and n in ("in", "out"):
                errs.append(f"{cn}, variable '{n}': with struct arguments 'in' / 'out' are X_Main's parameter names")
        for o in c.get("operations", []):
            ident(f"{cn}, operation", o.get("name", ""))
        for a in c.get("assocs", []):
            ident(f"{cn}, link", a.get("name", ""))
        for n in ((c.get("chart") or {}).get("nodes") or {}).values():
            if n.get("kind") == "state":
                ident(f"{cn}, state", n.get("name", ""), keyword_ok=True)   # always prefixed in C
                if c.get("ioStyle") == "struct" and n.get("name") in ("In", "Out"):
                    errs.append(f"{cn}, state '{n.get('name')}': clashes with the struct type {cn}_{n.get('name')}")
    if errs:
        raise ValueError("name errors — " + " / ".join(errs))


def attribute(a):
    d = a.get("dir") if a.get("dir") in DIRS else "local"
    return Attribute((a.get("type") or "int").strip(), cident(a["name"]), str(a.get("default", "") or ""), d)


def old_period_us(cs, spec=None):
    """Older projects stored a task period (class or project); only used to convert their tm()."""
    for v in (cs.get("periodUs"), (spec or {}).get("periodUs")):
        try:
            if v and int(float(v)) > 0:
                return int(float(v))
        except (TypeError, ValueError):
            pass
    return 10000


def migrate_timers(cs, spec, warnings):
    """There is no tm() any more: the user counts X_Main calls with a variable. Old projects get
    the same pattern written out:  entry/ cnt_S = 0;   reaction/ cnt_S++;   [cnt_S >= N]
    (reactions run before the transitions, so the transition fires on the N-th call)."""
    chart = cs.get("chart") or {}
    nodes, edges = chart.get("nodes") or {}, chart.get("edges") or {}
    attrs = cs.setdefault("attributes", [])
    names = {a.get("name") for a in attrs}
    P = old_period_us(cs, spec)
    for sid, n in nodes.items():
        items = [e for e in edges.values() if e.get("from") == sid] + list(n.get("reactions") or [])
        timed = [e for e in items if parse_trigger(e.get("trigger"))[1]]
        if not timed or n.get("kind") != "state":
            for e in timed:
                e["trigger"] = ""
            continue
        var = cident("cnt_" + (n.get("name") or sid))
        while var in names:
            var += "_"
        names.add(var)
        attrs.append({"type": "uint32_t", "name": var, "default": "0", "dir": "local"})
        n["entry"] = f"{var} = 0;" + ("\n" + n["entry"] if (n.get("entry") or "").strip() else "")
        n["reactions"] = [{"trigger": "", "guard": "", "action": f"{var}++;"}] + list(n.get("reactions") or [])
        for e in timed:
            expr = parse_trigger(e.get("trigger"))[1].strip()
            if re.fullmatch(r"\d+", expr):
                calls = max(1, -(-int(expr) * 1000 // P))
                cond = f"{var} >= {calls}u"
            else:
                cond = f"{var} >= (uint32_t)({expr}) * 1000u / {P}u"
            g = (e.get("guard") or "").strip()
            e["guard"] = cond if not g else f"({cond}) && ({g})"
            e["trigger"] = ""
        warnings.append(f"{cs.get('name')}: tm() of '{n.get('name')}' turned into the counter variable {var} (10 ms calls)")


def migrate_events(cs, warnings):
    """Old projects used event triggers. Task-style code has none: a trigger 'evX' becomes a
    bool input variable evX, read by the guard as `evX == true`."""
    attrs = cs.setdefault("attributes", [])
    names = {a.get("name") for a in attrs}
    chart = cs.get("chart") or {}
    items = list((chart.get("edges") or {}).values())
    for n in (chart.get("nodes") or {}).values():
        items += n.get("reactions") or []
    for e in items:
        ev, tmo = parse_trigger(e.get("trigger"))
        if not ev:
            continue
        if not IDENT.match(ev):
            continue
        if ev not in names:
            attrs.append({"type": "bool", "name": ev, "default": "false", "dir": "in"})
            names.add(ev)
            warnings.append(f"{cs.get('name')}: event '{ev}' turned into a bool input ({ev} == true)")
        g = (e.get("guard") or "").strip()
        e["guard"] = f"{ev} == true" if not g else f"({ev} == true) && ({g})"
        e["trigger"] = f"tm({tmo})" if tmo else ""


def load_editor(spec):
    check_names(spec)
    events = []           # task-style code: no events (old triggers are migrated to inputs)
    warnings = []
    classes = []
    for cs in spec.get("classes", []):
        migrate_events(cs, warnings)
        migrate_timers(cs, spec, warnings)
        c = Class(cident(cs["name"]),
                  [attribute(a) for a in cs.get("attributes", []) if a.get("name", "").strip()],
                  [Operation(cident(o["name"]), o.get("ret") or "void",
                             [Arg(a.get("type", "int"), cident(a["name"])) for a in o.get("args", []) if a.get("name")],
                             o.get("body", ""), bool(o.get("triggered")))
                   for o in cs.get("operations", []) if o.get("name", "").strip()],
                  [Assoc(cident(a["name"]), cident(a["class"])) for a in cs.get("assocs", [])
                   if a.get("name", "").strip() and a.get("class", "").strip()],
                  cs.get("init", ""))
        c.period_us = 10000                # every module is called from the 10 ms task
        c.main_body = cs["main"] if isinstance(cs.get("main"), str) and cs["main"].strip() else None
        c.io_struct = cs.get("ioStyle") == "struct"
        for op in c.operations:          # no triggered operations either: plain functions
            op.triggered = False
        chart = cs.get("chart") or {}
        if any(n.get("kind") == "state" for n in (chart.get("nodes") or {}).values()):
            m, w = build_machine(chart, events)
            c.machine = m
            warnings += [f"{c.name}: {x}" for x in w]
        classes.append(c)
    return Package(cident(spec.get("package") or "Default"), classes, events,
                   [t for t in spec.get("types", []) if t.strip()], warnings)


def build_machine(chart, events):
    nodes = chart.get("nodes") or {}
    edges = chart.get("edges") or {}
    warn = []
    root = State("ROOT")
    st = {}                  # node id -> State
    regions = {}             # (and node id, index) -> region State
    for nid, n in nodes.items():
        if n.get("kind") == "state":
            st[nid] = State(n.get("name") or nid, entry=n.get("entry", ""), exit=n.get("exit", ""),
                            is_and=bool(n.get("and")))
            st[nid].node_id = nid            # lets the simulator map a C state back to the drawing

    def container(n):
        pid = n.get("parent")
        if not pid or pid not in st:
            return root
        p = st[pid]
        if p.is_and:
            regs = nodes[pid].get("regions") or [{}, {}]
            i = max(0, min(int(n.get("region") or 0), len(regs) - 1))
            return regions[(pid, i)]
        return p

    # regions first, so containers exist
    for nid, s in st.items():
        if s.is_and:
            regs = nodes[nid].get("regions") or [{}, {}]
            for i, r in enumerate(regs):
                rs = State((r.get("name") or "").strip() or f"{s.name}_r{i}", s)
                s.children.append(rs)
                regions[(nid, i)] = rs
    # parents, in an order that keeps the children lists in drawing order (top-left first)
    order = sorted(st, key=lambda k: (nodes[k].get("y", 0), nodes[k].get("x", 0)))
    for nid in order:
        s = st[nid]
        p = container(nodes[nid])
        q = p
        while q is not None:             # refuse cycles
            if q is s:
                warn.append(f"state '{s.name}' is nested in itself; moved to the top level")
                p = root
                break
            q = q.parent
        s.parent = p
        p.children.append(s)

    pseudo = {}
    inits = {}
    for nid, n in nodes.items():
        k = n.get("kind")
        if k in KIND:
            pseudo[nid] = Node(KIND[k], n.get("name") or "", container(n))
        elif k == "init":
            inits[nid] = container(n)

    def end(nid):
        return st.get(nid) or pseudo.get(nid)

    trans = []
    # priority among transitions with the same source: the editor's "prio" (1 = checked first),
    # transitions without one after those, in drawing order
    def prio(item):
        i, (eid, e) = item
        try:
            return (float(e["prio"]), i) if e.get("prio") not in (None, "") else (1e9, i)
        except (TypeError, ValueError):
            return (1e9, i)
    for _, (eid, e) in sorted(enumerate(edges.items()), key=prio):
        f, t = e.get("from"), e.get("to")
        ev, tmo = parse_trigger(e.get("trigger"))
        guard, action = (e.get("guard") or "").strip(), e.get("action") or ""
        if f in inits:
            owner, dst = inits[f], end(t)
            if dst is None:
                warn.append("default transition without a target, ignored")
                continue
            if owner.initial is not None:
                warn.append(f"'{owner.name}' has more than one default transition; using the first")
                continue
            owner.initial = Trans(owner, dst, guard=guard, action=action)
            continue
        src, dst = end(f), end(t)
        if src is None or dst is None:
            warn.append(f"transition {eid} has a missing end, ignored")
            continue
        trans.append(Trans(src, dst, ev, tmo, guard, action))
        if ev and ev not in [x.name for x in events]:
            events.append(Event(ev))
            warn.append(f"event '{ev}' is not declared; added without arguments")
    for nid, s in st.items():
        for r in nodes[nid].get("reactions") or []:
            ev, tmo = parse_trigger(r.get("trigger"))
            if not (ev or tmo) and not (r.get("action") or "").strip():
                continue
            trans.append(Trans(s, s, ev, tmo, (r.get("guard") or "").strip(), r.get("action") or "", True))
            if ev and ev not in [x.name for x in events]:
                events.append(Event(ev))
    m = Machine(root, list(pseudo.values()), trans, warn)
    m.finalize()
    return m, warn
