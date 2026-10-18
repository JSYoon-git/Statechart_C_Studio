"""Shared building blocks of the C generator (task_c.py): the state tree helpers and the base class that
writes entry / exit / dispatch code for one class of the statechart IR (sc_ir.Package).
"""
import os  # noqa: F401
import re

from sc_ir import AND, OR, Node, State, cident  # noqa: F401

_IS_IN1 = re.compile(r"\bIS_IN\s*\(\s*([A-Za-z_]\w*)\s*\)")

def ind(code, n):
    pad = " " * n
    return "\n".join(pad + ln if ln.strip() else "" for ln in code.splitlines())

def user_code(code):
    """Accept the one-argument IS_IN(state) form too (written as IS_IN(me, state) in the generated code)."""
    return _IS_IN1.sub(r"IS_IN(me, \1)", (code or "").strip())

def user_block(code, n, tag):
    code = user_code(code)
    if not code:
        return []
    return [" " * n + f"/*#[ {tag} */", " " * n + "{", ind(code, n + 4), " " * n + "}", " " * n + "/*#]*/"]

def ancestors(s):
    out = []
    while s is not None:
        out.append(s)
        s = s.parent
    return out

def is_region(s):
    return s.parent is not None and s.parent.is_and

def composite(s):
    return s.kind in (OR, AND) or is_region(s)

def ctype_kind(t):
    t = t.replace("const", "").strip()
    if any(k in t for k in ("float", "double")):
        return "f"
    if "*" in t:
        return "s" if "char" in t else None
    return "i"

