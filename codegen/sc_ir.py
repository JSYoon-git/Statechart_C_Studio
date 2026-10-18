"""Statechart intermediate representation + two front ends.

    load_rhapsody(project_path) -> Package   (reads .rpyx/.sbsx via ../render.py)
    load_json(path)             -> Package   (hand-written statecharts)

The IR only keeps what code generation needs: the state tree, pseudo-state
nodes (condition, junction, history, diagram connector, termination), the
transitions between them, the class members the action code refers to, and
the events.
"""
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

LEAF, OR, AND = "leaf", "or", "and"


def cident(s):
    s = re.sub(r"\W+", "_", (s or "").strip())
    return ("_" + s) if s[:1].isdigit() else (s or "anon")


def decode(body):
    """Rhapsody stores line breaks in code bodies as %0D, '%' as %25."""
    if not body:
        return ""
    return body.replace("%0D\n", "\n").replace("%0D", "\n").replace("%25", "%").strip()


@dataclass(eq=False)
class State:
    name: str
    parent: Optional["State"] = None
    children: List["State"] = field(default_factory=list)
    is_and: bool = False
    entry: str = ""
    exit: str = ""
    initial: Optional["Trans"] = None      # default transition of a composite
    final: bool = False
    cname: str = ""                         # unique C identifier, set by Machine
    index: int = -1

    @property
    def kind(self):
        if self.is_and:
            return AND
        return OR if self.children or self.parent is None else LEAF


@dataclass(eq=False)
class Node:
    """Pseudo-state: cond | junction | history | diagram | term"""
    kind: str
    name: str = ""
    parent: Optional[State] = None
    outgoing: List["Trans"] = field(default_factory=list)


@dataclass(eq=False)
class Trans:
    src: object                      # State | Node
    dst: object                      # State | Node
    event: str = ""                  # event name ("" = no event trigger)
    timeout: str = ""                # tm(...) expression in ms
    guard: str = ""
    action: str = ""
    internal: bool = False           # Rhapsody static reaction


@dataclass
class Arg:
    type: str
    name: str


@dataclass
class Event:
    name: str
    args: List[Arg] = field(default_factory=list)
    triggered: str = ""            # owner class when this is a triggered operation


@dataclass
class Attribute:
    type: str
    name: str
    default: str = ""
    dir: str = "local"             # "in" | "out" | "local"   (task-style code: X_Main parameters)


@dataclass
class Operation:
    name: str
    ret: str = "void"
    args: List[Arg] = field(default_factory=list)
    body: str = ""
    triggered: bool = False         # Rhapsody triggered operation: a synchronous trigger


@dataclass
class Assoc:
    name: str
    other: str            # class name
    many: bool = False


@dataclass
class Machine:
    root: State
    nodes: List[Node]
    transitions: List[Trans]
    warnings: List[str] = field(default_factory=list)

    def states(self):
        out = []

        def rec(s):
            out.append(s)
            for c in s.children:
                rec(c)
        rec(self.root)
        return out

    def finalize(self):
        """Assign indices and unique C names (parent-qualified on clashes)."""
        seen = {}
        for i, s in enumerate(self.states()):
            s.index = i
            base = "ROOT" if s.parent is None else cident(s.name)
            seen.setdefault(base, []).append(s)
        for base, group in seen.items():
            for s in group:
                s.cname = base
                if len(group) > 1 and s.parent is not None:
                    s.cname = f"{cident(s.parent.name or 'ROOT')}_{base}"
        for t in self.transitions:
            if isinstance(t.src, Node):
                t.src.outgoing.append(t)


@dataclass
class Class:
    name: str
    attributes: List[Attribute] = field(default_factory=list)
    operations: List[Operation] = field(default_factory=list)
    assocs: List[Assoc] = field(default_factory=list)
    init_body: str = ""
    machine: Optional[Machine] = None
    period_us: int = 10000          # X_Main call period (task-style code)
    main_body: Optional[str] = None  # user code of X_Main; None = default X_takeTrigger(me);
    io_struct: bool = False          # X_Main(me, const X_In* in, X_Out* out) instead of i_/o_ parameters


