"""Statechart intermediate representation (what the code generator reads; editor/model.py fills it).

The IR only keeps what code generation needs: the state tree, pseudo-state
nodes (condition, junction, history, diagram connector, termination), the
transitions between them, the class members the action code refers to, and
the events.
"""
import re
from dataclasses import dataclass, field
from typing import List, Optional

LEAF, OR, AND = "leaf", "or", "and"


def cident(s):
    s = re.sub(r"\W+", "_", (s or "").strip())
    return ("_" + s) if s[:1].isdigit() else (s or "anon")


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
    internal: bool = False           # static reaction


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
    triggered: bool = False         # triggered operation: a synchronous trigger


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
