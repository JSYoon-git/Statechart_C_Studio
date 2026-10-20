"""Simulation sessions for the editor server: the generated modules + a harness (codegen/sim_c.py),
built to sim.exe and run as a child process. The server keeps one Sim per open simulation."""
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SIMDIR = os.path.join(tempfile.gettempdir(), "statechart_sim")
SIMS = {}                       # sid -> Sim
SIM_LIMIT = 4
MAX_CALLS = 100000
STEP_TIMEOUT = 10.0             # seconds one command may take (an endless loop in user code gets killed)


class Sim:
    def __init__(self, proc, meta, workdir, done, snap):
        self.proc, self.meta, self.workdir = proc, meta, workdir
        self.done, self.snap = done, snap
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.last = {}          # (class, input) -> last value sent
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        for line in self.proc.stdout:
            self.q.put(line.rstrip("\r\n"))
        self.q.put(None)        # the process ended

    def command(self, line):
        """Send one command ("" = just wait for the start-up output); collect the @@SNAP lines up
        to @@DONE -> (snaps, logs). Raises RuntimeError on a crash or timeout."""
        with self.lock:
            if line:
                try:
                    self.proc.stdin.write(line + "\n")
                    self.proc.stdin.flush()
                except (OSError, ValueError):
                    raise RuntimeError("the simulation process has ended")
            snaps, logs = [], []
            end = time.time() + STEP_TIMEOUT
            while True:
                try:
                    ln = self.q.get(timeout=max(0.05, end - time.time()))
                except queue.Empty:
                    self.kill()
                    raise RuntimeError(f"no answer within {STEP_TIMEOUT:g} s (endless loop in your code?) - simulation stopped")
                if ln is None:
                    raise RuntimeError("the simulation process crashed (a NULL pointer in your code?) - restart it")
                if ln.startswith(self.done):
                    return snaps, logs
                if ln.startswith(self.snap):
                    snaps.append(json.loads(ln[len(self.snap):]))
                else:
                    logs.append(ln)

    def kill(self):
        try:
            self.proc.kill()
        except OSError:
            pass

    def close(self):
        try:
            self.proc.stdin.write("Q\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            pass
        self.kill()
        try:
            self.proc.wait(timeout=3)
        except Exception:
            pass
        shutil.rmtree(self.workdir, ignore_errors=True)


def cleanup():
    shutil.rmtree(SIMDIR, ignore_errors=True)
    os.makedirs(SIMDIR, exist_ok=True)


def build(workdir, srcs, vcvars):
    """cl every module + sim_main.c -> sim.exe (or gcc). Returns (ok, log)."""
    if vcvars:
        bat = os.path.join(workdir, "build_sim.bat")
        with open(bat, "w", encoding="mbcs") as f:
            f.write("@echo off\r\nset VSLANG=1033\r\n"
                    f'call "{vcvars}" >nul\r\n'
                    'cd /d "%~dp0"\r\n'
                    "if not exist obj mkdir obj\r\n"
                    "cl /nologo /W3 /utf-8 /wd4819 /I . " + " ".join(srcs) + " /Fe:sim.exe /Foobj\\\r\n")
        r = subprocess.run(["cmd", "/d", "/c", bat], cwd=workdir, capture_output=True, text=True,
                           encoding="mbcs", errors="replace", timeout=180)
    elif shutil.which("gcc"):
        r = subprocess.run(["gcc", "-o", "sim.exe", "-I.", *srcs], cwd=workdir, capture_output=True, text=True, timeout=180)
    else:
        return False, "No C compiler found (MSVC Build Tools or gcc)."
    log = "\n".join(ln for ln in (r.stdout + r.stderr).splitlines() if re.search(r"\b(error|fatal)\b|: note:", ln, re.I))
    return os.path.exists(os.path.join(workdir, "sim.exe")), log


def start(out, files, text, meta, vcvars, skip, done, snap):
    """Copy the generated modules (not `skip`, the example main.c) and the harness to a work dir, build, run."""
    while len(SIMS) >= SIM_LIMIT:
        SIMS.pop(next(iter(SIMS))).close()
    sid = uuid.uuid4().hex[:10]
    workdir = os.path.join(SIMDIR, sid)
    os.makedirs(workdir)
    srcs = []
    for fn in sorted(files):
        if fn.endswith((".c", ".h")) and fn != skip:
            shutil.copy(os.path.join(out, fn), os.path.join(workdir, fn))
            if fn.endswith(".c"):
                srcs.append(fn)
    with open(os.path.join(workdir, "sim_main.c"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    srcs.append("sim_main.c")
    ok, log = build(workdir, srcs, vcvars)
    if not ok:
        shutil.rmtree(workdir, ignore_errors=True)
        return {"error": "the simulation did not build", "log": log}
    proc = subprocess.Popen([os.path.join(workdir, "sim.exe")], cwd=workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
    sim = Sim(proc, meta, workdir, done, snap)
    SIMS[sid] = sim
    try:
        snaps, logs = sim.command("")
    except RuntimeError as ex:
        SIMS.pop(sid, None)
        sim.close()
        return {"error": str(ex)}
    return {"sid": sid, "meta": meta, "snaps": snaps, "logs": logs, "log": log}


def fail(sid, ex):
    sim = SIMS.pop(sid, None)
    if sim:
        sim.close()
    return {"error": str(ex)}


def step(sid, n, inputs):
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
        snaps, logs = sim.command("S %d %s" % (n, " ".join(vals)))
    except RuntimeError as ex:
        return fail(sid, ex)
    return {"snaps": snaps, "logs": logs}


def reset(sid):
    sim = SIMS.get(sid)
    if not sim:
        return {"error": "no such simulation (start it again)"}
    try:
        snaps, logs = sim.command("R")
    except RuntimeError as ex:
        return fail(sid, ex)
    sim.last.clear()
    return {"snaps": snaps, "logs": logs}


def stop(sid):
    sim = SIMS.pop(sid, None)
    if sim:
        sim.close()
    return {"ok": True}


def run_scenario(sid, steps):
    """Reset, then play a scenario (see scenario.py). Returns {start, results:[{i, ok, msgs, t, snap, logs}], ok}.
    A step that cannot be parsed or a crashed run ends the run; the steps after it are not run."""
    import scenario
    sim = SIMS.get(sid)
    if not sim:
        return {"error": "no such simulation (start it again)"}
    r = reset(sid)
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
                snaps, ilogs = sim.command("I " + " ".join(repr(cfg[c][nm]) for c, nm in meta["config_order"]))
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
            out = step(sid, n, inputs)
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