@dataclass
class Package:
    name: str
    classes: List[Class]
    events: List[Event]
    types: List[str] = field(default_factory=list)     # verbatim C declarations
    warnings: List[str] = field(default_factory=list)


# ==========================================================================
# Rhapsody front end
# ==========================================================================
def _tname(h, prj):
    """Type handle / embedded IType -> C type text."""
    if not isinstance(h, dict):
        return "int"
    if h.get("_hname"):
        return h["_hname"]
    t = prj.get(h)
    if t is not None and t.get("_name"):
        return t["_name"]
    return h.get("_name") or "int"


def _args(lst, prj):
    out = []
    for a in lst or []:
        if isinstance(a, dict):
            out.append(Arg(_tname(a.get("_typeOf"), prj), a.get("_name") or "arg"))
    return out


def load_rhapsody(path, only=None):
    from render import Project        # the archive reader from the viewer
    prj = Project(path)
    objs = list(prj.index.values())

    def body_of(x):
        x = prj.get(x) if isinstance(x, str) else x
        return decode((x or {}).get("_body", "")) if isinstance(x, dict) else ""

    events = {}
    for o in objs:
        if o.cls == "IEvent" and o.get("_name"):
            events[o["_name"]] = Event(o["_name"], _args(o.get("Args"), prj))

    types = []
    for o in objs:
        if o.cls == "IType" and o.get("_declaration") and o.get("_name"):
            decl = decode(o["_declaration"]).replace("%s", o["_name"])
            if decl and decl not in types:
                types.append(decl)

    classes, warnings = [], []
    for o in objs:
        if o.cls != "IClass" or not o.get("_name") or o["_name"] == "TopLevel":
            continue
        if only and o["_name"] not in only:
            continue
        kids = [prj.get(g) for g in o.get("AggregatesList") or []]
        kids = [k for k in kids if k is not None]
        c = Class(cident(o["_name"]))
        for k in kids:
            if k.cls == "IAttribute":
                c.attributes.append(Attribute(_tname(k.get("_typeOf"), prj), k["_name"],
                                              decode(k.get("_defaultValue", ""))))
            elif k.cls in ("IPrimitiveOperation", "ITriggered"):
                c.operations.append(Operation(cident(k["_name"]), _tname(k.get("_returnType"), prj)
                                              if k.get("_returnType") else "void",
                                              _args(k.get("Args"), prj),
                                              decode((k.get("_itsBody") or {}).get("_bodyData", ""))))
            elif k.cls == "IConstructor":
                c.init_body = decode((k.get("_itsBody") or {}).get("_bodyData", ""))
            elif k.cls in ("IAssociationEnd", "IPart") and k.get("_name"):
                other = prj.get(k.get("_otherClass") or k.get("_implicitClass"))
                if other is not None and other.get("_name"):
                    many = (k.get("_multiplicity") or "1").strip() not in ("1", "0,1", "")
                    c.assocs.append(Assoc(cident(k["_name"]), cident(other["_name"]), many))
        sc = prj.get(o.get("_itsStateChart"))
        if sc is not None:
            c.machine = _rhp_machine(prj, sc, body_of, events)
            warnings += [f"{c.name}: {w}" for w in c.machine.warnings]
        classes.append(c)

    # only events that some class can receive or send matter, keep all for simplicity
    return Package(cident(prj.name), classes, list(events.values()), types, warnings)


