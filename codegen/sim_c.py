"""Simulation harness: a separate sim_main.c that drives the generated modules (never part of them).

It is compiled together with the generated X.c files and runs as a child process of the editor
server. Commands on stdin, one per line:

    S <n> <v0> <v1> ...   set every input (all classes, in order), then call the 10 ms task n times
    R                     X_Init again with the config values of the drawing (a reset)
    I <c0> <c1> ...       X_Init again with these config values (all classes, in order)
    Q                     quit

After every call it prints  @@SNAP {json}  - per class: the active states (their index), the outputs
as the caller got them (struct / return value / o_ pointers) and every other variable of the struct.
@@DONE ends a command. Any other stdout line is the modules' own printf output.
"""
from chart_gen import ctype_kind
from task_c import zero_of

SNAP, DONE = "@@SNAP ", "@@DONE"


def kind_of(t):
    t = t.replace("const", "").strip()
    if t == "bool":
        return "bool"
    return {"f": "float", "i": "int"}.get(ctype_kind(t))      # strings / pointers: null, not settable


def fmt(a, expr):
    """C statement printing `expr` (of attribute a) as a JSON value."""
    t = a.type.replace("const", "").strip()
    k = kind_of(t)
    if k is None:
        return 'printf("null");'
    if k == "float" or "64" in t or "long long" in t:
        return f"pf((double)({expr}));"
    if k == "bool":
        return f'printf("%d", ({expr}) ? 1 : 0);'
    if t.startswith("u") or "unsigned" in t or t == "size_t":
        return f'printf("%lu", (unsigned long)({expr}));'
    return f'printf("%ld", (long)({expr}));'


