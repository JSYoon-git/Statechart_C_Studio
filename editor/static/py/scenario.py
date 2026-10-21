"""Scenarios: a unit-test step table that runs against the simulation.

A scenario is a list of steps. Every step says what happens, then what must be true:

    {"n": 50, "set": "button=1, coin=500", "expect": "LAMP_ON, !IDLE, lamp=true, cnt>=3", "note": "..."}

  n       number of 10 ms task calls (default 1; 0 = only set / check, no call)
  init    true = call X_Init again first: all inputs and variables back to their initial values; the
          config values (X_Init parameters, the drawing's value unless `set` gives another) take effect
  set     inputs to change BEFORE the calls; every input keeps its value until a later step changes it.
          On an `init` row it may also give config values (blinkTicks=5)
  expect  checked AFTER the last call, comma separated. OUTPUTS only: a scenario drives the chart with inputs
          and looks at what comes out; states and internal variables stay inside (the drawing shows the states):
            name=value       an OUTPUT (also != >= <= > <)
          With several classes write Class.name / Class.STATE. true / false are 1 / 0.

run() resets the simulation (X_Init: initial state and values) and plays the steps in order;
it returns one result per step (ok, messages, the call count and the snapshot after it).
"""
import re

OPS = ("!=", ">=", "<=", "==", "=", ">", "<")
NAME = r"[A-Za-z_][A-Za-z0-9_]*"
CMP = {"=": lambda a, b: a == b, "==": lambda a, b: a == b, "!=": lambda a, b: a != b,
       ">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b, "<": lambda a, b: a < b}


def value(text):
    t = text.strip()
    if t in ("true", "false"):
        return 1.0 if t == "true" else 0.0
    t = re.sub(r"[uUlLfF]+$", "", t)
    try:
        return float(t)
    except ValueError:
        raise ValueError(f"'{text.strip()}' is not a number (use true / false or a number)")


RANGES = {"uint8_t": (0, 255), "uint16_t": (0, 65535), "uint32_t": (0, 4294967295),
          "int8_t": (-128, 127), "int16_t": (-32768, 32767), "int32_t": (-2147483648, 2147483647),
          "int": (-2147483648, 2147483647), "unsigned": (0, 4294967295), "unsigned int": (0, 4294967295),
          "short": (-32768, 32767), "unsigned short": (0, 65535), "char": (-128, 127), "unsigned char": (0, 255)}


def fits(ctype, v):
    """None when v can be stored in ctype, else a message (a value that does not fit would be cut off silently in C)."""
    t = (ctype or "").replace("const", "").strip()
    if t == "bool":
        return None if v in (0.0, 1.0) else "a bool is true / false (1 / 0)"
    if t in RANGES:
        lo, hi = RANGES[t]
        if v != int(v):
            return f"{t} takes whole numbers"
        if not lo <= v <= hi:
            return f"does not fit {t} ({lo} … {hi})"
    return None


def split(text):
    return [x.strip() for x in re.split(r"[,;\n]", text or "") if x.strip()]


def split_op(tok):
    for op in OPS:
        if op in tok:
            a, b = tok.split(op, 1)
            return a.strip(), op, b.strip()
    return tok.strip(), None, None


def find_class(meta, cname, name, what):
    """Class of `name` ('Class.name' or plain): `what` is a function (classmeta) -> bool."""
    if cname:
        hits = [c for c in meta["classes"] if c["name"] == cname and what(c, name)]
    else:
        hits = [c for c in meta["classes"] if what(c, name)]
    if not hits:
        raise ValueError(f"unknown name '{(cname + '.') if cname else ''}{name}'")
    if len(hits) > 1:
        raise ValueError(f"'{name}' exists in several classes - write Class.{name}")
    return hits[0]


def qualified(tok):
    m = re.fullmatch(rf"({NAME})\.({NAME})", tok)
    return (m.group(1), m.group(2)) if m else (None, tok)


def parse_set(text, meta, init=False):
    """-> ([(class, input name, number)], [(class, config name, number)]). Config values are X_Init parameters,
    so they can only be given on a row that calls X_Init (init=True)."""
    ins, cfgs = [], []
    for tok in split(text):
        left, op, right = split_op(tok)
        if op not in ("=", "=="):
            raise ValueError(f"set: '{tok}' - write name=value")
        cname, name = qualified(left)
        try:
            c = find_class(meta, cname, name, lambda cm, n: any(i["name"] == n and i["kind"] for i in cm["ins"]))
            v = value(right)
            bad = fits(next(i["type"] for i in c["ins"] if i["name"] == name), v)
            if bad:
                raise ValueError(f"set: {name} = {right.strip()} - {bad}")
            ins.append((c["name"], name, v))
            continue
        except ValueError as ex:
            if "unknown name" not in str(ex):
                raise
        c = find_class(meta, cname, name, lambda cm, n: any(i["name"] == n and i["kind"] for i in cm["cfgs"]))
        if not init:
            raise ValueError(f"set: '{name}' is a config value (an X_Init parameter) - tick Init on this row to set it")
        v = value(right)
        bad = fits(next(i["type"] for i in c["cfgs"] if i["name"] == name), v)
        if bad:
            raise ValueError(f"set: {name} = {right.strip()} - {bad}")
        cfgs.append((c["name"], name, v))
    return ins, cfgs


def parse_expect(text, meta):
    """-> [('val', class, name, op, number)] - outputs only"""
    out = []
    for tok in split(text):
        left, op, right = split_op(tok)
        cname, name = qualified(left)
        if op is None:
            raise ValueError(f"expect: '{tok}' - write output=value (states are not checked, the drawing shows them)")
        try:
            c = find_class(meta, cname, name, lambda cm, n: any(o["name"] == n for o in cm["outs"]))
        except ValueError as ex:
            if "unknown name" in str(ex):
                raise ValueError(f"'{name}' is not an output - scenarios check outputs only (inputs drive, states and internal variables stay inside)")
            raise
        out.append(("val", c["name"], name, op, value(right)))
    return out


def show(v, ctype):
    if v is None:
        return "?"
    if (ctype or "").strip() == "bool":
        return "true" if v else "false"
    return f"{v:g}"


OP_WORDS = {"=": "", "==": "", "!=": "not ", ">=": "at least ", "<=": "at most ", ">": "more than ", "<": "less than "}


def check(meta, snap, expects):
    """One short message per wrong output: `led: got false, expected true`."""
    msgs = []
    multi = len(meta["classes"]) > 1
    for _, cname, name, op, want in expects:
        ci = next(i for i, c in enumerate(meta["classes"]) if c["name"] == cname)
        cm, sc = meta["classes"][ci], snap["c"][ci]
        got, ctype = None, ""
        for i, o in enumerate(cm["outs"]):
            if o["name"] == name:
                got, ctype = sc["o"][i], o["type"]
        if got is None or not CMP[op](got, want):
            label = f"{cname}.{name}" if multi else name
            msgs.append(f"{label}: got {show(got, ctype)}, expected {OP_WORDS[op]}{show(want, ctype)}")
    return msgs


def default_config(meta):
    cfg = {}
    for c in meta["classes"]:
        cfg[c["name"]] = {}
        for i in c["cfgs"]:
            try:
                cfg[c["name"]][i["name"]] = value(i["default"])
            except ValueError:
                cfg[c["name"]][i["name"]] = 0.0
    return cfg


def default_inputs(meta):
    ins = {}
    for c in meta["classes"]:
        ins[c["name"]] = {}
        for i in c["ins"]:
            try:
                ins[c["name"]][i["name"]] = value(i["default"])
            except ValueError:
                ins[c["name"]][i["name"]] = 0.0
    return ins
