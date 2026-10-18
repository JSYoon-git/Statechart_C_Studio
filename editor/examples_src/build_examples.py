"""Builds the example projects in ../static/examples/*.json.

    python editor/examples_src/build_examples.py

Each example is written with the small builder below (positions in canvas
pixels) so the diagrams stay readable and the files stay in sync with the
editor's project format. tests/test_examples.py runs every one of them.

Task-style models: no events, no timers. X_Main is called from the 10 ms task.
A class has input / output / internal variables; transitions are [guard]s in plain C.
Time is counted with a variable:  entry/ cnt = 0;  reaction/ cnt++;  [cnt >= blinkTicks]
(internal reactions run before the transitions on every call). Every fixed number (times, limits,
prices, speeds) is a config value: a parameter of X_Init, set from main.c, never a #define.
"""
import json
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "examples")


def v(type_, name, default="", dir_="local", link=""):
    d = {"type": type_, "name": name, "default": default, "dir": dir_}
    if dir_ == "in" and link:
        d["link"] = link
    return d


def inp(name, type_="bool", default="false", link=""):
    return v(type_, name, default, "in", link)


def out(name, type_="bool", default="false"):
    return v(type_, name, default, "out")


def cfg(name, default, type_="uint16_t"):
    """a fixed value set once by X_Init(me, c_<name>); main.c passes the default written here"""
    return v(type_, name, default, "config")


CNT = "cnt++;"           # the counting reaction


class Project:
    def __init__(self, package, types=("#include <stdio.h>",)):
        self.d = {"version": 4, "package": package, "types": list(types), "events": [], "classes": []}

    def cls(self, name, vars_=(), ops=(), assocs=(), io_style=None):
        c = Class(name, vars_, ops, assocs)
        if io_style:
            c.d["ioStyle"] = io_style      # "struct": X_Main(me, const X_In* in, X_Out* out)
        self.d["classes"].append(c.d)
        return c

    def save(self, fn):
        with open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
            json.dump(self.d, f, indent=1, ensure_ascii=False)


class Class:
    def __init__(self, name, vars_, ops, assocs):
        self.d = {"name": name,
                  "attributes": list(vars_),
                  # (ret, name, args, body)
                  "operations": [{"name": o[1], "ret": o[0], "args": [{"type": t, "name": a} for t, a in o[2]],
                                  "body": o[3]} for o in ops],
                  "assocs": [{"name": n, "class": c} for n, c in assocs],
                  "init": "", "chart": {"nodes": {}, "edges": {}}}
        self.n, self.e = self.d["chart"]["nodes"], self.d["chart"]["edges"]

    def state(self, sid, name, x, y, w=150, h=60, parent=None, region=0, entry="", exit="", reactions=(), regions=None):
        """reactions: (guard, action) pairs - run on every X_Main call while the state is active"""
        node = {"kind": "state", "name": name, "x": x, "y": y, "w": w, "h": h, "parent": parent, "region": region,
                "entry": entry, "exit": exit,
                "reactions": [{"trigger": "", "guard": g, "action": a} for g, a in reactions]}
        if regions:
            node["and"] = True
            node["regions"] = [{"name": r} for r in regions]
        self.n[sid] = node
        return sid

    def pseudo(self, kind, sid, x, y, parent=None, region=0):
        self.n[sid] = {"kind": kind, "x": x, "y": y, "parent": parent, "region": region}
        return sid

    def init(self, sid, x, y, to, parent=None, region=0, action=""):
        self.pseudo("init", sid, x, y, parent, region)
        self.edge(sid, to, action=action)

    def edge(self, a, b, guard="", action="", bend=0):
        self.e[f"e{len(self.e)}"] = {"from": a, "to": b, "trigger": "", "guard": guard, "action": action, "bend": bend}


# ============================================================ 초급 (beginner)
def blink():
    p = Project("Blink")
    # blinkTicks is a config value: Led_Init(&itsLed, 50u) in main.c sets it (50 x 10 ms = 500 ms)
    c = p.cls("Led", [out("led"), v("uint16_t", "blinkTicks", "50u", "config"),
                      v("uint16_t", "blinkCount", "0"), v("uint16_t", "cnt", "0")])
    c.state("off", "LED_OFF", 110, 90, 170, 80, entry='cnt = 0;\nled = false;\nprintf("LED OFF\\n");',
            reactions=[("", CNT)])
    c.state("on", "LED_ON", 420, 90, 170, 80,
            entry='cnt = 0;\nled = true;\nblinkCount++;\nprintf("LED ON  (%u번째)\\n", (unsigned)blinkCount);',
            reactions=[("", CNT)])
    c.init("i0", 70, 125, "off")
    c.edge("off", "on", guard="cnt >= blinkTicks", bend=22)
    c.edge("on", "off", guard="cnt >= blinkTicks", bend=22)
    p.save("blink.json")


