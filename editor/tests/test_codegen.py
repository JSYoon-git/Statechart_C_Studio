"""Code output + build checks (no simulator).

    python editor/tests/test_codegen.py

  * every example generates X.c / X.h / main.c (nothing else) and builds with MSVC /W4 without
    errors or warnings; no #define in the modules except the include guards (X_H and the one STATECHART_BOOL guard of the bool typedef)
  * the generated files are C89: no // comments, no declaration after a statement, no designated
    initializers, no <stdbool.h>, no inline / long long / for-loop declarations (MSVC's C compiler
    takes C99 extras, so this is checked here; the gcc path of Build uses -std=c89 -pedantic)
  * the generated code says what the drawing says:
      - transitions of one state are tested in priority order (prio, else drawing order),
        a transition without guard last
      - X_takeTrigger runs the internal reactions before the transitions
      - an old project's tm(500) becomes the counter pattern  cnt_A >= 50u
      - an old event trigger becomes  ev == true
Exit code 1 if anything fails.
"""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import server  # noqa: E402
import c89_lint  # noqa: E402

EX = os.path.join(HERE, "..", "static", "examples")


def project(edges, attrs=(), reactions=None):
    nodes = {"i0": {"kind": "init", "x": 0, "y": 0, "parent": None, "region": 0}}
    for i, n in enumerate(("A", "B", "C")):
        nodes[n] = {"kind": "state", "name": n, "x": 100 * i, "y": 0, "w": 80, "h": 40, "parent": None,
                    "region": 0, "entry": "", "exit": "", "reactions": []}
    if reactions:
        nodes["A"]["reactions"] = reactions
    E = {"e0": {"from": "i0", "to": "A"}}
    for i, e in enumerate(edges, 1):
        E[f"e{i}"] = {"trigger": "", "guard": "", "action": "", **e}
    return {"package": "P", "types": [], "events": [],
            "classes": [{"name": "M", "attributes": list(attrs), "operations": [], "assocs": [],
                         "init": "", "chart": {"nodes": nodes, "edges": E}}]}


X = {"type": "bool", "name": "x", "default": "false", "dir": "in"}


def order(src, *labels):
    return [src.index(f"/*## transition {lb} */") for lb in labels]


def main():
    server.OUT = tempfile.mkdtemp(prefix="sc_codegen_")
    checks = []

    def check(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    for fn in sorted(os.listdir(EX)):
        pkg, out, files, warnings = server.do_generate(json.load(open(os.path.join(EX, fn), encoding="utf-8")))
        names = sorted(files)
        mods = [c.name for c in pkg.classes]
        want = sorted(set([f"{m}.{x}" for m in mods for x in "ch"] + ["main.c"] + ([f"{pkg.name}.h"] if f"{pkg.name}.h" in files else [])))
        check(f"{fn}: files = {', '.join(names)}", names == want)
        ok, log = server.do_build(out)
        check(f"{fn}: builds with /W4, no warnings", ok and not log.strip(), log[:300])
        defs = [ln for m in mods for f in (f"{m}.c", f"{m}.h") for ln in files[f].splitlines()
                if ln.startswith("#define") and not re.fullmatch(r"#define (\w+_H|STATECHART_BOOL)", ln.strip())]
        check(f"{fn}: no #define in the modules (only include guards)", not defs, str(defs[:3]))
        check(f"{fn}: no generator warnings", not warnings, str(warnings))
        c89 = [pb for f, t in files.items() for pb in c89_lint.problems(f, t)]
        check(f"{fn}: C89 (no //, no mixed declarations, no designated initializers, no stdbool)", not c89, "; ".join(c89[:4]))

    sample = "void f(void) {\n    int a;\n    a = 1;\n    int b;\n    // x\n}\nstatic S s = { .x = 1 };\n"
    check("the C89 lint catches what it should (self test)", len(c89_lint.problems("t.c", sample)) == 3)
    # config value: an X_Init parameter, main.c passes the value from the drawing
    pkg, out, files, _ = server.do_generate(json.load(open(os.path.join(EX, "blink.json"), encoding="utf-8")))
    check("config: void Led_Init(Led* const me, uint16_t c_blinkTicks)",
          "void Led_Init(Led* const me, uint16_t c_blinkTicks);" in files["Led.h"] and "me->blinkTicks = c_blinkTicks;" in files["Led.c"])
    check("config: main.c calls Led_Init(&itsLed, 50u /* blinkTicks */)", "Led_Init(&itsLed, 50u /* blinkTicks */);" in files["main.c"])
    check("config: guard reads it as me->blinkTicks", "if (me->cnt >= me->blinkTicks) {" in files["Led.c"])

    def gen(p):
        _, out, files, w = server.do_generate(json.loads(json.dumps(p)))
        return files["M.c"], w

    src, _ = gen(project([{"from": "A", "to": "B", "guard": "x == true"}, {"from": "A", "to": "C", "guard": "x == true"}], [X]))
    a, b = order(src, "A>B", "A>C")
    check("drawing order: A>B tested before A>C", a < b)
    src, _ = gen(project([{"from": "A", "to": "B", "guard": "x == true", "prio": 2},
                          {"from": "A", "to": "C", "guard": "x == true", "prio": 1}], [X]))
    a, b = order(src, "A>B", "A>C")
    check("prio 1 (A>C) tested before prio 2 (A>B)", b < a)
    src, _ = gen(project([{"from": "A", "to": "B"}, {"from": "A", "to": "C", "guard": "x == true"}], [X]))
    a, b = order(src, "A>B", "A>C")
    check("a transition without guard is tested last", b < a)
    _, w = gen(project([{"from": "A", "to": "B"}, {"from": "A", "to": "C"}]))
    check("two transitions without guard: warning", any("can ever fire" in x for x in w), str(w))
    src, _ = gen(project([{"from": "A", "to": "B", "guard": "cnt >= 50u"}],
                         [{"type": "uint16_t", "name": "cnt", "default": "0", "dir": "local"}],
                         [{"trigger": "", "guard": "", "action": "cnt++;"}]))
    body = src[src.index("static void M_takeTrigger"):]
    check("X_takeTrigger: reactions before transitions",
          body.index("rootState_reactions(me);") < body.index("rootState_dispatch(me);"))
    check("guard is written as drawn: if (me->cnt >= 50u)", "if (me->cnt >= 50u) {" in src)
    src, w = gen(project([{"from": "A", "to": "B", "trigger": "tm(500)"}]))
    check("old tm(500) -> counter cnt_A (entry = 0, reaction ++, guard >= 50u)",
          "me->cnt_A = 0;" in src and "me->cnt_A++;" in src and "if (me->cnt_A >= 50u) {" in src)
    src, w = gen(project([{"from": "A", "to": "B", "trigger": "evGo"}]))
    check("old event trigger -> bool input, guard  evGo == true", "if (me->evGo == true) {" in src, str(w))

    bad = 0
    for name, ok, detail in checks:
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok or not detail else f"\n      {detail}"))
    print(f"\n{len(checks) - bad}/{len(checks)} code output / build checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