class ClassGen:
    """Base of TaskGen: the parts of the code writer that do not depend on the output style."""

    def __init__(self, pkg, cls):
        self.pkg, self.c, self.m = pkg, cls, cls.machine
        self.n = cls.name
        self.ev = {e.name: e for e in pkg.events}
        self.warn = []
        self.timeouts = {}            # Trans -> timeout id name
        self.timers_of = {}           # State -> [(timeout id name, delay expr)]; one timer per delay
        self.hist = {}                # State -> history Node
        self.uses_term = False
        if not self.m:
            return
        self.m.root.cname = "rootState"
        for t in self.m.transitions:
            if t.timeout and isinstance(t.src, State):
                lst = self.timers_of.setdefault(t.src, [])
                expr = t.timeout.strip()
                tid = next((i for i, e in lst if e == expr), None)
                if tid is None:
                    tid = f"{self.n}_Timeout_{t.src.cname}_id" + (f"_{len(lst)}" if lst else "")
                    lst.append((tid, expr))
                self.timeouts[t] = tid
        for nd in self.m.nodes:
            if nd.kind == "history" and nd.parent is not None:
                self.hist[nd.parent] = nd
            if nd.kind == "term":
                self.uses_term = True
        self.states = self.m.states()
        self.by_src = {}
        for t in self.m.transitions:
            if isinstance(t.src, State):
                self.by_src.setdefault(t.src, []).append(t)

    def E(self, s):
        return f"{self.n}_{s.cname}"                  # enum value

    def complete(self, mode, owner, dst, acts, n, label, var="res"):
        """Lines that finish a transition from `owner` to `dst`.
        mode 'trans': exits + actions + entries; 'init': default transition."""
        sp = " " * n
        if isinstance(dst, Node):
            dst = self.follow_diagram(dst)
            if dst.kind in ("cond", "junction") or (dst.kind == "diagram" and dst.outgoing):
                out, first = [], True
                for b in sorted(dst.outgoing, key=lambda b: b.guard.strip() == "else"):
                    g = self.ucode(b.guard)
                    if g == "else" or not g:
                        out.append(sp + ("else {" if not first else "{"))
                    else:
                        out.append(sp + f"{'if' if first else 'else if'} ({g}) {{")
                    out += self.complete(mode, owner, b.dst, acts + [b.action], n + 4, label, var)
                    out.append(sp + "}")
                    first = False
                    if g == "else" or not g:
                        break
                return out
            if dst.kind == "history":
                target, hist = dst.parent, True
            elif dst.kind == "term":
                out = []
                if mode == "trans":
                    out.append(sp + "rootState_exit(me);")
                for a in acts:
                    out += self.ublock(a, n, f"transition {label}")
                out.append(sp + self.terminate_line())
                if mode == "trans":
                    out.append(sp + f"{var} = {self.YES};")
                return out
            else:
                self.warn.append(f"unsupported connector '{dst.kind}' after '{owner.name}'")
                return [sp + "/* unsupported connector */"]
        else:
            target, hist = dst, False
        out = []
        if mode == "trans":
            lca, main = self.domain(owner, target)
            out += self.exit_lines(main, n)
        else:
            lca = owner
        out.append(sp + self.trace_trans(label))
        for a in acts:
            out += self.ublock(a, n, f"transition {label}")
        out += self.enter_path(lca, target, hist, n)
        if mode == "trans":
            out.append(sp + f"{var} = {self.YES};")
        return out

    def composite_funcs(self, s):
        n = self.n
        L = [f"/* {self.nm(s)} */", f"static void {s.cname}_entDef({n}* const me) {{"]
        L += self.enter_lines(s, 4)
        if s.is_and:
            for r in s.children:
                L += self.entdef_lines(r, 4)
        else:
            L += self.default_code(s, 4)
        L += ["}", ""]
        if s in self.hist:
            h = self.hist[s]
            L.append(f"static void {s.cname}_histEntDef({n}* const me) {{")
            L += self.enter_lines(s, 4)
            L.append(f"    switch (me->{s.cname}_lastState) {{")
            for k in s.children:
                L.append(f"        case {self.E(k)}:")
                L += self.entdef_lines(k, 12)
                L.append("            break;")
            L.append("        default:")
            if h.outgoing:
                L += self.complete("init", s, h.outgoing[0].dst, [h.outgoing[0].action], 12, f"{self.nm(s)}.H>default")
            else:
                L += self.default_code(s, 12)
            L += ["            break;", "    }", "}", ""]
        L.append(f"static void {s.cname}_exit({n}* const me) {{")
        L += self.exit_body(s)
        L += self.leave_lines(s, 4)
        L += ["}", ""]
        return L

    def default_code(self, s, n):
        if s.initial is not None:
            return self.complete("init", s, s.initial.dst, [s.initial.action], n,
                                 f"{self.nm(s)}>{self.tname(s.initial.dst)}")
        kids = s.children
        if len(kids) == 1 and not s.is_and:
            self.warn.append(f"'{self.nm(s)}' has no default transition; entering its only substate")
            return self.entdef_lines(kids[0], n)
        if kids and not s.is_and:
            self.warn.append(f"composite '{self.nm(s)}' has no default transition")
        return []

    def dispatch_lines(self, c, n, var):
        sp = " " * n
        L = []
        if c.is_and:
            for i, r in enumerate(c.children):
                if not self.handles(r):
                    continue
                rv = f"res_{r.cname}"
                L.append(sp + (f"if ({self.n}_isIn(me, {self.E(c)})) {{" if L else "{")
                         + f"    /* region {r.name} */")
                L.append(sp + f"    {self.STATUS} {rv} = {self.NO};")
                L += self.dispatch_lines(r, n + 4, rv)
                L.append(sp + f"    if ({rv} == {self.YES})")
                L.append(sp + f"        {var} = {self.YES};")
                L.append(sp + "}")
            return L
        kids = [k for k in c.children if self.handles(k)]
        if not kids:
            return L
        L.append(sp + f"switch ({self.sub(c)}) {{")
        for k in kids:
            L.append(sp + f"    case {self.E(k)}:")
            if composite(k):
                L += self.dispatch_lines(k, n + 8, var)
                if self.by_src.get(k):
                    L.append(sp + f"        if ({var} == {self.NO}) {{")
                    L += self.transitions(k, n + 12, var)
                    L.append(sp + "        }")
            else:
                L += self.transitions(k, n + 8, var)
            L.append(sp + "        break;")
        L += [sp + "    default:", sp + "        break;", sp + "}"]
        return L

    def domain(self, src, tgt):
        sa, ta = ancestors(src), ancestors(tgt)
        if tgt in sa:
            lca = tgt.parent
        elif src in ta:
            lca = src.parent
        else:
            lca = next(a for a in sa if a in ta)
        while lca is not None and lca.is_and:      # across regions: leave the AND state
            lca = lca.parent
        if lca is None:
            lca = self.m.root
        main = next((a for a in sa if a.parent is lca), src)
        return lca, main

    def entdef_lines(self, s, n, hist=False):
        """Enter s and run its default transition(s)."""
        if hist and s in self.hist:
            return [" " * n + f"{s.cname}_histEntDef(me);"]
        if composite(s):
            return [" " * n + f"{s.cname}_entDef(me);"]
        return self.enter_lines(s, n)

    def enter_path(self, lca, target, hist, n):
        path, x = [], target
        while x is not None and x is not lca:
            path.insert(0, x)
            x = x.parent
        if x is None:
            self.warn.append(f"cannot enter '{target.name}' from '{self.nm(lca)}'")
            return []
        out = []

        def go(i):
            s = path[i]
            if i == len(path) - 1:
                out.extend(self.entdef_lines(s, n, hist))
                return
            out.extend(self.enter_lines(s, n))
            nxt = path[i + 1]
            if s.is_and:
                for r in s.children:
                    if r is nxt:
                        go(i + 1)
                    else:
                        out.extend(self.entdef_lines(r, n))
            else:
                go(i + 1)
        if path:
            go(0)
        return out

    def exit_body(self, s):
        L = []
        if s in self.hist:
            L.append(f"    me->{s.cname}_lastState = {self.sub(s)};")
        if s.is_and:
            L += [f"    {r.cname}_exit(me);" for r in s.children]
        elif s.children:
            L.append(f"    switch ({self.sub(s)}) {{")
            for k in s.children:
                L.append(f"        case {self.E(k)}:")
                L += self.exit_lines(k, 12)
                L.append("            break;")
            L += ["        default:", "            break;", "    }"]
        return L

    def exit_lines(self, s, n):
        """Leave s and everything active inside it."""
        if composite(s):
            return [" " * n + f"{s.cname}_exit(me);"]
        return self.leave_lines(s, n)

    def follow_diagram(self, node):
        if node.outgoing or node.kind != "diagram":
            return node
        for x in self.m.nodes:
            if x is not node and x.kind == "diagram" and x.name == node.name and x.outgoing:
                return x
        self.warn.append(f"diagram connector '{node.name}' has no partner")
        return node

    def has_sub(self, s):
        return s.parent is None or (composite(s) and not s.is_and)

    def nm(self, s):
        return s.name or "ROOT"

    def params(self, op):
        return ", ".join([f"{self.n}* const me"] + [f"{a.type} {a.name}" for a in op.args])

    def sub(self, s):
        return f"me->{s.cname}_subState"

    def tname(self, x):
        if isinstance(x, State):
            return self.nm(x)
        if x.kind == "history":
            return f"{x.parent.name}.H"
        return x.kind

    def ublock(self, code, n, tag):
        code = self.ucode(code)
        if not code:
            return []
        return [" " * n + f"/*#[ {tag} */", " " * n + "{", ind(code, n + 4), " " * n + "}", " " * n + "/*#]*/"]