def sim_main(pkg, gens):
    """Returns (C text, meta). meta tells the UI how to label the values."""
    L = ["/* simulation harness - not part of the generated modules */",
         "#include <stdio.h>", "#include <stdlib.h>", "#include <string.h>"]
    L += [f'#include "{g.n}.h"' for g in gens]
    L += ["", "static void pf(double v) {",
          '    if (v != v || v > 1e300 || v < -1e300) {', '        printf("null");', "    } else {",
          '        printf("%.9g", v);', "    }", "}", ""]

    def io(g, a):
        if g.struct:
            return f"io_{g.n}_{'in' if a.dir == 'in' else 'out'}.{a.name}"
        return f"io_{g.n}_{a.name}"

    for g in gens:
        L.append(f"static {g.n} its{g.n};")
        if g.struct:
            for kind, attrs in (("in", g.ins), ("out", g.outs)):
                if attrs:
                    L.append(f"static {g.n}_{kind.capitalize()} io_{g.n}_{kind};")
        else:
            L += [f"static {a.type} io_{g.n}_{a.name};" for a in g.ins + g.outs]
    L.append("")

    cfg_order = [(g, a) for g in gens for a in g.cfgs if kind_of(a.type)]       # settable config values, in command order
    cfg_idx = {(g.n, a.name): i for i, (g, a) in enumerate(cfg_order)}
    L += [f"static double cfgv[{max(1, len(cfg_order))}];", "", "static void cfg_defaults(void) {"]      # the values written in the drawing
    L += [f"    cfgv[{i}] = (double)({a.default.strip() or zero_of(a.type)});" for i, (g, a) in enumerate(cfg_order)]
    if not cfg_order:
        L.append("    cfgv[0] = 0;")
    L += ["}", "", "static void do_init(void) {"]                  # X_Init of every class: start, reset, Init step
    for g in gens:
        L += [f"    {io(g, a)} = {a.default.strip() or zero_of(a.type)};" for a in g.ins + g.outs]
        args = [f"&its{g.n}"] + [f"({a.type})cfgv[{cfg_idx[(g.n, a.name)]}]" if (g.n, a.name) in cfg_idx
                                 else (a.default.strip() or zero_of(a.type)) for a in g.cfgs]
        L.append(f"    {g.n}_Init({', '.join(args)});")
    for g in gens:
        for a in g.c.assocs:
            if any(x.n == a.other for x in gens):
                L.append(f"    its{g.n}.{a.name} = &its{a.other};")
    L += ["}", "", "static void task(void) {"]
    for g in gens:
        if g.struct:
            args = [f"&its{g.n}"] + ([f"&io_{g.n}_in"] if g.ins else []) + ([f"&io_{g.n}_out"] if g.outs else [])
            L.append(f"    {g.n}_Main({', '.join(args)});")
        else:
            L += ["    " + x for x in g.call(f"&its{g.n}", {a.name: f"io_{g.n}_{a.name}" for a in g.ins},
                                             {a.name: f"io_{g.n}_{a.name}" for a in g.outs})]
    L += ["}", ""]

    # snapshot: {"c":[{"s":[state idx..],"o":[outputs..],"v":[variables..]}, ...]}
    L += ["static void snap(void) {", "    int k;"]
    L.append(f'    printf("{SNAP}{{\\"c\\":[");')
    for i, g in enumerate(gens):
        if i:
            L.append('    printf(",");')
        L += ["    k = 0;", '    printf("{\\"s\\":[");']
        if g.m:
            for s in g.states[1:]:
                if getattr(s, "node_id", None) is not None:
                    L.append(f'    if ({g.n}_isIn(&its{g.n}, {g.E(s)})) {{ printf("%s%d", k++ ? "," : "", {s.index}); }}')
        L.append('    printf("],\\"o\\":[");')
        for j, a in enumerate(g.outs):
            if j:
                L.append('    printf(",");')
            L.append("    " + fmt(a, io(g, a)))
        L.append('    printf("],\\"v\\":[");')
        for j, a in enumerate([a for a in g.c.attributes if a.dir != "out"]):
            if j:
                L.append('    printf(",");')
            L.append("    " + fmt(a, f"its{g.n}.{a.name}"))
        L.append('    printf("]}");')
    L += ['    printf("]}\\n");', "    fflush(stdout);", "}", ""]

    meta = {"classes": [], "input_order": [], "config_order": [[g.n, a.name] for g, a in cfg_order]}
    for g in gens:
        cm = {"name": g.n, "states": [], "ins": [], "outs": [], "vars": [], "cfgs": []}
        cm["cfgs"] = [{"name": a.name, "type": a.type, "kind": kind_of(a.type), "default": a.default.strip() or zero_of(a.type)}
                      for a in g.cfgs]
        if g.m:
            cm["states"] = [{"idx": s.index, "name": s.name, "node": s.node_id}
                            for s in g.states[1:] if getattr(s, "node_id", None) is not None]
        for a in g.ins:
            k = kind_of(a.type)
            cm["ins"].append({"name": a.name, "type": a.type, "kind": k, "default": a.default.strip() or zero_of(a.type)})
            if k:
                meta["input_order"].append([g.n, a.name])
        cm["outs"] = [{"name": a.name, "type": a.type, "kind": kind_of(a.type)} for a in g.outs]
        cm["vars"] = [{"name": a.name, "type": a.type, "dir": a.dir} for a in g.c.attributes if a.dir != "out"]
        meta["classes"].append(cm)

    L += ["int main(void) {", "    char line[4096];", "    char* p;", "    int n;", "    int i;", "    double d;",
          "    cfg_defaults();", "    do_init();", "    snap();", f'    printf("{DONE}\\n");', "    fflush(stdout);",
          "    while (fgets(line, sizeof line, stdin) != NULL) {",
          "        if (line[0] == 'Q') {", "            break;", "        }",
          "        if (line[0] == 'R') {", "            cfg_defaults();", "            do_init();", "            snap();",
          "        } else if (line[0] == 'I') {", "            p = line + 1;"]
    for i in range(len(cfg_order)):
        L += ["            d = strtod(p, &p);", f"            cfgv[{i}] = d;"]
    L += ["            do_init();", "            snap();", "        } else if (line[0] == 'S') {",
          "            p = line + 1;", "            n = (int)strtol(p, &p, 10);"]
    by = {g.n: g for g in gens}
    for cname, aname in meta["input_order"]:
        g = by[cname]
        a = next(x for x in g.ins if x.name == aname)
        L += ["            d = strtod(p, &p);", f"            {io(g, a)} = ({a.type})d;"]
    L += ["            for (i = 0; i < n; i++) {", "                task();", "                snap();", "            }", "        }",
          f'        printf("{DONE}\\n");', "        fflush(stdout);", "    }", "    return 0;", "}", ""]
    return "\n".join(L), meta
