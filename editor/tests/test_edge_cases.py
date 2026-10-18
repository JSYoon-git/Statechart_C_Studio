"""Edge cases a user can draw: does generation fail cleanly, or produce C that builds?

    python editor/tests/test_edge_cases.py

Every case is a small project. Expected outcome per case:
  "build"   - generates and compiles
  "reject"  - the server refuses with a clear error (no traceback-only failure)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import server  # noqa: E402


def proj(states, edges=(), events=(), attrs=(), package="T", cls="M", extra=None):
    nodes = {"i0": {"kind": "init", "x": 0, "y": 0, "parent": None, "region": 0}}
    E = {}
    first = None
    for i, s in enumerate(states):
        sid = s.get("id", f"s{i}")
        nodes[sid] = {"kind": "state", "name": s["name"], "x": 100 * i, "y": 0, "w": 150, "h": 60,
                      "parent": s.get("parent"), "region": s.get("region", 0), "entry": s.get("entry", ""),
                      "exit": "", "reactions": [], **({"and": True, "regions": s["regions"]} if "regions" in s else {})}
        if first is None and not s.get("parent"):
            first = sid
    if first:
        E["e0"] = {"from": "i0", "to": first}
    for i, (a, b, trig) in enumerate(edges, 1):
        E[f"e{i}"] = {"from": a, "to": b, "trigger": trig, "guard": "", "action": ""}
    p = {"package": package, "types": [], "events": [{"name": n, "args": a} for n, a in events],
         "classes": [{"name": cls, "attributes": [{"type": t, "name": n, "default": d} for t, n, d in attrs],
                      "operations": [], "assocs": [], "init": "", "chart": {"nodes": nodes, "edges": E}}]}
    if extra:
        extra(p)
    return p


CASES = [
    ("empty project (no states)", proj([]), "build"),
    ("one state", proj([{"name": "A"}]), "build"),
    ("state named like a C keyword", proj([{"name": "default"}, {"name": "int"}], [("s0", "s1", "evGo")], [("evGo", [])]), "build"),
    ("state named like framework names", proj([{"name": "rootState"}, {"name": "me"}, {"name": "res"}],
                                             [("s0", "s1", "ev"), ("s1", "s2", "ev")], [("ev", [])]), "build"),
    ("state with the class's name", proj([{"name": "M"}, {"name": "B"}], [("s0", "s1", "ev")], [("ev", [])]), "build"),
    ("duplicate state names in different parents",
     proj([{"name": "P", "id": "p"}, {"name": "Q", "id": "q"}, {"name": "X", "id": "x1", "parent": "p"},
           {"name": "X", "id": "x2", "parent": "q"}], [("p", "q", "ev"), ("x1", "x2", "ev2")], [("ev", []), ("ev2", [])]),
     "build"),
    ("event named like a state", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "B")], [("B", [])]), "build"),
    ("event named like the class", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "M")], [("M", [])]), "reject"),
    ("variable named like a C keyword", proj([{"name": "A"}], attrs=[("int", "switch", "0")]), "reject"),
    ("variable named like generated members", proj([{"name": "A"}], attrs=[("int", "ric_reactive", "0")]), "reject"),
    ("event argument named 'me'", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "ev")], [("ev", [{"type": "int", "name": "me"}])]), "build"),
    ("package named like the class", proj([{"name": "A"}], package="M"), "build"),
    ("undeclared event", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "evNew")]), "build"),
    ("timeout with expression", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(100 * 2)")]), "build"),
    ("event with float and char* args", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "ev")],
                                             [("ev", [{"type": "float", "name": "f"}, {"type": "const char *", "name": "s"}])]), "build"),
    ("composite without default transition",
     proj([{"name": "P", "id": "p"}, {"name": "A", "id": "a", "parent": "p"}, {"name": "B", "id": "b", "parent": "p"}]), "build"),
    ("AND state with empty region",
     proj([{"name": "P", "id": "p", "regions": [{"name": "r0"}, {"name": "r1"}]}, {"name": "A", "id": "a", "parent": "p"}]), "build"),
    ("event declared twice", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "ev")], [("ev", []), ("ev", [])]), "reject"),
    ("Korean state name", proj([{"name": "대기"}]), "reject"),
    ("state name with spaces", proj([{"name": "my state"}]), "reject"),
    ("user code with a syntax error", proj([{"name": "A", "entry": "this is not C"}]), "build-fails"),
    # ---- task-style code: inputs / outputs / period
    ("input named like a state, IS_IN(state) in a guard",
     proj([{"name": "fault"}, {"name": "ok"}], [("s0", "s1", "")], extra=lambda p: (
         p["classes"][0]["attributes"].append({"type": "bool", "name": "fault", "dir": "in", "sig": "event"}),
         p["classes"][0]["chart"]["edges"]["e1"].update(guard="fault && IS_IN(fault)"))), "build"),
    ("variable named 'me'", proj([{"name": "A"}], attrs=[("int", "me", "0")]), "reject"),
    ("variable ending in _tm (allowed: no generated timers)", proj([{"name": "A"}], attrs=[("int", "A_tm", "0")]), "build"),
    ("three outputs (o_ pointers) and 10 us period with tm(5000)",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(5000)")], extra=lambda p: (
         p["classes"][0].update(periodUs=10),
         p["classes"][0]["attributes"].extend([{"type": "uint8_t", "name": f"o{i}", "dir": "out"} for i in range(3)]))), "build"),
    ("old tm(25): converted to a counter (3 calls)", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(25)")]), "build"),
    ("old tm(0): converted (fires on the first call)", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(0)")]), "build"),
    ("tm(25) on a 5 ms system Task", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(25)")],
                                          extra=lambda p: p.update(periodUs=5000)), "build"),
    ("system 100 ms, class overrides to 10 ms: tm(30) ok for the class",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(30)")], extra=lambda p: (
         p.update(periodUs=100000), p["classes"][0].update(periodUs=10000))), "build"),
    ("old project with a 100 ms period: tm(30) converted", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(30)")],
                                           extra=lambda p: p.update(periodUs=100000)), "build"),
    ("tm(expression) on a 300 us task (runtime conversion)", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(t)")],
         attrs=[("uint32_t", "t", "3u")], extra=lambda p: p.update(periodUs=300)), "build"),
    ("input linked to something that is not an output",
     proj([{"name": "A"}], extra=lambda p: p["classes"][0]["attributes"].append(
         {"type": "bool", "name": "x", "dir": "in", "link": "Nope.y"})), "build"),
    ("period 0 us", proj([{"name": "A"}], extra=lambda p: p["classes"][0].update(periodUs=0)), "build"),
    ("old period field (ignored: always the 10 ms task)", proj([{"name": "A"}], extra=lambda p: p["classes"][0].update(periodUs=-5)), "build"),
    # ---- struct style: X_Main(me, const X_In* in, X_Out* out)
    ("struct style, outputs only (no in parameter)",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(100)")], extra=lambda p: (
         p["classes"][0].update(ioStyle="struct"),
         p["classes"][0]["attributes"].extend([{"type": "uint8_t", "name": "o1", "dir": "out"}]),
         p["classes"][0]["chart"]["edges"]["e1"].update(action="o1 = 3u;"))), "build"),
    ("struct style, inputs only (no out parameter)",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "")], extra=lambda p: (
         p["classes"][0].update(ioStyle="struct"),
         p["classes"][0]["attributes"].extend([{"type": "bool", "name": "go", "dir": "in", "sig": "event"}]),
         p["classes"][0]["chart"]["edges"]["e1"].update(guard="go"))), "build"),
    ("struct style, no inputs and no outputs", proj([{"name": "A"}], extra=lambda p: p["classes"][0].update(ioStyle="struct")), "build"),
    ("struct style, variable named 'in'",
     proj([{"name": "A"}], extra=lambda p: (p["classes"][0].update(ioStyle="struct"),
                                           p["classes"][0]["attributes"].append({"type": "int", "name": "in", "dir": "local"}))), "reject"),
    ("struct style, state named 'In' (clashes with M_In)",
     proj([{"name": "In"}], extra=lambda p: p["classes"][0].update(ioStyle="struct")), "reject"),
    ("parameter style, variable named 'in' is fine",
     proj([{"name": "A"}], attrs=[("int", "in", "0")]), "build"),
    ("prio given as text / garbage (ignored, drawing order)",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(10)"), ("s0", "s1", "tm(20)")], extra=lambda p: (
         p["classes"][0]["chart"]["edges"]["e1"].update(prio="x"),
         p["classes"][0]["chart"]["edges"]["e2"].update(prio="1"))), "build"),
    ("tm(expression) on several transitions of one state",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(t1)"), ("s0", "s1", "tm(t2 * 2u)"), ("s0", "s1", "tm(t1)")],
          attrs=[("uint32_t", "t1", "100u"), ("uint32_t", "t2", "50u")]), "build"),
    ("old tm() on an internal reaction (converted)", proj([{"name": "A"}], extra=lambda p:
        p["classes"][0]["chart"]["nodes"]["s0"].update(reactions=[{"trigger": "tm(100)", "guard": "", "action": ""}])), "build"),
    ("variable 'cnt_A' already used: the converted counter gets another name",
     proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "tm(100)")], attrs=[("int", "cnt_A", "0")]), "build"),
    ("float input and output", proj([{"name": "A"}, {"name": "B"}], [("s0", "s1", "")], extra=lambda p: (
        p["classes"][0]["attributes"].extend([{"type": "float", "name": "t", "dir": "in"}, {"type": "float", "name": "y", "dir": "out"}]),
        p["classes"][0]["chart"]["edges"]["e1"].update(guard="t > 1.5f", action="y = t * 2.0f;"))), "build"),
]


def main():
    tmp = tempfile.mkdtemp(prefix="sc_edge_")
    server.OUT = tmp
    bad = 0
    for name, p, want in CASES:
        try:
            pkg, out, files, warn = server.do_generate(json.loads(json.dumps(p)))
            ok, log = server.do_build(out)
            got = "build" if ok else "build-fails"
            detail = (log.splitlines() or [""])[0][:120]
        except Exception as ex:   # the server turns these into a JSON error for the UI
            got, detail = "reject", f"{type(ex).__name__}: {ex}"
        status = "ok  " if got == want else "FAIL"
        bad += got != want
        print(f"{status} {name:42} expected {want:12} got {got:12} {detail if got != 'build' else ''}")
    print(f"\n{len(CASES) - bad}/{len(CASES)} as expected")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
