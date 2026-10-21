# Statechart Studio — 스테이트차트를 그리면 10 ms task에 바로 넣는 C 모듈이 나오는 편집기

브라우저에서 클래스마다 상태차트를 그리고 **Generate C**를 누르면 **프레임워크 없는** `X.c / X.h` 두 파일이 나옵니다.
MCU 프로젝트에 복사하고, 이미 돌고 있는 10 ms task에서 두 함수만 부르면 됩니다.

```c
static Led itsLed;
static bool io_Led_led = false;

/* 10 ms task */
void Task_10ms(void) {
    io_Led_led = Led_Main(&itsLed);      /* 입력 래치 → 내부 반응 → 전이 최대 1개 → 출력 */
}

int main(void) {
    Led_Init(&itsLed);                   /* 한 번: 변수 초기화 + 처음 상태로 진입 */
    for (;;) {
        Task_10ms();                     /* every 10 ms */
    }
}
```

- 생성 코드는 **C89(ANSI C / C90)** 입니다: `/* */` 주석만, 선언은 블록 맨 앞, 지정 초기화(`.x = 1`) 없음, `<stdbool.h>` 없음(`bool`은 `uint8_t`, `false`/`true`는 enum 상수로 헤더에 들어 있고, `<stdbool.h>`를 먼저 include했다면 그걸 씁니다). `uint8_t` 등과 `NULL`을 쓰려고 `<stdint.h>`, `<stddef.h>`만 필요합니다. MSVC C 컴파일러는 C99 확장도 받아 주므로 `tests/c89_lint.py`가 C89 위반(`//`, 선언 뒤 선언 순서, 지정 초기화 …)을 따로 검사하고, gcc가 있으면 Build가 `-std=c89 -pedantic`으로 컴파일합니다.
- 이벤트·이벤트 큐·타이머·`tm()`·매크로가 **없습니다**. 생성 모듈에는 include guard 말고 `#define`이 하나도 없고, `<stddef.h>`, `<stdint.h>`, `<stdbool.h>`만 씁니다.
- 전이는 **Guard [조건]** 뿐이고, 그림에 쓴 C 코드가 그대로 생성 코드에 들어갑니다. "이벤트"는 입력 변수를 Guard로 읽으면 됩니다. bool도 비교식으로 씁니다(읽기 쉽게): `[button == true]`, `[(raw == true) && (jam == false)]`.
- **시간은 변수로 셉니다.** `X_Main`은 10 ms마다 불린다고 보고, 상태에 이렇게 씁니다:
  ```
  LED_ON   entry/     cnt = 0;
           내부 반응/  cnt++;
  LED_ON --[cnt >= 50u]--> LED_OFF          (50 x 10 ms = 500 ms)
  ```
  생성 코드도 그대로입니다: `if (me->cnt >= 50u) { ... }`.
- `X_Main` 한 번(= `X_takeTrigger`)은 **① 활성 상태들의 내부 반응을 바깥→안 순서로 모두 실행 → ② 전이를 최대 1개**(AND 상태는 영역마다 1개) 실행합니다. 내부 반응이 먼저라서 위 카운터는 정확히 50번째 호출에 넘어갑니다.

```bash
python editor/server.py
```

브라우저에서 http://127.0.0.1:8770/ 을 엽니다. 화면은 영어가 기본이고, 상단의 **한국어 / English** 버튼으로 바꿉니다(선택은 기억됨). (`.claude/launch.json`의 `statechart-editor` 구성과 같습니다.)

## 그리기

| 도구 | 키 | 사용법 |
|---|---|---|
| 선택 | V | 클릭으로 선택, 끌어서 이동(하위 상태도 같이 움직임), 오른쪽 아래 핸들로 크기 조절, 빈 곳을 끌면 화면 이동, 휠로 확대/축소 |
| 상태 | S | 드래그로 상자를 그립니다. **다른 상태 안에 그리면 하위 상태**가 됩니다. 만들자마자 이름을 입력하고 Enter |
| 전이 | T | 소스에서 타깃까지 드래그. 같은 상태에 놓으면 자기 전이. 만들면 Guard 칸에 입력 |
| 기본 전이 | D | 컨테이너(또는 최상위 빈 곳) 안에서 시작해 처음 들어갈 상태로 드래그 |
| 조건 커넥터 ◇ | C | 나가는 전이마다 `[guard]`, 하나는 `else` |
| 정션 • | J | 여러 전이를 합침 |
| 히스토리 H | H | 복합 상태 안에 둡니다. 이 커넥터로 들어오는 전이는 마지막 하위 상태로 복귀(shallow) |
| 종료 ⊗ | X | 도달하면 상태 머신 종료 (이후 `X_Main`은 아무것도 하지 않음) |

