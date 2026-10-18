/* UI functional tests, run inside the editor page:
     (copy to static/_tests/ui_tests.js, then in the page)  await (await import('/_tests/ui_tests.js')).run()
   Uses the editor's own globals and synthetic pointer events on the canvas. Leaves the
   page on a blank project; save the user's work before running. */
export async function run() {
  const W = window;
  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = async (name, fn) => {
    try { const r = await fn(); results.push({ name, ok: r !== false, note: typeof r === "string" ? r : "" }); }
    catch (e) { results.push({ name, ok: false, note: String(e && e.message || e) }); }
  };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const svg = document.getElementById("canvas");
  const $ = (id) => document.getElementById(id);
  // world -> screen
  const scr = (x, y) => { const r = svg.getBoundingClientRect(); return { x: r.left + view.x + x * view.k, y: r.top + view.y + y * view.k }; };
  const pe = (type, x, y, target) => {
    const p = scr(x, y);
    const t = target || document.elementFromPoint(p.x, p.y) || svg;
    t.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 1, isPrimary: true }));
  };
  const drag = async (x1, y1, x2, y2) => {
    const p0 = scr(x1, y1), under = document.elementFromPoint(p0.x, p0.y);
    if (!under || !svg.contains(under))
      throw new Error(`(${x1},${y1}) 위치가 캔버스 밖이거나 가려짐: ${under ? (under.id || under.className || under.tagName) : "none"} view=${JSON.stringify(view)}`);
    pe("pointerdown", x1, y1);
    for (let i = 1; i <= 5; i++) pe("pointermove", x1 + (x2 - x1) * i / 5, y1 + (y2 - y1) * i / 5, svg);
    pe("pointerup", x2, y2, svg);
    await sleep(320);            // let the "slide into view" animation finish, like a user would
  };
  // like a user pressing Esc: close the floating properties card so the whole canvas is free
  const tool = (t) => { svg.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); W.setTool(t); };
  const N = () => W.nodes(), E = () => W.edges();
  const byName = (n) => Object.values(N()).find((x) => x.name === n);
  const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const probs = () => [...document.querySelectorAll("#problems li")].map((li) => li.className + ":" + li.textContent);
  // the class card (right panel) shows the X_Main signature and the argument style
  const classCard = () => { sel = { t: "class" }; W.refreshProps(); return $("props"); };
  const sigText = () => classCard().querySelector("pre.sig").textContent;

  const langBefore = LANG; W.setLanguage("ko");     // the checks below look for the Korean messages
  W.loadProject(W.blankProject());
  W.setBottom(false);                         // start with the whole canvas visible
  view = { x: 0, y: 0, k: 1 }; W.applyView();
  const origAlert = W.alert, origConfirm = W.confirm, alerts = [];
  W.alert = (m) => alerts.push(m); W.confirm = () => true;

  // ---------------------------------------------------------------- drawing
  await T("상태 그리기 (드래그)", async () => {
    tool("state"); await drag(100, 100, 260, 160);
    eq(Object.values(N()).filter((n) => n.kind === "state").length, 1, "states");
    eq(document.activeElement.id, "pName", "name field focused");
    typeInto($("pName"), "IDLE");
    eq(byName("IDLE") ? 1 : 0, 1, "renamed");
  });
  await T("상태 안에 그리면 하위 상태", async () => {
    tool("state"); await drag(330, 80, 620, 320); typeInto($("pName"), "WORK");
    tool("state"); await drag(370, 130, 490, 180); typeInto($("pName"), "STEP1");
    tool("state"); await drag(470, 240, 600, 290); typeInto($("pName"), "STEP2");
    eq(byName("STEP1").parent, byName("WORK").id, "STEP1 parent");
    eq(byName("STEP2").parent, byName("WORK").id, "STEP2 parent");
  });
  await T("기본 전이 (최상위, 복합 상태 안)", async () => {
    tool("init"); await drag(60, 130, 150, 130);
    tool("init"); await drag(350, 155, 400, 155);
    const inits = Object.values(N()).filter((n) => n.kind === "init");
    eq(inits.length, 2, "init dots");
    const targets = inits.map((i) => Object.values(E()).find((e) => e.from === i.id)).map((e) => N()[e.to].name).sort();
    eq(targets, ["IDLE", "STEP1"], "init targets");
  });
  await T("전이 그리기 + Guard 입력 (시간은 카운터 변수로)", async () => {
    tool("trans"); await drag(200, 130, 520, 92);            // IDLE -> WORK (lands on WORK's name bar)
    typeInto($("pGuard"), "start");
    tool("trans"); await drag(440, 160, 540, 265);           // STEP1 -> STEP2
    typeInto($("pGuard"), "cnt >= 50u");
    tool("trans"); await drag(600, 100, 180, 150);           // WORK -> IDLE
    typeInto($("pGuard"), "stop");
    $("pGuard").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));   // done
    const lbl = Object.values(E()).filter((e) => N()[e.from].kind === "state").map((e) => `${N()[e.from].name}>${N()[e.to].name}:${e.trigger}[${e.guard}]`).sort();
    eq(lbl, ["IDLE>WORK:[start]", "STEP1>STEP2:[cnt >= 50u]", "WORK>IDLE:[stop]"], "edges");
    if ($("pTrigger")) throw new Error("the Timer field should be gone");
  });
  await T("입력 변수 선언 → 시그니처 미리보기 (출력 0개 = void)", async () => {
    const c = W.cls();
    c.attributes.push({ type: "bool", name: "start", default: "false", dir: "in" },
                      { type: "bool", name: "stop", default: "false", dir: "in" },
                      { type: "uint16_t", name: "cnt", default: "0", dir: "local" });
    Object.assign(byName("STEP1"), { entry: "cnt = 0;", reactions: [{ trigger: "", guard: "", action: "cnt++;" }] });
    W.refreshAll();
    const sig = sigText();
    if (!sig.includes("void Controller_Main(Controller* const me, bool i_start, bool i_stop);")) throw new Error(sig);
    sel = null; W.refreshProps();
  });
  await T("옛 프로젝트: 이벤트 → 입력 변수, tm() → 카운터 변수로 바뀜", async () => {
    const e = Object.values(E()).find((x) => N()[x.from].name === "STEP1");
    const keep = JSON.stringify(byName("STEP1")), keepAttrs = JSON.stringify(W.cls().attributes);
    e.trigger = "evGo"; e.guard = "x > 1";
    W.autoDeclareEvents();
    const a = W.cls().attributes.find((v) => v.name === "evGo");
    if (!a || a.dir !== "in") throw new Error("no input evGo: " + JSON.stringify(a));
    eq([e.trigger, e.guard], ["", "(evGo == true) && (x > 1)"], "moved to guard, written as evGo == true");
    e.trigger = "tm(300)"; e.guard = "";
    W.autoDeclareEvents();
    eq([e.trigger, e.guard], ["", "cnt_STEP1 >= 30u"], "tm(300) -> counter");
    if (!byName("STEP1").entry.startsWith("cnt_STEP1 = 0;")) throw new Error("entry not set: " + byName("STEP1").entry);
    if (byName("STEP1").reactions[0].action !== "cnt_STEP1++;") throw new Error("no counting reaction");
    Object.assign(byName("STEP1"), JSON.parse(keep)); W.cls().attributes = JSON.parse(keepAttrs);
    e.trigger = ""; e.guard = "cnt >= 50u"; W.refreshAll();
  });
  await T("자기 전이 (같은 상태에 놓기)", async () => {
    tool("trans"); await drag(150, 140, 160, 145);
    const self = Object.values(E()).find((e) => e.from === e.to);
    if (!self) throw new Error("no self transition");
    typeInto($("pGuard"), "start");
  });
  await T("전이 우선순위: 번호 표시, ▼로 바꾸면 생성 코드의 검사 순서도 바뀜", async () => {
    const idle = byName("IDLE").id;
    const toWork = Object.values(E()).find((x) => x.from === idle && N()[x.to].name === "WORK");
    const self = Object.values(E()).find((x) => x.from === idle && x.to === idle);
    eq(W.outgoingOrdered(idle).map((x) => x.id), [toWork.id, self.id], "drawing order");
    sel = { t: "edge", id: toWork.id }; W.refreshProps();
    if (!$("props").textContent.includes("우선순위")) throw new Error("no priority section");
    const badges = [...document.querySelectorAll("#world .pbadge text")].map((x) => x.textContent);
    if (!badges.includes("1") || !badges.includes("2")) throw new Error("no numbered priority badges: " + badges.join(","));
    if (document.querySelector("#world .pbadge.first") === null) throw new Error("the first-tested badge is not highlighted");
    $("prioDown").click();
    eq(W.outgoingOrdered(idle).map((x) => x.id), [self.id, toWork.id], "after ▼");
    const src = (await W.generateC()).files["Controller.c"];
    if (!(src.indexOf("/*## transition IDLE>IDLE */") < src.indexOf("/*## transition IDLE>WORK */"))) throw new Error("code order not changed");
    sel = { t: "edge", id: toWork.id }; W.refreshProps(); $("prioUp").click();
    eq(W.outgoingOrdered(idle).map((x) => x.id), [toWork.id, self.id], "after ▲");
    sel = null; W.refreshProps(); W.setBottom(false);
  });
  await T("구조 검사: 예제 9개는 경고(⚠)가 하나도 없음", async () => {
    const keep = JSON.stringify(project), keepCur = cur, lang0 = LANG;
    W.setLanguage("en");
    try {
      const names = [...document.querySelectorAll("#newMenu [data-new]")].map((b) => b.dataset.new).filter((x) => x !== "blank");
      for (const n of names) {
        W.loadProject(await (await fetch(`examples/${n}.json`)).json());
        W.validate();
        if (W.defects().length) throw new Error(n + ": " + W.defects().map((x) => x[1]).join(" | "));
        if (Object.keys(marks.node).length + Object.keys(marks.edge).length) throw new Error(n + ": marks on a clean chart");
      }
    } finally {
      W.setLanguage(lang0); W.loadProject(JSON.parse(keep)); cur = keepCur; W.refreshAll();
    }
  });
  await T("구조 검사: 잘못 그린 차트 (연결 안 된 if·⊗, 들어오는 전이 없는 H, 같은 guard 두 개) → 경고·표시·Generate 전 확인", async () => {
    const keep = JSON.stringify(project), keepCur = cur, lang0 = LANG;
    W.setLanguage("en");
    try {
      const st = (id, name, x) => ({ kind: "state", name, x, y: 100, w: 120, h: 60, parent: null, region: 0, entry: "", exit: "", reactions: [] });
      const node = (kind, x, y, parent) => ({ kind, x, y, parent: parent || null, region: 0 });
      const ed = (from, to, guard) => ({ from, to, trigger: "", guard: guard || "", action: "" });
      W.loadProject({ package: "Bad", types: [], events: [], classes: [{ name: "Bad", attributes: [{ type: "bool", name: "start", default: "false", dir: "in" }], operations: [], assocs: [], init: "",
        chart: { nodes: { i0: node("init", 10, 130), idle: st("idle", "IDLE", 80), work: { ...st("work", "WORK", 300), w: 260, h: 200 },
                          s1: { ...st("s1", "STEP1", 320), parent: "work", y: 140, w: 100, h: 40 }, i1: node("init", 330, 130, "work"),
                          c1: node("cond", 200, 320), x1: node("term", 260, 380), h1: node("hist", 520, 240, "work"), j1: node("junction", 200, 260) },
                 edges: { e0: ed("i0", "idle"), e1: ed("idle", "idle", "start == true"), e2: ed("idle", "work", "start == true"), e3: ed("i1", "s1"),
                          e4: ed("s1", "j1", "start == true"), e5: ed("h1", "s1") } } }] });
      W.validate();
      const text = W.defects().map((x) => x[1]).join("\n");
      for (const want of ["condition connector (C) is not connected", "termination connector (⊗) is not connected", "nothing leads into the history connector (H)",
                            "can never fire", "has no outgoing transition"])
        if (!text.includes(want)) throw new Error(`missing warning "${want}":\n${text}`);
      if (!Object.keys(marks.node).includes("c1") || !Object.keys(marks.node).includes("x1") || !Object.keys(marks.node).includes("h1")) throw new Error("connectors not marked: " + JSON.stringify(marks));
      if (!Object.keys(marks.edge).includes("e2") || Object.keys(marks.edge).includes("e1")) throw new Error("the later of the two [start] transitions (IDLE → WORK) should be the marked one: " + JSON.stringify(marks));
      W.render();
      if (!document.querySelector("#world .mark-warn")) throw new Error("no marked element drawn");
      if (!document.querySelectorAll("#world .warnbadge").length) throw new Error("no ⚠ drawn");
      if (!$("probCount").classList.contains("defect")) throw new Error("Problems count not highlighted");
      // clicking a problem selects the element
      const li = [...document.querySelectorAll("#problems li.jump")].find((l) => l.textContent.includes("history"));
      li.click();
      eq(sel.id, "h1", "selected by clicking the problem");
      // Generate / Build ask first; cancelling does nothing
      let asked = null;
      const oc = W.confirm; W.confirm = (m) => { asked = m; return false; };
      const g = await W.generateC();
      W.confirm = oc;
      if (g !== null) throw new Error("generated although cancelled");
      if (!asked || !asked.includes("problem") || !asked.includes("never used")) throw new Error("no useful question: " + asked);
    } finally {
      W.setLanguage(lang0); W.loadProject(JSON.parse(keep)); cur = keepCur; W.refreshAll();
    }
  });
  await T("연결 모양: C / J / H / ⊗ / 기본 전이 점이 서로 다른 모양·색", async () => {
    const keep = JSON.stringify(project), keepCur = cur, lang0 = LANG;
    W.setLanguage("en");
    try {
      W.loadProject({ package: "S", types: [], events: [], classes: [{ name: "S", attributes: [], operations: [], assocs: [], init: "",
        chart: { nodes: { i0: { kind: "init", x: 20, y: 20, parent: null, region: 0 }, c: { kind: "cond", x: 80, y: 20, parent: null, region: 0 },
                          j: { kind: "junction", x: 140, y: 20, parent: null, region: 0 }, t: { kind: "term", x: 200, y: 20, parent: null, region: 0 } }, edges: {} } }] });
      const q = (k) => document.querySelector(`#world .pseudo.k-${k}`);
      const fill = (k, sel2) => getComputedStyle(q(k).querySelector(sel2)).fill;
      if (q("cond").querySelector("text").textContent !== "C") throw new Error("cond is not labelled C");
      if (q("junction").querySelector("text").textContent !== "J") throw new Error("junction is not labelled J");
      const colors = new Set([fill("init", ".fill"), fill("cond", ".shape"), fill("junction", ".shape"), fill("term", ".shape")]);
      if (colors.size < 4) throw new Error("connector colors are not all different: " + [...colors].join(" "));
      const r = (k) => +q(k).querySelector(".shape, .fill").getAttribute("r") || 0;
      if (r("junction") <= r("init")) throw new Error("junction must be clearly bigger than the default dot");
    } finally {
      W.setLanguage(lang0); W.loadProject(JSON.parse(keep)); cur = keepCur; W.refreshAll();
    }
  });
  await T("조건 없는 전이 2개 → 두 번째는 절대 안 일어난다는 경고", async () => {
    const work = byName("WORK").id, idle = byName("IDLE").id;
    const a = { id: "tA", from: work, to: idle, trigger: "", guard: "", action: "" }, b = { id: "tB", from: work, to: idle, trigger: "", guard: "", action: "" };
    E().tA = a; E().tB = b; W.validate();
    const hit = probs().some((p) => p.startsWith("warn") && p.includes("절대 일어나지 않습니다"));
    delete E().tA; delete E().tB; W.refreshAll();
    if (!hit) throw new Error("no unreachable warning");
  });
  await T("조건 커넥터 + 히스토리 + 종료 커넥터 놓기", async () => {
    tool("cond"); await drag(280, 260, 280, 260);
    tool("hist"); await drag(350, 300, 350, 300);
    tool("term"); await drag(280, 360, 280, 360);
    const kinds = Object.values(N()).filter((n) => n.kind !== "state" && n.kind !== "init").map((n) => n.kind).sort();
    eq(kinds, ["cond", "hist", "term"], "pseudo nodes");
    eq(Object.values(N()).find((n) => n.kind === "hist").parent, byName("WORK").id, "history inside WORK");
  });
  await T("히스토리는 복합 상태 밖에 못 놓음", async () => {
    const before = Object.keys(N()).length;
    tool("hist"); await drag(200, 380, 200, 380);
    eq(Object.keys(N()).length, before, "nothing added");
  });
  await T("상태 이동 시 하위 상태도 같이 이동", async () => {
    tool("select");
    const w = byName("WORK"), s1 = byName("STEP1"), dx0 = s1.x - w.x;
    await drag(w.x + 200, w.y + 10, w.x + 220, w.y + 40);
    eq(byName("STEP1").x - byName("WORK").x, dx0, "relative position kept");
    eq(byName("STEP1").parent, byName("WORK").id, "still nested");
  });
  await T("삭제 → 연결된 전이도 삭제, Undo/Redo", async () => {
    sel = { t: "node", id: byName("STEP2").id };
    const edgesBefore = Object.keys(E()).length;
    W.deleteSelection();
    if (byName("STEP2")) throw new Error("not deleted");
    if (Object.keys(E()).length >= edgesBefore) throw new Error("edges not removed");
    W.undo();
    if (!byName("STEP2")) throw new Error("undo failed");
    W.redo();
    if (byName("STEP2")) throw new Error("redo failed");
    W.undo();
  });
  await T("이름 칸에서 Backspace는 상태를 지우지 않음", async () => {
    sel = { t: "node", id: byName("IDLE").id }; W.refreshProps();
    $("pName").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    if (!byName("IDLE")) throw new Error("state deleted while typing");
  });
  await T("속성 카드 ✕ 버튼으로 닫힘", async () => {
    sel = { t: "node", id: byName("IDLE").id }; W.refreshProps();
    if ($("right").hidden) throw new Error("card not open");
    $("propsClose").click();
    if (!$("right").hidden) throw new Error("card still open");
  });
  await T("AND 상태로 바꾸면 영역 2개", async () => {
    sel = { t: "node", id: byName("WORK").id }; W.refreshProps();
    const cb = [...document.querySelectorAll("#props input[type=checkbox]")][0];
    cb.checked = true; cb.dispatchEvent(new Event("change"));
    eq((byName("WORK").regions || []).length, 2, "regions");
    cb.checked = false; cb.dispatchEvent(new Event("change"));
  });

  // ---------------------------------------------------------------- left panel
  await T("변수 추가/이름 검사 (예약어 거부) — 왼쪽 VARIABLES 한 줄 편집", async () => {
    document.querySelector('#varList [data-addvar="local"]').click();
    const nameIn = [...document.querySelectorAll("#varList .vgroup.local ~ .vrow input.vname")].pop();
    if (document.activeElement !== nameIn) throw new Error("new variable's name not focused");
    const grp = (d) => [...document.querySelectorAll("#varList .vgroup." + d + " ~ .vrow")].filter((r) => { let p = r.previousElementSibling; while (p && !p.classList.contains("vgroup")) p = p.previousElementSibling; return p && p.classList.contains(d); }).length;
    for (const d of ["in", "out", "config"]) {
      const before = grp(d);
      document.querySelector(`#varList [data-addvar="${d}"]`).click();
      if (grp(d) !== before + 1) throw new Error(`+ in the ${d} group did not add a ${d} variable`);
      if (W.cls().attributes[W.cls().attributes.length - 1].dir !== d) throw new Error(`new variable has the wrong direction (${d})`);
      W.cls().attributes.pop(); W.refreshAll();
    }
    if (document.querySelectorAll("#varList select").length) throw new Error("rows should not have a direction dropdown");
    const head = document.querySelector("#varList .vhead");
    if (!head || ["Type", "Name", "Initial", "타입", "이름", "초깃값"].filter((w) => head.textContent.includes(w)).length < 3) throw new Error("column names missing: " + (head && head.textContent));
    if (document.querySelectorAll("#varList .vgroup .vsub").length !== 4) throw new Error("each group needs its one-line meaning");
    typeInto(nameIn, "switch");
    W.validate();
    if (!probs().some((p) => p.startsWith("err") && p.includes("switch"))) throw new Error("keyword not reported");
    typeInto(nameIn, "count");
    W.validate();
    if (probs().some((p) => p.includes("switch"))) throw new Error("error stays");
  });
  await T("방향: 출력 1개 = return, 2개 = void + o_ 포인터", async () => {
    const c = W.cls();
    c.attributes.push({ type: "uint8_t", name: "lamp", default: "0", dir: "out" });
    W.refreshAll();
    if (!sigText().includes("uint8_t Controller_Main(Controller* const me, bool i_start, bool i_stop);"))
      throw new Error("one output: " + sigText());
    c.attributes.push({ type: "bool", name: "busy", default: "false", dir: "out" });
    W.refreshAll();
    if (!sigText().includes("void Controller_Main(Controller* const me, bool i_start, bool i_stop, uint8_t* const o_lamp, bool* const o_busy);"))
      throw new Error("two outputs: " + sigText());
    c.attributes.splice(c.attributes.findIndex((a) => a.name === "busy"), 1);
    sel = null; W.refreshAll();
  });
  await T("X_Main 인자 방식: 4개 초과 경고 → 구조체로 바꾸면 X_In / X_Out", async () => {
    const c = W.cls();
    c.attributes.push({ type: "bool", name: "busy", default: "false", dir: "out" },
                      { type: "uint16_t", name: "speed", default: "0", dir: "in" });
    W.refreshAll();
    if (!probs().some((p) => p.startsWith("warn") && p.includes("스택"))) throw new Error("no >4 argument warning: " + probs().join(" | "));
    if (!classCard().querySelector(".hint.warn")) throw new Error("hint not highlighted");
    const io = () => classCard().querySelector("select");
    let x = io(); x.value = "struct"; x.dispatchEvent(new Event("change"));
    eq(W.cls().ioStyle, "struct", "saved in project");
    const sig = sigText();
    if (!sig.includes("typedef struct { bool start; bool stop; uint16_t speed; } Controller_In;")) throw new Error("no In typedef: " + sig);
    if (!sig.includes("void Controller_Main(Controller* const me, const Controller_In* const in, Controller_Out* const out);")) throw new Error(sig);
    if (probs().some((p) => p.includes("스택"))) throw new Error("warning stays");
    const g = await W.generateC();
    if (!g.files["Controller.c"].includes("me->speed = in->speed;")) throw new Error("struct latch not generated");
    if (!g.files["main.c"].includes("Controller_Main(&itsController, &io_Controller_in, &io_Controller_out);")) throw new Error("main.c call");
    x = io(); x.value = "params"; x.dispatchEvent(new Event("change"));
    if (W.cls().ioStyle !== undefined) throw new Error("not back to parameters");
    c.attributes.splice(c.attributes.findIndex((a) => a.name === "busy"), 1);
    c.attributes.splice(c.attributes.findIndex((a) => a.name === "speed"), 1);
    sel = null; W.refreshAll(); W.setBottom(false);
  });
  await T("변수 이름 중복 → 오류", async () => {
    const c = W.cls();
    c.attributes.push({ type: "int", name: "count", default: "0", dir: "local" }); W.validate();
    const dup = probs().some((p) => p.startsWith("err") && p.includes("중복"));
    c.attributes.pop(); W.refreshAll();
    if (!dup) throw new Error("duplicate not reported");
  });
  await T("왼쪽 패널 폭 조절: 가장자리를 끌면 넓어지고, 더블클릭하면 기본 폭", async () => {
    const bar = $("leftResize"), w0 = $("left").offsetWidth, r = bar.getBoundingClientRect();
    const ev = (type, x) => bar.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: r.top + 40, pointerId: 7, isPrimary: true }));
    ev("pointerdown", r.left + 3); ev("pointermove", r.left + 3 + 120); ev("pointerup", r.left + 123);
    const w1 = $("left").offsetWidth;
    if (w1 < w0 + 90) throw new Error(`not wider: ${w0} -> ${w1}`);
    if (document.getElementById("libList") || document.getElementById("addLib")) throw new Error("library section still there");
    bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    eq($("left").offsetWidth, 260, "default width");
  });

  // ---------------------------------------------------------------- generate / build
  await T("기본 전이 없으면 Generate 막힘", async () => {
    const init = Object.values(N()).find((n) => n.kind === "init" && !n.parent);
    sel = { t: "node", id: init.id }; W.deleteSelection();
    const g = await W.generateC();
    W.undo();
    if (g) throw new Error("generated despite error");
  });
  await T("Generate → 파일 목록", async () => {
    const g = await W.generateC();
    eq(Object.keys(g.files).sort(), ["Controller.c", "Controller.h", "main.c"], "files (module + example main, no framework)");
    if (Object.values(g.files).some((t) => /RiC|ric_reactive/.test(t))) throw new Error("framework name in generated code");
  });
  await T("상태·전이를 누르면 코드가 해당 위치로 이동 (그림을 고쳤으면 다시 생성)", async () => {
    // follow() calls followCode() itself and waits for it, so the test never depends on animation
    // frames (the browser throttles them when the pane is hidden)
    const follow = async () => { while (followBusy) await sleep(20); await W.followCode(); };
    await W.generateC();
    sel = { t: "node", id: byName("STEP1").id }; W.refreshProps(); await follow();
    let mark = document.querySelector("#code .codemark");
    if (!mark) throw new Error("no mark for state");
    const e = Object.values(E()).find((x) => N()[x.from].name === "IDLE" && N()[x.to].name === "WORK");
    e.action = "count = 7;"; W.snapshot();                       // edit -> code is stale
    sel = { t: "edge", id: e.id }; W.refreshProps(); await follow();
    mark = document.querySelector("#code .codemark");
    if (!mark) throw new Error("no mark for transition");
    if (!$("code").textContent.includes("me->count = 7;")) throw new Error("code not regenerated after edit");
    e.action = ""; W.snapshot();
  });
  await T("ZIP 내려받기 내용", async () => {
    // server mode: /api/zip; GitHub Pages mode: the Pyodide zip
    const blob = serverMode === true ? await (await fetch("/api/zip?pkg=" + project.package)).blob() : await Backend.zip(project);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(buf);
    for (const f of ["Controller.c", "Controller.h", "main.c"])
      if (!text.includes(f)) throw new Error("zip lacks " + f);
    for (const f of ["sim_main.c", "RiCLite", "ut.h", "test_Default.c", ".obj"]) if (text.includes(f)) throw new Error("zip contains " + f);
  });
  await T("Build: 컴파일 성공 (/W4 경고 없음) → 버튼 ✓, Simulate·Unit Test·Variables 화면 없음", async () => {
    const keep = JSON.stringify(project), keepCur = cur;
    try {
      W.loadProject(await (await fetch("examples/blink.json")).json());    // a known, correct chart (earlier tests leave stray connectors)
      if (!(await W.build())) throw new Error("build failed: " + probs().join(" | "));
      if (!$("bCompile").classList.contains("ok")) throw new Error("no ✓ after a clean build");
    } finally { W.loadProject(JSON.parse(keep)); cur = keepCur; W.refreshAll(); }
    for (const id of ["bBuild", "tab-sim", "tab-ut", "tab-vars", "simLog", "utEdit", "varTable"]) if ($(id)) throw new Error(id + " still there");
    if (document.querySelector('#tabs [data-tab="sim"], #tabs [data-tab="ut"], #tabs [data-tab="vars"]')) throw new Error("removed tab still in the tab bar");
  });
  await T("추적: 같은 두 상태 사이 전이 2개 (Lamp: [button == true] / [forceOff == true]) → 각자 자기 블록", async () => {
    const keep = JSON.stringify(project), keepCur = cur;
    W.loadProject(await (await fetch("examples/button_lamp.json")).json());
    const g = await W.generateC();
    const on = byName("LAMP_ON").id, off = byName("LAMP_OFF").id;
    for (const guard of ["button == true", "forceOff == true"]) {
      const e = Object.values(E()).find((x) => x.from === on && x.to === off && x.guard === guard);
      sel = { t: "edge", id: e.id };
      const loc = W.locateSelection(g);
      const lines = g.files["Lamp.c"].split("\n");
      const first = lines[loc.start].trim();
      if (!first.includes(`(me->${guard.split(" ")[0]} == true)`)) throw new Error(`${guard}: block starts at "${first}"`);
      if (!lines.slice(loc.start, loc.end + 1).join("\n").includes("res = true;")) throw new Error(`${guard}: block cut short`);
    }
    if (W.fileHelp("Lamp.c", "Lamp").includes("여러 클래스")) throw new Error("Lamp.c shows the shared-types note");
    sel = null; W.refreshProps();
    W.loadProject(JSON.parse(keep)); cur = keepCur; W.refreshAll();
    if (!(await W.build())) throw new Error("rebuild after restore failed");
  });
  await T("빌드 실패 → Problems에 컴파일 오류", async () => {
    const st = byName("IDLE"); const old = st.entry; st.entry = "this is not C"; W.snapshot();
    const ok = await W.build();
    st.entry = old;
    if (ok) throw new Error("build passed");
    if (!probs().some((p) => p.startsWith("err") && p.includes("build:"))) throw new Error("errors not shown");
    await W.build();
  });

  // ---------------------------------------------------------------- main.c, save/open, layout
  await T("X_Main 본문 편집 (클래스 카드) → 생성 코드의 사용자 영역에 들어감", async () => {
    const ta = [...classCard().querySelectorAll("textarea")].find((t) => t.placeholder.includes("_takeTrigger"));
    if (!ta) throw new Error("no X_Main body field in the class card");
    typeInto(ta, "count++;\nController_takeTrigger(me);");
    const g = await W.generateC();
    if (!/operation Main\(\) \*\/\s*\n\s*me->count\+\+;\s*\n\s*Controller_takeTrigger\(me\);/.test(g.files["Controller.c"])) throw new Error("user code not in Main");
    typeInto(ta, ""); delete W.cls().main;
    sel = null; W.refreshProps(); W.setBottom(false);
    await W.build();
  });
  await T("Save → Open 왕복 시 내용 동일", async () => {
    const json = JSON.stringify(project);
    W.loadProject(JSON.parse(json));
    const strip = (p) => JSON.stringify(p, (k, v) => (k === "id" ? undefined : v));
    eq(strip(project), strip(JSON.parse(json)), "project");
  });
  await T("새로고침 후에도 작업 유지 (자동 저장)", async () => {
    const saved = JSON.parse(localStorage.getItem("scstudio.project"));
    eq(saved.classes[0].chart && Object.keys(saved.classes[0].chart.nodes).length, Object.keys(N()).length, "nodes saved");
  });
  await T("✨ 정리 → 부모 관계 유지, Ctrl+Z로 원위치", async () => {
    const before = JSON.stringify(Object.values(N()).map((n) => [n.id, n.parent, n.x, n.y]));
    $("optimize").click();
    const mid = Object.values(N()).map((n) => [n.id, n.parent]);
    eq(mid, JSON.parse(before).map((x) => [x[0], x[1]]), "parents");
    W.undo();
    eq(JSON.stringify(Object.values(N()).map((n) => [n.id, n.parent, n.x, n.y])), before, "undo");
  });
  await T("클래스 추가 → 캔버스 분리, 전환해도 그림 유지", async () => {
    const count = Object.keys(N()).length;
    $("addClass").click();
    eq(Object.keys(N()).length, 0, "new class empty");
    document.querySelectorAll("#classList li")[0].click();
    eq(Object.keys(N()).length, count, "first class intact");
  });
  await T("예제 모두 열림 (New 메뉴), 오류 없음", async () => {
    const names = [...document.querySelectorAll("#newMenu [data-new]")].map((b) => b.dataset.new).filter((x) => x !== "blank");
    for (const n of names) {
      const r = await fetch(`examples/${n}.json`);
      if (!r.ok) throw new Error(n + " missing");
      W.loadProject(await r.json());
      W.validate();
      if (probs().some((p) => p.startsWith("err"))) throw new Error(n + ": " + probs().filter((p) => p.startsWith("err")).join(", "));
    }
    return `${names.length}개`;
  });

  W.alert = origAlert; W.confirm = origConfirm;
  W.setLanguage(langBefore); W.refreshAll();
  return results;
}
