"""Browser twin of sim.py (GitHub Pages build, runs inside Pyodide): the same session API
(start / step / reset / stop / scenario) over the same harness (codegen/sim_c.py), but the harness is
built by the wasm clang + lld and run in a worker (static/vendor/clang/sim_worker.js, host side in
static/backend.js) instead of a child process.

A wasm run cannot be kept waiting for the next stdin line, so every command runs the program afresh: the
commands since the last reset are replayed (earlier S commands as T = silent) and only the answer of the
last one is kept. A reset (R / I) re-initialises everything, so nothing older than it matters."""
import asyncio
import json
import shutil
import uuid

import js
from model import load_editor
from sim_c import DONE, SNAP, sim_main
from task_c import TARGET_MAIN, TaskGen, generate
import scenario

SIMS = {}                       # sid -> Sim
SIM_LIMIT = 4
MAX_CALLS = 100000
STEP_TIMEOUT = 10.0             # seconds one run may take (the worker is killed after it)


class Sim:
    def __init__(self, mid, meta):
        self.mid, self.meta = mid, meta
        self.hist = []          # commands since the last reset
        self.last = {}          # (class, input) -> last value sent

    async def command(self, line):
        """Send one command ("" = just the start-up output) -> (snaps, logs). RuntimeError on a crash or timeout."""
        if line:
            if line[0] in "RI":
                self.hist = [line]
            else:
                self.hist.append(line)
        cmds = ["T" + h[1:] if h[0] == "S" else h for h in self.hist[:-1]] + self.hist[-1:]
        try:
            out = await js.simHost.run(self.mid, "".join(c + "\n" for c in cmds))
        except Exception as ex:                         # JsException from the worker
            if "TIMEOUT" in str(ex):
                raise RuntimeError(f"no answer within {STEP_TIMEOUT:g} s (endless loop in your code?) - simulation stopped")
            raise RuntimeError("the simulation process crashed (a NULL pointer in your code?) - restart it")
        segs, cur = [], []
        for ln in str(out).split("\n"):
            ln = ln.rstrip("\r")
            if ln.startswith(DONE):
                segs.append(cur)
                cur = []
            else:
                cur.append(ln)
        if len(segs) <= len(cmds):                      # the program ended before it answered the last command
            raise RuntimeError("the simulation process crashed (a NULL pointer in your code?) - restart it")
        snaps, logs = [], []
        for ln in segs[len(cmds)]:
            if ln.startswith(SNAP):
                snaps.append(json.loads(ln[len(SNAP):]))
            else:
                logs.append(ln)
        return snaps, logs

    def close(self):
        js.simHost.drop(self.mid)


async def start(project):
    pkg = load_editor(project)
    outdir = "/tmp/out/" + pkg.name
    shutil.rmtree(outdir, ignore_errors=True)
    files, warnings = generate(pkg, outdir)
    text, meta = sim_main(pkg, [TaskGen(pkg, c) for c in pkg.classes])
    srcs = {fn: t for fn, t in files.items() if fn.endswith((".c", ".h")) and fn != TARGET_MAIN}
    srcs["sim_main.c"] = text
    while len(SIMS) >= SIM_LIMIT:
        SIMS.pop(next(iter(SIMS))).close()
    try:
        r = json.loads(str(await js.simHost.build(json.dumps(srcs))))
    except Exception as ex:
        return {"error": "the simulation did not build", "log": str(ex)}
    if not r["ok"]:
        return {"error": "the simulation did not build", "log": r["log"]}
    sid = uuid.uuid4().hex[:10]
    sim = Sim(r["mid"], meta)
    SIMS[sid] = sim
    try:
        snaps, logs = await sim.command("")
    except RuntimeError as ex:
        SIMS.pop(sid, None)
        sim.close()
        return {"error": str(ex)}
    return {"sid": sid, "meta": meta, "snaps": snaps, "logs": logs, "log": r["log"], "warnings": warnings}


def fail(sid, ex):
    sim = SIMS.pop(sid, None)
    if sim:
        sim.close()
    return {"error": str(ex)}