def button_lamp():
    p = Project("Lamp")
    c = p.cls("Lamp", [inp("button"), inp("forceOff"), out("lamp"), v("int", "pressCount", "0")])
    c.state("off", "LAMP_OFF", 110, 90, 170, 70, entry='lamp = false;\nprintf("램프 꺼짐\\n");')
    c.state("on", "LAMP_ON", 420, 90, 170, 70, entry='lamp = true;\nprintf("램프 켜짐 (%d번 눌림)\\n", pressCount);')
    c.init("i0", 70, 120, "off")
    # transition action runs BEFORE the target's entry action
    c.edge("off", "on", guard="(button == true) && (forceOff == false)", action="pressCount++;", bend=22)
    c.edge("on", "off", guard="button == true", bend=22)
    c.edge("on", "off", guard="forceOff == true", bend=-50)
    p.save("button_lamp.json")


def traffic3():
    p = Project("Signal")
    c = p.cls("Signal", [out("color", "uint8_t", "0"), cfg("redTicks", "300u"), cfg("greenTicks", "250u"), cfg("yellowTicks", "100u"),
                         v("int", "cycle", "0"), v("uint16_t", "cnt", "0")])
    c.state("red", "RED", 100, 80, 160, 70, entry='cnt = 0;\ncolor = 0u;\ncycle++;\nprintf("빨강 (%d번째 주기)\\n", cycle);',
            reactions=[("", CNT)])
    c.state("green", "GREEN", 420, 80, 160, 70, entry='cnt = 0;\ncolor = 1u;\nprintf("초록\\n");', reactions=[("", CNT)])
    c.state("yellow", "YELLOW", 260, 240, 160, 70, entry='cnt = 0;\ncolor = 2u;\nprintf("노랑\\n");', reactions=[("", CNT)])
    c.init("i0", 60, 115, "red")
    c.edge("red", "green", guard="cnt >= redTicks")             # 3 s
    c.edge("green", "yellow", guard="cnt >= greenTicks")        # 2.5 s
    c.edge("yellow", "red", guard="cnt >= yellowTicks")         # 1 s
    p.save("traffic3.json")


# ============================================================ 중급 (intermediate)
def vending():
    p = Project("Vending")
    c = p.cls("Machine", [inp("coin", "int16_t", "0"), inp("select"), inp("cancel"),
                          out("dispense"), cfg("price", "1000", "int"), cfg("dispenseTicks", "150u"),
                          v("int", "credit", "0"), v("uint16_t", "cnt", "0")])
    c.state("idle", "IDLE", 40, 200, 150, 60, entry='dispense = false;\nprintf("동전을 넣으세요 (가격 %d원)\\n", price);')
    c.state("col", "COLLECTING", 380, 190, 180, 80,
            entry='printf("현재 금액 %d원\\n", credit);',
            reactions=[("coin > 0", 'credit += coin;\nprintf("현재 금액 %d원\\n", credit);')])
    c.state("disp", "DISPENSING", 720, 200, 170, 70,
            entry='cnt = 0;\ndispense = true;\ncredit -= price;\nprintf("상품이 나옵니다. 거스름돈 %d원\\n", credit);',
            reactions=[("", CNT)])
    c.pseudo("cond", "c1", 620, 380)
    c.init("i0", 15, 230, "idle")
    c.edge("idle", "col", guard="coin > 0", action="credit += coin;", bend=30)
    c.edge("col", "idle", guard="cancel == true", action='printf("%d원 반환\\n", credit);\ncredit = 0;', bend=30)
    c.edge("col", "c1", guard="select == true", bend=-25)
    c.edge("c1", "disp", guard="credit >= price", bend=-25)
    c.edge("c1", "col", guard="else", action='printf("금액이 부족합니다\\n");', bend=-40)
    c.edge("disp", "idle", guard="cnt >= dispenseTicks", action="credit = 0;", bend=170)
    p.save("vending.json")


