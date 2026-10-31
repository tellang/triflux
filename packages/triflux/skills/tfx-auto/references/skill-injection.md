# 스킬 주입과 agy 완료 주장 방지

## 스킬 주입 (`--skill <name>`)

codex/agy 워커 프롬프트 앞에 등록된 스킬의 방법론을 주입하는 **opt-in** 프레임워크. 동작:

- **메커니즘**: `--skill <name>` → tfx-route.sh `TFX_INJECT_SKILL=<name>`. `skills/<name>/SKILL.md` 본문을 `--- SKILL: <name> (apply this methodology...) ---` delimited block 으로 프롬프트 앞에 prepend. codex·agy 레인 공통 (CLI-agnostic, `prepend_skill`).
- **기본 off**: 미지정이면 no-op → 현행 동작 그대로. 회귀 위험 없음.
- **파싱 안전**: prepend 는 `printf`/`cat` → temp file 만 사용. codex 는 argv `--` 뒤, agy 는 `--print <프롬프트>` 인자로 전달되므로 `$`(codex)·`₩`/백슬래시(agy) 같은 특수문자를 셸 재확장 없이 **리터럴 보존**. 스킬 본문을 그대로 넘겨도 깨지지 않음.
- **네이티브 스킬을 안 쓰는 이유**: codex `$skill-name`/`/name` 슬래시와 agy `/name` 은 둘 다 **인터랙티브 TUI 전용** → headless one-shot 에서 named-skill 강제 호출 불가 (미문서). 그래서 prose 주입을 채택 (레퍼런스 omc 도 role .md 를 raw prepend, 네이티브 회피).

## 커맨드→스킬 매핑 (tfx-auto convention, opt-in)

tfx-auto 가 커맨드/agent 별로 주입할 스킬을 고를 때 쓰는 **권고 테이블**. 기본은 매핑 없음 (명시 `--skill` 만 작동): 부적절한 스킬이 모든 프롬프트에 새는 것을 막는다. 프로젝트가 명시적으로 활성화할 때만 아래를 적용해 `--skill` 을 자동 부여한다.

| 커맨드/agent | 권고 스킬 | 비고 |
|--------------|-----------|------|
| (기본) | 없음 | explicit `--skill` 우선 |
| 프로젝트 정의 | 프로젝트가 지정 | 활성화 시 tfx-auto 가 해당 `--skill` set |

> 매핑된 스킬 파일이 없으면 `prepend_skill` 이 warning 후 주입을 생략한다 (fail-open). 존재하지 않는 매핑을 "주입됨"으로 가정하지 않는다.

## agy anti-overclaim (자동, agy 레인 전용)

agy 레인은 `TFX_AGY_ANTI_OVERCLAIM`(기본 on) 으로 완료/grounding 규율 블록을 프롬프트 **END** 에 자동 append (`append_agy_anti_overclaim`). 근거 없는 완료 주장을 줄이기 위한 설정이다:

- fresh 증거 없이 done/fixed/passing 주장 금지.
- 검증 불가 시 `No Info / 확인 불가` 후 중단 (날조 금지).
- 추론은 주어진 context 로, confident guessing 보다 accurate abstention 우선.

해당 지시 블록은 프롬프트 끝에 배치한다. opt-out: `TFX_AGY_ANTI_OVERCLAIM=0`.
