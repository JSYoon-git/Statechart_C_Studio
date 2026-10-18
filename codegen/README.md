# sc2c — 상태차트 → C 코드 생성기

Rhapsody 모델(`.rpyx` + `*_rpy/*.sbsx`)이나 직접 작성한 JSON 상태차트를 읽어서 컴파일 가능한 C 코드를 만듭니다.

```
python sc2c.py <프로젝트 폴더 | .rpyx | statechart.json> -o <출력 폴더> [--class A,B] [--with-statechart-only]
```

출력물:

| 파일 | 내용 |
|---|---|
| `<패키지>_events.h/.c` | 이벤트 ID, 파라미터 구조체, 생성 함수 `evX(args)`, Rhapsody 호환 매크로(`RiCGEN`, `CGEN`, `GEN`, `RiCBoolean`) |
| `<클래스>.h/.c` | 클래스 구조체(속성, 연관 포인터, 상태 저장소), `X_Init`, `X_startBehavior`, `X_<state>_IN`, getter/setter, 오퍼레이션, 상태 테이블과 전이 함수 |
| `sc_rt.h/.c` | 런타임: 계층 진입/탈출, AND 영역, 히스토리, 타이머, 이벤트 큐 (약 250줄, 동적 할당 없음) |

빌드: `cc -I out out/*.c main.c` (MSVC는 `build_msvc.bat out main.c out.exe`)

### `--style rhapsody` (Rhapsody C 모양)

```
python sc2c.py examples/microwave.json -o gen/microwave_rhp --style rhapsody
build_rhp.bat gen\microwave_rhp gen\microwave_rhp\sim.exe
```

`rhp_c.py`가 Rhapsody C 코드 생성기와 같은 구조(`RiCReactive ric_reactive`, `X_Init/X_startBehavior`,
하나의 `rootState_dispatchEvent`(nested switch)와 복합 상태별 `_entDef/_exit`, `RiC_Create_evX`, `RiCSETPARAMS`, `RiCTask_schedTm`)로 전이를 if/switch 코드로 펼쳐 냅니다.
실행 프레임워크는 `ricl/RiCLite.h/.c`(정적 풀, malloc·재귀 없음)이고, `sim_main.c`(PC 시뮬레이터)와 `main.c`(MCU 메인 예제)도 같이 생성됩니다.
그림을 그려서 이 코드를 만드는 웹 편집기는 `../editor/README.md` 참고.

## 지원 범위

- 중첩(OR) 상태, AND 상태와 영역, 진입/탈출 액션
- 기본 전이(액션 포함, 조건 커넥터 경유 가능)
- 이벤트 트리거와 이벤트 파라미터(`params->x`), 가드, 액션
- 타임아웃 `tm(ms)` — 상태를 나가거나 다시 들어오면 이미 큐에 들어간 타임아웃은 무시
- 트리거 없는 전이(완료 시 자동 실행, 무한 루프 방지 상한 100)
- 조건 커넥터·정션(`else` 포함), 다이어그램 커넥터 짝, 얕은 히스토리(H), 종료 커넥터
- static reaction(내부 전이: 탈출/진입 없음)
- 액션/가드 안의 `IS_IN(state)`, `RiCGEN(obj, evX(...))`, `GEN(evX())`

미지원(경고 출력): 별도 다이어그램으로 분리된 서브 상태차트, 상속받은 상태차트, fork/join, 깊은 히스토리, 포트(`OUT_PORT`), 액티비티 다이어그램. 다중성 `*` 연관은 포인터 하나로만 생성됩니다.

## 실행 의미론

- 이벤트는 전역 큐에 들어가고 `SC_run()`이 하나씩 끝까지 처리합니다(run-to-completion).
- 안쪽 상태가 먼저 이벤트를 받고, 처리하지 못하면 부모로 올라갑니다. AND 상태는 모든 영역에 이벤트를 전달합니다.
- 외부 전이: 소스와 타깃의 공통 조상(LCA)까지 탈출 → 액션 → LCA부터 타깃까지 진입 → 타깃의 기본 전이.
- 시간은 `SC_tick(ms)`로 진행합니다. 실제 장비에서는 타이머 인터럽트나 주기 태스크에서 호출하면 됩니다.
- `SC_trace = SC_printTrace;`로 진입/탈출/이벤트 로그를 볼 수 있습니다.

## JSON 형식 (Rhapsody 없이 쓸 때)

`examples/microwave.json` 참고. 상태 이름은 차트 안에서 유일해야 합니다.

```json
{
  "package": "Microwave",
  "events": { "evStart": [{"type": "int", "name": "seconds"}], "evStop": [] },
  "classes": [{
    "name": "Oven",
    "attributes": [{"type": "int", "name": "remaining", "default": "0"}],
    "operations": [{"name": "show", "ret": "void", "args": [], "body": "..."}],
    "statechart": {
      "initial": "idle",
      "states": {
        "idle": {"entry": "..."},
        "working": {"regions": [ {"name": "heat", "initial": "heating", "history": true, "states": {...}} ]}
      },
      "transitions": [
        {"from": "idle", "to": "working", "trigger": "evStart", "guard": "params->seconds > 0", "action": "..."},
        {"from": "a", "to": "b", "after": "500"},
        {"from": "x", "to": "heat.H", "trigger": "evGo"},
        {"from": "heating", "trigger": "evTick", "choice": [{"guard": "...", "to": "heating"}, {"guard": "else", "to": "done"}]},
        {"from": "working", "trigger": "evTick", "action": "..."}
      ]
    }
  }]
}
```

`"to"`가 없는 전이는 static reaction, `"after"`는 타임아웃, `"choice"`는 조건 커넥터, `"상태.H"`는 히스토리 커넥터입니다.

## 검증한 것

- `examples/microwave.json` + `microwave_main.c`: AND 영역, 조건 커넥터, 히스토리, 타임아웃, static reaction, `IS_IN`, 이벤트 파라미터
- Rhapsody C 샘플 `Dishwasher`(4개 클래스) + `dishwasher_main.c`: 객체 간 `RiCGEN`으로 한 사이클(급수→헹굼→세척→배수→건조) 완주, 문 열고 닫기 후 히스토리 복귀
- Rhapsody C/C++ 샘플 63개 프로젝트 전체에 대해 생성 단계 예외 없음(컴파일은 위 두 개만 확인)