def _rhp_machine(prj, sc, body_of, events):
    # collect every object that belongs to this statechart
    members, todo, seen = [], list(sc.get("AggregatesList") or []), set()
    while todo:
        o = prj.get(todo.pop())
        if o is None or id(o) in seen:
            continue
        seen.add(id(o))
        members.append(o)
        todo += o.get("AggregatesList") or []
    warn = []
    states, nodes = {}, {}
    for o in members:
        if o.cls == "IState":
            states[o.id] = State(o.get("_name") or "", is_and=o.get("_stateType") == "And",
                                 entry=body_of(o.get("_entryAction")), exit=body_of(o.get("_exitAction")),
                                 final=o.get("_stateType") == "LocalTermination")
            if o.get("_stateType") in ("Action", "Block", "SubActivity"):
                warn.append(f"activity state '{o.get('_name')}' treated as a plain state")
            if o.get("_nestedStateChart"):
                warn.append(f"sub-statechart of '{o.get('_name')}' is not merged (not supported)")
        elif o.cls in ("IBranch", "IConnector", "IHistoryConnector", "IJunction"):
            ct = o.get("_connectorType", "")
            kind = {"Condition": "cond", "Junction": "junction", "History": "history",
                    "Diagram": "diagram", "Stub": "diagram", "Termination": "term"}.get(ct)
            if o.cls == "IBranch":
                kind = "cond"
            if kind is None:
                warn.append(f"connector type '{ct}' not supported, ignored")
                continue
            nodes[o.id] = Node(kind, o.get("_name") or "")
    root = None
    for o in members:
        if o.id in states:
            s, p = states[o.id], states.get(prj.get(o.get("_parent")).id if prj.get(o.get("_parent")) else None)
            if p is None:
                root = root or s
            else:
                s.parent = p
                p.children.append(s)
        elif o.id in nodes:
            p = prj.get(o.get("_parent"))
            nodes[o.id].parent = states.get(p.id) if p is not None else None
    if root is None:
        raise ValueError("statechart without a root state")
    # a state is a termination pseudo-state when Rhapsody says LocalTermination and it has no children
    for s in states.values():
        if s.parent is not None and s.parent.is_and:
            pass  # regions: kind derives from children

    def node_of(ref):
        x = prj.get(ref)
        if x is None:
            return None
        return states.get(x.id) or nodes.get(x.id)

    def label(t):
        lab = None
        for g in t.get("AggregatesList") or []:
            x = prj.get(g)
            if x is not None and x.cls == "ILabel":
                lab = x
        lab = lab or (t.get("_itsLabel") if isinstance(t.get("_itsLabel"), dict) else prj.get(t.get("_itsLabel")))
        if not isinstance(lab, dict):
            return "", "", "", ""
        # parts live either in the _its* fields or, flattened, in the label's AggregatesList
        parts = {"trig": lab.get("_itsTrigger"), "guard": lab.get("_itsGuard"), "act": lab.get("_itsAction")}
        for k, v in parts.items():
            parts[k] = prj.get(v) if isinstance(v, str) else v
        for g in lab.get("AggregatesList") or []:
            x = prj.get(g)
            if x is None:
                continue
            if x.cls in ("IInterfaceItemTrigger", "ITimeout", "ITrigger") and not parts["trig"]:
                parts["trig"] = x
            elif x.cls == "IGuard" and not parts["guard"]:
                parts["guard"] = x
            elif x.cls == "IAction" and not parts["act"]:
                parts["act"] = x
        trig = parts["trig"]
        ev = tmo = ""
        if isinstance(trig, dict):
            if trig.get("_cls") == "ITimeout" or (trig.get("_body") or "").startswith("tm("):
                m = re.match(r"\s*tm\s*\((.*)\)\s*$", decode(trig.get("_body", "")), re.S)
                tmo = m.group(1) if m else (trig.get("_time") or "0")
            else:
                ev = decode(trig.get("_body", ""))
                ev = re.sub(r"\(.*", "", ev).strip()
        return ev, tmo, body_of(parts["guard"]), body_of(parts["act"])

    trans = []
    for o in members:
        if o.cls not in ("ITransition", "IDefaultDrvdTrans"):
            continue
        ev, tmo, guard, action = label(o)
        dst = node_of(o.get("_itsTarget"))
        if o.cls == "IDefaultDrvdTrans":
            owner = node_of(o.get("_ofState")) or node_of(o.get("_itsSource"))
            if isinstance(owner, State) and dst is not None:
                if owner.is_and:
                    # a region's default arrow is owned by the AND state: give it
                    # to the region that contains the target
                    probe = dst if isinstance(dst, State) else dst.parent
                    while probe is not None and probe.parent is not owner:
                        probe = probe.parent
                    owner = probe or owner
                owner.initial = Trans(owner, dst, guard=guard, action=action)
            continue
        src = node_of(o.get("_itsSource"))
        if src is None or (dst is None and o.get("_staticReaction") != "1"):
            warn.append(f"transition '{o.get('_name')}' has an unresolved end, skipped")
            continue
        internal = o.get("_staticReaction") == "1"
        if ev and ev not in events:
            events[ev] = Event(ev)
        trans.append(Trans(src, dst or src, ev, tmo, guard, action, internal))
    m = Machine(root, list(nodes.values()), trans, warn)
    m.finalize()
    return m


