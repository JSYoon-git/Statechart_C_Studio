"""Simulation backend: python editor/tests/test_sim.py
Builds every shipped example with the harness, steps it and checks what comes back (the real generated C runs)."""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import server  # noqa: E402
import sim  # noqa: E402

fails = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        fails.append(what)


def names(meta, ci, snap):
    idx = set(snap["c"][ci]["s"])
    return [s["name"] for s in meta["classes"][ci]["states"] if s["idx"] in idx]


def load(name):
    with open(os.path.join(HERE, "..", "static", "examples", name + ".json"), encoding="utf-8") as f:
        return json.load(f)


sim.cleanup()
for f in sorted(glob.glob(os.path.join(HERE, "..", "static", "examples", "*.json"))):
    ex = os.path.basename(f)[:-5]
    r = server.sim_start(load(ex))
    if "error" in r:
        check(False, f"{ex}: starts ({r['error']} {r.get('log', '')})")
        continue
    sid, meta = r["sid"], r["meta"]
    check(all(names(meta, i, r["snaps"][-1]) for i in range(len(meta["classes"]))), f"{ex}: a state is active after Init")
    s = sim.step(sid, 3, {})
    check("snaps" in s and len(s["snaps"]) == 3, f"{ex}: 3 calls give 3 snapshots")
    check(all("node" in st for c in meta["classes"] for st in c["states"]), f"{ex}: every state maps to a drawing node")
    sim.stop(sid)

# blink: LED_OFF for 50 calls, then LED_ON with led = 1 (counting happens in the generated code)
r = server.sim_start(load("blink"))
sid, meta = r["sid"], r["meta"]
a = sim.step(sid, 49, {})["snaps"][-1]
check(names(meta, 0, a) == ["LED_OFF"] and a["c"][0]["o"] == [0], "blink: still LED_OFF after 49 calls")
b = sim.step(sid, 1, {})["snaps"][-1]
check(names(meta, 0, b) == ["LED_ON"] and b["c"][0]["o"] == [1], "blink: LED_ON, led = 1 at call 50")
rs = sim.reset(sid)["snaps"][-1]
check(names(meta, 0, rs) == ["LED_OFF"], "blink: reset goes back to LED_OFF")
sim.stop(sid)

# lamp: an input changes the state; sticky inputs stay between calls
r = server.sim_start(load("button_lamp"))
sid, meta = r["sid"], r["meta"]
check(names(meta, 0, r["snaps"][-1]) == ["LAMP_OFF"], "lamp: starts OFF")
x = sim.step(sid, 1, {"Lamp": {"button": 1}})["snaps"][-1]
check(names(meta, 0, x) == ["LAMP_ON"], "lamp: button -> LAMP_ON")
y = sim.step(sid, 1, {"Lamp": {"button": 0}})["snaps"][-1]
check(names(meta, 0, y) == ["LAMP_ON"], "lamp: stays ON after the button is released")
sim.stop(sid)

# every example's scenarios (step tables) pass against the real generated code
for f in sorted(glob.glob(os.path.join(HERE, "..", "static", "examples", "*.json"))):
    ex = os.path.basename(f)[:-5]
    p = load(ex)
    check(bool(p.get("scenarios")), f"{ex}: has scenarios")
    r = server.sim_start(p)
    for sc in p.get("scenarios", []):
        res = sim.run_scenario(r["sid"], sc["steps"])
        bad = [(x["i"] + 1, x["msgs"]) for x in res["results"] if not x["ok"]]
        check(res["ok"] and len(res["results"]) == len(sc["steps"]), f"{ex}: scenario '{sc['name']}' ({len(sc['steps'])} steps)" + (f" {bad}" if bad else ""))
    sim.stop(r["sid"])

# the checker really fails: wrong state / wrong value / unknown name / bad number / ambiguous name
r = server.sim_start(load("blink"))
sid = r["sid"]
def run1(**kw):
    return sim.run_scenario(sid, [dict(kw)])["results"][0]
check(run1(n=1, set="blinkTicks=5").get("bad"), "checker: a config value needs an Init row")
check(sim.run_scenario(sid, [{"n": 0, "init": True, "set": "blinkTicks=5", "expect": "led=false"}])["ok"], "checker: Init row sets a config value")
check(sim.run_scenario(sid, [{"n": 5, "init": True, "set": "blinkTicks=5", "expect": "led=true"}])["ok"], "checker: the new config value is in effect")
check(not sim.run_scenario(sid, [{"n": 1, "init": True, "set": "blinkTicks=5", "expect": "led=true"}])["ok"], "checker: Init row, wrong expectation fails")
check(run1(n=1, expect="LED_ON").get("bad"), "checker: a state cannot be checked (the drawing shows states)")
check(not run1(n=1, expect="led=true")["ok"], "checker: wrong output fails")
check(not run1(n=1, expect="led>=5")["ok"], "checker: wrong comparison fails")
check(run1(n=1, expect="led>=0, led<=0, led!=1")["ok"], "checker: comparisons pass")
check(run1(n=1, expect="cnt=1").get("bad"), "checker: an internal variable cannot be checked")
check(run1(n=1, expect="blinkTicks=50").get("bad"), "checker: a config value cannot be checked")
check(run1(n=1, set="cnt=1").get("bad"), "checker: an internal variable cannot be set")
check(run1(n=1, expect="nosuch=1").get("bad"), "checker: unknown name is reported")
check(run1(n=1, set="led=1").get("bad"), "checker: set needs an input")
check(run1(n=1, expect="led=maybe").get("bad"), "checker: bad number is reported")
check(run1(n=0, expect="led=false")["ok"], "checker: n=0 only checks (after reset)")
sim.stop(sid)
r = server.sim_start(load("motor"))
check(sim.run_scenario(r["sid"], [{"n": 1, "expect": "atSpeed=false"}])["results"][0]["ok"], "checker: unqualified name works when only one class has such an output")
sim.stop(r["sid"])

# a build error is reported, not raised
bad = load("blink")
bad["classes"][0]["chart"]["nodes"][next(k for k, n in bad["classes"][0]["chart"]["nodes"].items() if n.get("kind") == "state")]["entry"] = "this is not C;"
r = server.sim_start(bad)
check("error" in r and r.get("log"), "broken user code: build error with a log")

# an endless loop in user code is killed, the session is gone afterwards
loop = load("blink")
nid = next(k for k, n in loop["classes"][0]["chart"]["nodes"].items() if n.get("kind") == "state")
loop["classes"][0]["chart"]["nodes"][nid]["reactions"] = [{"trigger": "", "guard": "", "action": "for (;;) { }"}]
sim.STEP_TIMEOUT = 2.0
r = server.sim_start(loop)
if "sid" in r:
    s = sim.step(r["sid"], 1, {})
    check("error" in s, "endless loop: killed after the timeout")
    check("error" in sim.step(r["sid"], 1, {}), "endless loop: session is gone")

sim.cleanup()
print("\n%s" % ("ALL OK" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