- **AND 상태**: 상태를 선택하고 오른쪽 패널에서 `AND state`를 체크합니다. 영역마다 기본 전이가 하나씩 있어야 합니다.
- **전이 라벨**: `[(button == true) && (cnt > 2u)]/cnt = 0;` 형식. Guard가 없으면 다음 `X_Main` 호출에 바로 일어납니다.
- **전이 우선순위**: 같은 상태(또는 커넥터)에서 나가는 전이가 2개 이상이면 나가는 쪽 끝에 번호 원(1이 파란색)이 붙습니다. Guard가 동시에 참이면 번호가 작은 것이 일어납니다. 전이 카드의 **▲ 먼저 / ▼ 나중에**로 바꿉니다(기본은 그린 순서). Guard가 없는 전이(`[else]` 포함)는 항상 마지막이고, 그런 전이가 2개면 Problems에 경고가 나옵니다. 안쪽 상태의 전이가 부모 상태의 전이보다 먼저입니다.
- **Internal reactions**: 상태에 머무는 동안 매 호출 Guard를 보고 액션을 실행합니다(탈출·진입 없음). Guard를 비우면 매 호출 실행됩니다(카운터 `cnt++;`).
- 옛 프로젝트를 열면 이벤트 트리거는 **bool 입력 변수**(`evX == true`)로, `tm(500)`은 **`cnt_<상태>` 카운터 변수 + entry/내부 반응/Guard**로 자동으로 바뀝니다(타이밍은 같음).
- 왼쪽 패널은 오른쪽 가장자리를 **끌어서** 폭을 조절합니다(더블클릭 = 기본 폭, 선택은 기억됨). 직접 만든 .c/.h를 쓰려면 **Types / includes** 칸에 `#include "uart.h"`를 쓰면 됩니다.
- Del 삭제, Ctrl+Z / Ctrl+Y 되돌리기, F 화면 맞추기, Esc 선택 해제, Ctrl+S JSON 저장. 작업 내용은 브라우저에 자동 저장됩니다.

액션/가드 코드에서 쓸 수 있는 것:

```c
cnt++;  led = true;                  /* 변수는 이름 그대로 (생성 코드에서 me->cnt 로 바뀜) */
(button == true) && (jam == false)   /* 입력은 이번 X_Main 호출 동안 고정된 값(래치) */
IS_IN(heating)                       /* 상태 확인 → 생성 코드에서 Oven_isIn(me, Oven_heating) */
Oven_show(me, "x");                  /* 오퍼레이션 */
```

## 변수 · 입출력

왼쪽 **VARIABLES** 칸은 **Input / Output / Config / Internal** 네 묶음이고, 묶음 제목 줄의 **+**로 그 방향의 변수를 추가합니다. 변수 하나는 한 줄(`타입 · 이름 · 초깃값 · ✕`)입니다.

| 방향 | 생성 코드 |
|---|---|
| **입력** | `X_Main`의 `i_<이름>` 파라미터 (호출 시작에 `me-><이름>`으로 래치) |
| **출력** | 1개면 `X_Main`의 return 값, 2개 이상이면 `void` + `o_<이름>` 포인터 |
| **내부** | 구조체 멤버만 (카운터 등) |
| **설정 (config)** | `X_Init`의 `c_<이름>` 파라미터. Init에서 한 번 `me-><이름>`에 저장되고, Guard·액션에서 이름으로 읽습니다. **고정 숫자(시간, 한계, 가격, 속도 …)는 전부 설정값으로 둡니다** — 예제도 그렇게 만들었습니다(예: 교차로 신호등 `redTicks`, `yellowTicks`, `greenMs`, `blinkTicks`, `alarmTicks`, `hurryAfterCycles`). 예시 main.c는 그림의 초깃값을 인자로 넘깁니다: `Led_Init(&itsLed, 50u /* blinkTicks */);` — 값을 바꿀 때는 main.c의 숫자만 고치면 되고, 같은 클래스를 다른 값으로 여러 개 쓸 수 있습니다 |