# ==========================================================================
# JSON front end
# ==========================================================================
def load_json(path):
    spec = json.load(open(path, encoding="utf-8"))
    events = [Event(n, [Arg(a["type"], a["name"]) for a in args]) for n, args in spec.get("events", {}).items()]
    classes = []
    for cs in spec.get("classes", [spec] if "statechart" in spec else []):
        c = Class(cident(cs["name"]),
                  [Attribute(a["type"], a["name"], a.get("default", "")) for a in cs.get("attributes", [])],
                  [Operation(op["name"], op.get("ret", "void"), [Arg(a["type"], a["name"]) for a in op.get("args", [])],
                             op.get("body", "")) for op in cs.get("operations", [])],
                  [Assoc(a["name"], a["class"], a.get("many", False)) for a in cs.get("assocs", [])],
                  cs.get("init", ""))
        if "statechart" in cs:
            c.machine = _json_machine(cs["statechart"], events)
        classes.append(c)
    return Package(cident(spec.get("package", os.path.splitext(os.path.basename(path))[0])),
                   classes, events, spec.get("types", []))


def _json_machine(sc, events):
    by_name, nodes = {}, {}

    def build(name, sp, parent):
        s = State(name, parent, entry=sp.get("entry", ""), exit=sp.get("exit", ""), final=sp.get("final", False))
        if name in by_name:
            raise ValueError(f"duplicate state name '{name}'")
        by_name[name] = s
        if parent is not None:
            parent.children.append(s)
        if "regions" in sp:                       # AND state
            s.is_and = True
            for i, r in enumerate(sp["regions"]):
                build(r.get("name", f"{name}_r{i}"), r, s)
        for cn, cp in sp.get("states", {}).items():
            build(cn, cp, s)
        if sp.get("history"):
            nodes[f"{name}.H"] = Node("history", "H", s)
        s._json_initial = sp.get("initial")
        return s

    root = build("ROOT", {"states": sc["states"], "initial": sc.get("initial")}, None)

    def ref(n):
        if n in by_name:
            return by_name[n]
        if n in nodes:
            return nodes[n]
        raise ValueError(f"unknown state '{n}'")

    trans = []
    for i, t in enumerate(sc.get("transitions", [])):
        src = ref(t["from"])
        if "choice" in t:                          # condition connector inline
            node = Node("cond", f"c{i}", src.parent)
            nodes[f"c{i}"] = node
            trans.append(Trans(src, node, t.get("trigger", ""), str(t.get("after", "")) if "after" in t else "",
                               t.get("guard", ""), t.get("action", "")))
            for br in t["choice"]:
                trans.append(Trans(node, ref(br["to"]), guard=br.get("guard", ""), action=br.get("action", "")))
            continue
        internal = "to" not in t
        trans.append(Trans(src, ref(t["to"]) if not internal else src, t.get("trigger", ""),
                           str(t["after"]) if "after" in t else "", t.get("guard", ""), t.get("action", ""), internal))
        if t.get("trigger") and t["trigger"] not in [e.name for e in events]:
            events.append(Event(t["trigger"]))
    for s in by_name.values():
        if s._json_initial:
            s.initial = Trans(s, ref(s._json_initial))
    m = Machine(root, list(nodes.values()), trans)
    m.finalize()
    return m