def washer():
    p = Project("Washer")
    c = p.cls("Washer", [inp("start"), inp("pause"), inp("resume"), out("valve"), out("motor"),
                         cfg("fillTicks", "200u"), cfg("washTicks", "300u"), cfg("rinseTicks", "200u"), cfg("spinTicks", "200u"),
                         v("uint16_t", "cnt", "0")],
              io_style="struct")
    c.state("idle", "IDLE", 30, 140, 130, 60, entry='printf("대기\\n");')
    # one counting reaction on RUNNING: every step inside it resets cnt on entry
    c.state("run", "RUNNING", 220, 40, 480, 270, entry="motor = true;", exit="motor = false;", reactions=[("", CNT)])
    c.init("ir", 245, 85, "fill", parent="run")
    c.pseudo("hist", "h", 245, 280, parent="run")
    c.state("fill", "FILL", 270, 80, 140, 55, parent="run", entry='cnt = 0;\nvalve = true;\nprintf("  물 받기\\n");',
            exit="valve = false;")
    c.state("wash", "WASH", 520, 80, 140, 55, parent="run", entry='cnt = 0;\nprintf("  세탁\\n");')
    c.state("rinse", "RINSE", 520, 210, 140, 55, parent="run", entry='cnt = 0;\nprintf("  헹굼\\n");')
    c.state("spin", "SPIN", 270, 210, 140, 55, parent="run", entry='cnt = 0;\nprintf("  탈수\\n");')
    c.state("paused", "PAUSED", 380, 360, 140, 55, entry='printf("일시정지\\n");')
    c.state("done", "DONE", 30, 330, 130, 60, entry='printf("세탁 완료!\\n");')
    c.init("i0", 40, 110, "idle")
    c.edge("idle", "run", guard="start == true")
    c.edge("fill", "wash", guard="cnt >= fillTicks")
    c.edge("wash", "rinse", guard="cnt >= washTicks")
    c.edge("rinse", "spin", guard="cnt >= rinseTicks")
    c.edge("spin", "done", guard="cnt >= spinTicks")
    c.edge("run", "paused", guard="pause == true", bend=20)
    c.edge("paused", "h", guard="resume == true", bend=20)          # back to where it was paused
    c.edge("done", "idle", guard="start == true")
    p.save("washer.json")


def debounce():
    # the classic 10 ms task pattern: the raw pin level is an input, the debounced state an output;
    # two calls in a row (20 ms) confirm a change
    p = Project("Debounce")
    c = p.cls("Button", [inp("raw"), out("pressed"), cfg("debounceTicks", "2u", "uint8_t"),
                         v("int", "presses", "0"), v("uint8_t", "cnt", "0")])
    c.state("rel", "RELEASED", 60, 80, 160, 60, entry="pressed = false;")
    c.state("dp", "WAIT_PRESS", 400, 80, 160, 70, entry="cnt = 0;", reactions=[("", CNT)])
    c.state("pr", "PRESSED", 400, 260, 160, 60, entry="pressed = true;")
    c.state("dr", "WAIT_RELEASE", 60, 260, 160, 70, entry="cnt = 0;", reactions=[("", CNT)])
    c.init("i0", 30, 110, "rel")
    c.edge("rel", "dp", guard="raw == true", bend=20)
    c.edge("dp", "rel", guard="raw == false", action='printf("튐 무시\\n");', bend=20)
    c.edge("dp", "pr", guard="cnt >= debounceTicks", action='presses++;\nprintf("눌림 확정 (%d번째)\\n", presses);')
    c.edge("pr", "dr", guard="raw == false", bend=20)
    c.edge("dr", "pr", guard="raw == true", bend=20)
    c.edge("dr", "rel", guard="cnt >= debounceTicks", action='printf("떼짐 확정\\n");')
    p.save("debounce.json")