클래스 이름을 누르면 오른쪽 **클래스 카드**에서:
- **X_Main 인자**: 파라미터(기본) `uint8_t Led_Main(Led* const me, bool i_button)` 또는 구조체 `void Motor_Main(Motor* const me, const Motor_In* const in, Motor_Out* const out)`. 생성될 시그니처가 바로 보이고, 인자가 4개를 넘으면(ARM은 4개까지 레지스터) 구조체 방식을 권하는 경고가 나옵니다.
- **X_Main 본문**: 비우면 `X_takeTrigger(me);` 한 줄. 앞뒤에 내 코드를 넣을 수 있습니다(생성 코드의 `/*#[ operation Main() */` 영역).
- 오퍼레이션, 연관, 초기화 코드.

## 생성되는 파일 (ZIP에 들어가는 것)

| 파일 | 내용 |
|---|---|
| `<Class>.h` | 상태 enum, 구조체(입력·출력·변수·상태), `X_Init` / `X_Main` / `X_isIn` 선언 |
| `<Class>.c` | `X_Init` → `startBehavior`, `X_Main` → `takeTrigger` → `rootState_reactions` + `rootState_dispatch`, 복합 상태의 `_entDef / _exit` |
| `<Pkg>.h` | 클래스가 여러 개일 때 공유 타입/#include |
| `main.c` | 예시: `/* 10 ms task */ void Task_10ms(void)`, `X_Init` 한 번 + `X_Main` 매 호출. **✎ 직접 수정** 가능 |

동적 할당·재귀·함수 포인터·전역 상태가 없습니다(모든 상태는 인스턴스 구조체 안). 생성기는 이 파일들 말고는 아무것도 만들지 않습니다.

## Build

**Build**는 생성된 `.c`(모듈, main.c)를 MSVC `/W4`로 컴파일만 합니다(링크·실행 없음). 오류와 경고는 Problems 탭에, 경고 없이 성공하면 버튼에 ✓가 붙습니다.

## 예제 (New ▾)

| 단계 | 예제 | 배우는 것 |
|---|---|---|
| 초급 | LED 깜빡이 | 상태, 기본 전이, 카운터로 500 ms (`[cnt >= 50u]`), 출력 1개 = return |
| 초급 | 버튼으로 램프 | 입력 변수를 Guard로 (`[(button == true) && (forceOff == false)]`) |
| 초급 | 3색 신호등 | 상태 순환, 카운터 하나를 여러 상태에서 다시 쓰기 |
| 중급 | 자판기 | 값이 있는 입력 `[coin > 0]`, 조건 커넥터 + `[else]`, 내부 반응 |
| 중급 | 세탁기 | 복합 상태, 히스토리, 부모 상태의 내부 반응으로 세기, 구조체 인자 |
| 중급 | 버튼 디바운스 | 10 ms task 디바운스 패턴 (`[cnt >= 2u]` = 20 ms) |
| 고급 | 교차로 신호등 | AND 상태, 히스토리, 진입 때 정한 길이로 세기 (`greenCalls = greenTime / 10u`) |
| 고급 | 모터 제어 (모듈 2개 연결) | 출력 → 입력 연결, 구조체 인자 |
| 고급 | 모뎀 재연결 | 정션, 종료 커넥터, 응답 없음 타임아웃 |

## 자동 정리 (✨ 정리) · 코드 따라가기

**✨ 정리**는 흐름 순서대로 다시 배치합니다(Ctrl+Z로 되돌림). Code 패널이 열려 있으면 그림에서 상태나 전이를 누를 때 생성 코드의 해당 부분으로 이동하고 노랗게 표시합니다.

## 테스트