async def step(sid, n, inputs):
    sim = SIMS.get(sid)
    if not sim:
        return {"error": "no such simulation (start it again)"}
    vals = []
    for cname, aname in sim.meta["input_order"]:
        v = ((inputs or {}).get(cname) or {}).get(aname)
        if v is None:
            v = sim.last.get((cname, aname), 0)
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = 0.0
        sim.last[(cname, aname)] = v
        vals.append(repr(v))
    try:
        n = max(1, int(n))
    except (TypeError, ValueError):
        n = 1
    if n > MAX_CALLS:
        return {"error": f"at most {MAX_CALLS} calls in one step"}
    try:
        snaps, logs = await sim.command("S %d %s" % (n, " ".join(vals)))
    except RuntimeError as ex:
        return fail(sid, ex)
    return {"snaps": snaps, "logs": logs}


async def reset(sid):
    sim = SIMS.get(sid)
    if not sim:
        return {"error": "no such simulation (start it again)"}
    try:
        snaps, logs = await sim.command("R")
    except RuntimeError as ex:
        return fail(sid, ex)
    sim.last.clear()
    return {"snaps": snaps, "logs": logs}


def stop(sid):
    sim = SIMS.pop(sid, None)
    if sim:
        sim.close()
    return {"ok": True}


async def run_scenario(sid, steps):
    """Same as sim.run_scenario (see there and scenario.py)."""
    sim = SIMS.get(sid)
    if not sim:
        return {"error": "no such simulation (start it again)"}
    r = await reset(sid)
    if "error" in r:
        return r
    meta = sim.meta
    inputs = scenario.default_inputs(meta)
    cur = r["snaps"][-1]
    results, t = [], 0
    for i, st in enumerate(steps or []):
        res = {"i": i}
        try:
            do_init = bool(st.get("init"))
            ins, cfgs = scenario.parse_set(st.get("set"), meta, do_init)
            exp = scenario.parse_expect(st.get("expect"), meta)
            n = st.get("n")
            n = 1 if n in (None, "") else int(n)
            if n < 0:
                raise ValueError("calls must be 0 or more (0 = only check, no call)")
            if n > MAX_CALLS:
                raise ValueError(f"at most {MAX_CALLS} calls in one step")
        except (ValueError, TypeError) as ex:
            res.update(ok=False, msgs=[str(ex)], bad=True)
            results.append(res)
            break
        logs = []
        if do_init:                                           # X_Init again: inputs / variables back to their initial values
            cfg = scenario.default_config(meta)
            for c, nm, v in cfgs:
                cfg[c][nm] = v
            try:
                snaps, ilogs = await sim.command("I " + " ".join(repr(cfg[c][nm]) for c, nm in meta["config_order"]))
            except RuntimeError as ex:
                fail(sid, ex)
                res.update(ok=False, msgs=[str(ex)], bad=True)
                results.append(res)
                break
            cur = snaps[-1]
            logs += ilogs
            inputs = scenario.default_inputs(meta)
            sim.last.clear()
        for c, nm, v in ins:
            inputs[c][nm] = v
        if n:
            out = await step(sid, n, inputs)
            if "error" in out:
                res.update(ok=False, msgs=[out["error"]], bad=True)
                results.append(res)
                break
            snap = out["snaps"][-1]
            logs += out["logs"]
        else:
            snap = cur
        cur = snap
        t = t + n if not do_init else n
        msgs = scenario.check(meta, snap, exp)
        res.update(ok=not msgs, msgs=msgs, t=t, snap=snap, logs=logs)
        results.append(res)
    return {"start": r["snaps"][-1], "results": results, "ok": len(results) == len(steps or []) and all(x["ok"] for x in results)}


async def _call(path, body_json):
    b = json.loads(body_json or "{}")
    try:
        if path == "/api/sim/start":
            r = await start(b)
        elif path == "/api/sim/step":
            r = await step(b.get("sid"), b.get("n", 1), b.get("inputs"))
        elif path == "/api/sim/scenario":
            r = await run_scenario(b.get("sid"), b.get("steps"))
        elif path == "/api/sim/reset":
            r = await reset(b.get("sid"))
        elif path == "/api/sim/stop":
            r = stop(b.get("sid"))
        else:
            r = {"error": "unknown endpoint"}
    except Exception as ex:                                   # model errors go to the UI, like the server's 500
        r = {"error": f"{type(ex).__name__}: {ex}"}
    return json.dumps(r)


def sim_call(path, body_json):
    """Entry point for backend.js: returns a Future (a thenable on the JS side) of the JSON answer."""
    return asyncio.ensure_future(_call(path, body_json))