# ============================================================ 고급 (advanced)
def motor():
    # two modules wired output -> input (the simulator copies the previous call's output,
    # main.c does the same in the task)
    p = Project("Plant")
    ctl = p.cls("Controller", [inp("startCmd"), inp("stopCmd"), inp("atSpeed", link="Motor.atSpeed"),
                               out("runCmd"), out("targetRpm", "uint16_t", "0"), cfg("runRpm", "1500u"),
                               cfg("startTimeoutTicks", "300u"), v("uint16_t", "cnt", "0")],
                io_style="struct")
    ctl.state("idle", "IDLE", 40, 160, 150, 60, entry='runCmd = false;\nprintf("[제어기] 대기\\n");')
    ctl.state("st", "STARTING", 460, 160, 160, 70, entry='cnt = 0;\nprintf("[제어기] 모터 기동 요청\\n");',
              reactions=[("", CNT)])
    ctl.state("run", "RUNNING", 860, 160, 150, 60, entry='printf("[제어기] 정상 운전\\n");')
    ctl.state("flt", "FAULT", 460, 360, 150, 60, entry='runCmd = false;\nprintf("[제어기] 기동 실패!\\n");')
    ctl.init("i0", 15, 190, "idle")
    ctl.edge("idle", "st", guard="startCmd == true", action="targetRpm = runRpm;\nrunCmd = true;")
    ctl.edge("st", "run", guard="atSpeed == true")
    ctl.edge("st", "flt", guard="cnt >= startTimeoutTicks")  # 3 s without reaching speed
    ctl.edge("run", "idle", guard="stopCmd == true", bend=110)
    ctl.edge("flt", "idle", guard="stopCmd == true")

    m = p.cls("Motor", [inp("run", link="Controller.runCmd"), inp("target", "uint16_t", "0", link="Controller.targetRpm"),
                        inp("jam"), out("atSpeed"), out("rpm", "uint16_t", "0"),
                        cfg("rampTicks", "10u"), cfg("rpmStep", "300u"), v("uint16_t", "cnt", "0")],
              io_style="struct")
    m.state("stop", "STOPPED", 60, 120, 150, 60, entry='rpm = 0u;\natSpeed = false;\nprintf("  [모터] 정지\\n");')
    m.state("on", "ON", 300, 30, 470, 270)
    m.init("ion", 390, 140, "ramp", parent="on")
    m.state("ramp", "RAMPING", 420, 115, 150, 70, parent="on", entry='cnt = 0;\nprintf("  [모터] %u rpm\\n", (unsigned)rpm);',
            reactions=[("", CNT)])
    # self-transition: leaving and re-entering RAMPING restarts its count (every 100 ms)
    m.edge("ramp", "ramp", guard="(cnt >= rampTicks) && (jam == false) && (rpm + rpmStep < target)", action="rpm += rpmStep;")
    m.state("at", "AT_SPEED", 590, 220, 150, 60, parent="on",
            entry='atSpeed = true;\nprintf("  [모터] 목표 속도 %u rpm 도달\\n", (unsigned)rpm);')
    m.init("i0", 30, 150, "stop")
    m.edge("stop", "on", guard="run == true")
    m.edge("ramp", "at", guard="(cnt >= rampTicks) && (jam == false) && (rpm + rpmStep >= target)", action="rpm = target;")
    m.edge("on", "stop", guard="run == false", bend=40)
    p.save("motor.json")


def modem():
    p = Project("Modem")
    c = p.cls("Modem", [inp("connectOk"), inp("connectFail"), inp("data", "uint16_t", "0"),
                        inp("hangup"), out("online"), cfg("maxRetries", "3", "int"), cfg("answerTimeoutTicks", "200u"),
                        cfg("retryDelayTicks", "100u"), v("int", "retries", "0"), v("int", "bytes", "0"), v("uint16_t", "cnt", "0")],
              io_style="struct")
    c.state("dial", "DIALING", 80, 100, 160, 70,
            entry='cnt = 0;\nretries++;\nprintf("연결 시도 %d/%d\\n", retries, maxRetries);', reactions=[("", CNT)])
    c.state("wait", "WAIT_RETRY", 60, 380, 160, 70, entry='cnt = 0;\nprintf("1초 후 다시 시도\\n");', reactions=[("", CNT)])
    c.state("on", "ONLINE", 460, 100, 170, 70, entry='online = true;\nprintf("연결됨\\n");\nretries = 0;',
            exit="online = false;",
            reactions=[("data > 0u", 'bytes += data;\nprintf("수신 %u바이트 (누적 %d)\\n", (unsigned)data, bytes);')])
    c.pseudo("junction", "j", 380, 300)
    c.pseudo("term", "x", 660, 300)
    c.init("i0", 50, 135, "dial")
    c.edge("dial", "on", guard="connectOk == true")
    c.edge("dial", "j", guard="connectFail == true", bend=-25)
    c.edge("dial", "j", guard="cnt >= answerTimeoutTicks", bend=25)   # no answer within 2 s counts as a failure too
    c.edge("j", "wait", guard="retries < maxRetries")
    c.edge("j", "x", guard="else", action='printf("3번 실패 - 포기합니다\\n");')
    c.edge("wait", "dial", guard="cnt >= retryDelayTicks", bend=-30)
    c.edge("on", "dial", guard="hangup == true", action='printf("끊김 - 다시 연결\\n");', bend=50)
    p.save("modem.json")