```bash
python editor/tests/test_codegen.py      # 9개 예제 생성 + /W4 빌드, define 없음, 설정값(X_Init 인자), 우선순위·반응 순서·옛 프로젝트 변환 (57 checks, C89 검사 포함)
python editor/tests/test_edge_cases.py   # 이름·입출력·옛 프로젝트 변환 엣지 케이스 45개
python editor/tests/qa_metrics.py        # /W4 /WX (x86·x64), /analyze, 코드 크기, RAM, 호출 시간
```

UI 테스트(`tests/ui_tests.js`)는 `static/_tests/`에 복사한 뒤 페이지에서 `await (await import('/_tests/ui_tests.js')).run()`.
QA 결과는 `tests/QA_REPORT.md`.

## 화면 보조 기능 (2026-10-18)

- **구조 경고**: 연결 안 된 연결자(C/H/⊗), 들어오는 전이 없는 H, 같은 guard 두 개 등은 캔버스에 ⚠로 표시되고 Problems에 클릭 가능한 목록이 생기며, Generate/Build 전에 확인창이 뜹니다.
- **연결자 모양**: 기본 전이 = 검은 점, **C** = 노란 마름모(조건), J = 청록 원, H = 파란 원, ⊗ = 빨간 원.
- **Tidy(정리)**: 층(BFS / 최장경로) x 줄바꿈 폭 x 뒤집기 조합을 레이아웃하고, 열 안에서 교차·긴 수직 이동·상태 관통을 줄이는 국소 탐색으로 순서를 다듬은 뒤 점수가 가장 좋은 것을 고릅니다. 사용자의 그림이 이미 더 좋으면 그대로 둡니다. 비교용: `node tests/layout_bench.js` (복잡한 무작위 차트 30개 평균 점수 2541 -> 1794, 교차 9.8 -> 7.3).

## Engine behind the scenarios (2026-10-20, 10-21)

There is no manual simulation screen (removed on request: scenarios cover it). Running a scenario builds the
*generated* `X.c` / `X.h` together with a separate harness (`codegen/sim_c.py` -> `sim_main.c`, never part of
the user's module) into `sim.exe` and runs it as a child process of the server (`sim.py`). Every call of the
10 ms task answers with the active states (`X_isIn`), the outputs as the caller got them and every other
variable. The shown moment's active states light up on the drawing (green = leaf, outlined = composite).
A hung user loop is killed after 10 s.
API: `/api/sim/start|step|reset|stop|scenario`.

**GitHub Pages build (2026-10-22)**: scenarios run there too, with no server. `static/py/sim_web.py` (Pyodide; source
`editor/sim_web.py`) answers the same `/api/sim/*` calls: the harness and generated C are built by the wasm clang +
`lld` (`static/vendor/clang/`, binji/wasm-clang, Apache-2.0) in `sim_worker.js` and run there as a WASI module.
A wasm run cannot wait for the next stdin line, so each command replays the commands since the last reset (earlier
`S` ones as the silent `T`) and keeps the last answer; timeout = the worker is killed after 10 s. First use downloads
Pyodide + clang + lld (~60 MB, then cached). Test it without the server: `python -m http.server 8771 --directory
editor/static` (launch config `statechart-static`) and run the scenarios of the 9 examples.

## Scenarios = unit tests as step tables (2026-10-20)

The **Scenario** tab holds step tables, stored in the project (`project.scenarios`). A step is one row:

| column | meaning |
|---|---|
| Calls | 10 ms task calls (0 = only check) |
| Set inputs | `button=1, coin=500` - changed before the calls; every input keeps its value until a later row changes it |
| Expect | after the calls: `output=value` (also `!= >= <= > <`); `Class.name` with several classes. **Outputs only** |

**Run** resets the simulation (X_Init) and plays the rows against the real generated C: PASS / FAIL per row
(failures say what was found), click a row to see that moment on the drawing. **Run all** plays every scenario.
Logic: `scenario.py` (server, `/api/sim/scenario`), UI: `static/scenario.js`.
All 9 examples ship with scenarios (`examples_src/scenarios.py`, written into the example JSON by
`build_examples.py`): 141 steps, all PASS. `python tests/test_sim.py` runs them and also checks that wrong
expectations FAIL. Timing reminder: reactions (`cnt++`) run first, then one transition, so a state entered with
`cnt = 0` and guard `[cnt >= N]` is left on the N-th call after it.

### Init rows, unlocking, examples (2026-10-21)

* **Init column**: a ticked row calls `X_Init` again before its calls (inputs and variables back to their
  initial values). Only on such a row can `Set` give **config values** (X_Init parameters, e.g. `blinkTicks=5`);
  elsewhere that is an error. Every scenario run starts with an implicit `X_Init` using the drawing's config values.
* **Run** plays the selected scenario, **Run all** every scenario one after the other (each starts with X_Init, so they are independent).
* The **Scenario tab is locked** until Generate C + Build succeeded for the drawing as it is now; any edit locks it again.
* Opening an **example** (New menu / first start) generates and builds it at once (local server only), so the
  buttons are green and the Scenario tab is unlocked.

### Scenario cells are GUI (2026-10-21)

*Set inputs* and *Expect* are chips, not text: `＋` opens a menu of the project's own variables / states
(inputs, and config values on an Init row; states, outputs, variables). Bool = a true/false toggle, numbers = a
number field (Expect also has `= != >= <= > <`), a state chip toggles "active" / "not active". The step still
stores the plain text scenario.py reads (`static/scchips.js` parses it into chips and writes it back); an entry
that no longer resolves stays as a red chip and is never lost.

### Black-box rule (2026-10-21)

A scenario drives the chart with **inputs only** (plus config values on an Init row) and checks **outputs only**.
States and internal variables (`cnt`, counters, `credit` ...) can neither be set nor checked: the drawing already
shows the active states while a scenario runs (click / step a row). The checker rejects them ("is not an output" /
"write output=value"), the GUI menus do not offer them. Outputs are what the caller got from `X_Main`, so right
after `X_Init` (0 calls) they still have their initial values - check an output after at least one call.
The examples' scenarios check outputs only (timing is verified with the call counts: `49 calls: still X`,
`1 call: now Y`); the modem example got two outputs (`dialing`, `gaveUp`) so its retry / give-up behaviour is visible.