def trafficlight():
    p = Project("Traffic")
    c = p.cls("TrafficLight", [inp("pedestrian"), inp("fault"), inp("reset"), inp("setGreen", "uint16_t", "0"),
                               out("lamp", "uint8_t", "0"), v("int", "cycles", "0"),
                               cfg("redTicks", "200u"), cfg("yellowTicks", "100u"), cfg("greenMs", "3000u", "uint32_t"),
                               cfg("blinkTicks", "50u"), cfg("alarmTicks", "300u"), cfg("hurryAfterCycles", "2", "int"),
                               v("uint32_t", "greenCalls", "0"),
                               v("uint32_t", "cnt", "0"), v("uint16_t", "blinkCnt", "0"), v("uint16_t", "alarmCnt", "0")],
              io_style="struct",
              ops=[("void", "show", [("const char *", "what")],
                    'printf("  light: %s (cycles=%d)\\n", what, me->cycles);')])
    c.state("op", "operating", 60, 60, 600, 360,
            reactions=[("", CNT), ("setGreen > 0u", "greenMs = setGreen;")])
    c.init("i1", 95, 130, "red", parent="op")
    c.pseudo("hist", "hop", 95, 390, parent="op")
    c.state("red", "red", 130, 110, 150, 60, parent="op", entry='cnt = 0;\nlamp = 0u;\ncycles++;\nTrafficLight_show(me, "red");')
    # the green length is taken when green is entered: changing greenTime while green applies next time
    c.state("grn", "green", 440, 110, 150, 70, parent="op",
            entry='cnt = 0;\ngreenCalls = greenMs / 10u;\nlamp = 1u;\nTrafficLight_show(me, "green");')
    c.state("yel", "yellow", 280, 310, 150, 60, parent="op", entry='cnt = 0;\nlamp = 2u;\nTrafficLight_show(me, "yellow");')
    c.pseudo("cond", "c1", 590, 270, parent="op")
    c.edge("red", "grn", guard="cnt >= redTicks")
    c.edge("grn", "yel", guard="cnt >= greenCalls")
    c.edge("yel", "red", guard="cnt >= yellowTicks")
    c.edge("grn", "c1", guard="pedestrian == true", bend=-15)
    c.edge("c1", "yel", guard="cycles >= hurryAfterCycles", action='TrafficLight_show(me, "pedestrian: hurry");', bend=-30)
    c.edge("c1", "grn", guard="else", bend=-25)
    c.state("flt", "fault", 740, 60, 330, 360, regions=["blink", "alarm"], entry='lamp = 3u;\nTrafficLight_show(me, "FAULT");')
    c.init("i2", 765, 145, "on", parent="flt", region=0)
    c.state("on", "lampOn", 790, 120, 110, 55, parent="flt", region=0, entry="blinkCnt = 0;", reactions=[("", "blinkCnt++;")])
    c.state("dim", "lampOff", 940, 120, 110, 55, parent="flt", region=0, entry="blinkCnt = 0;", reactions=[("", "blinkCnt++;")])
    c.init("i3", 765, 325, "bp", parent="flt", region=1)
    c.state("bp", "beeping", 790, 300, 110, 55, parent="flt", region=1, entry="alarmCnt = 0;", reactions=[("", "alarmCnt++;")])
    c.state("sil", "silent", 940, 300, 110, 50, parent="flt", region=1)
    c.edge("on", "dim", guard="blinkCnt >= blinkTicks", bend=18)
    c.edge("dim", "on", guard="blinkCnt >= blinkTicks", bend=18)
    c.edge("bp", "sil", guard="alarmCnt >= alarmTicks")
    c.init("i0", 30, 40, "op")
    c.edge("op", "flt", guard="fault == true", bend=25)
    c.edge("flt", "hop", guard="reset == true", bend=-120)      # back into 'operating' via history
    p.save("trafficlight.json")


EXAMPLES = [blink, button_lamp, traffic3, vending, washer, debounce, trafficlight, motor, modem]

if __name__ == "__main__":
    for f in EXAMPLES:
        f()
    stale = os.path.join(OUT, "pwm10us.json")
    if os.path.exists(stale):
        os.remove(stale)
    print("wrote", len(EXAMPLES), "examples to", os.path.normpath(OUT))