### Run (you step) / Run all, no notes (2026-10-21)

* **Run** executes the *selected* scenario **one row per press** - nothing advances by itself. The first press runs row 1
  (after `X_Init`), every further press the next row: the row is marked, its PASS / FAIL appears and the drawing shows
  the states of that moment. The next row is outlined, the button shows the position (`Run 3 / 6`), `⟲` starts the
  scenario over, and a press after the last row starts over too. (The server plays the whole table once; the editor
  shows it row by row.)
* **Run all** plays every scenario at once, one after the other (each starts with X_Init, so they do not affect each
  other); the table on screen follows the scenario that is playing and ends on the first one that failed.
* The Note column is gone (UI, project data, examples): a step is Init / Calls / Set inputs / Expect.

### SQA pass of the scenario tab (2026-10-21)

Found by using it from a blank project (drawing with the mouse, Build, writing a scenario) and fixed:

* **Wrong / confusing**: the code pane kept the *previous* project's code after New; a build of the previous drawing
  that finished late overwrote the screen of the project opened meanwhile (and the new project's auto build was
  skipped); an edit of a variable name silently broke the scenarios; a Set value C would cut off (`uint8_t` 300, `bool` 5)
  was accepted; Calls could be negative or above the 100000 limit; pressing Run threw the table scroll back to the top;
  a row that has not run yet could be clicked and showed its future result; undo jumped to scenario 1; the state card
  example text said `me->count++` while everything else says plain names.
* **Design**: the tab shows its state (`🔒 Scenario` locked, a pulsing dot when unlocked and still empty, `✓` / `✗ n`
  after a full run); one compact toolbar (scenario ▾ · ✎ rename · ⧉ duplicate · ＋ New · ✕ delete · Run · Run all);
  fixed column widths (adding chips no longer moves the `＋` buttons); `Calls` shows its time (`49` = `490 ms`);
  row tools appear on hover; a `＋ Add step` row at the end; failure text like `lamp: got false, expected true`;
  empty menus say why (`There is no Output variable yet — add one under Variables ▸ Output`); the test build is prepared in
  the background when the tab opens (first Run answers at once); opening the tab fits the drawing into the space left;
  the properties card closes on Run so the lit-up states are visible.
* Renaming a variable or class in the drawing renames it in the scenarios too (applied when the name field is left).
