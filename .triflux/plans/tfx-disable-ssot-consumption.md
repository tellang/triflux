# TFX_DISABLE_* SSOT 소비 확장

## 목적

machine profile의 `TFX_DISABLE_CODEX` / `TFX_DISABLE_ANTIGRAVITY`를 CLI 사용 여부의
단일 정본으로 승격한다. 지금은 `scripts/tfx-route.sh`와 `scripts/setup.mjs`만 이 값을
읽는다. HUD, hub 실행 경로, 세션 라우팅 문맥이 전부 같은 값을 읽게 만든다.

## 현황과 결함

- machine profile 읽기 로직이 두 벌: `scripts/setup.mjs:74-115`(JS 인라인),
  `scripts/tfx-route.sh:42-105`(bash 재구현). 공용 JS 모듈 없음
- HUD(`hud/hud-qos-status.mjs:264-301`)는 codex·antigravity 행을 무조건 그린다.
  disable 여부를 읽는 게이트가 없다
- route 우회 spawn 2곳이 disable을 무시한다:
  - `hub/team/conductor.mjs:609-631,681-689`가 `hub/team/execution-mode.mjs:97-125`의
    spawn spec으로 codex/agy 바이너리 직접 실행
  - `hub/team/conductor.mjs:1241-1248`이 `hub/team/launcher-template.mjs:24-53`의
    하드코딩 런처 사용. swarm-hypervisor가 이 경로에 도달한다
- `scripts/preflight-cache.mjs`는 순수 관측(바이너리·크레덴셜 probe)이며 disable을
  모른다. 이 분리는 의도된 설계다(`tfx-route.sh:1653-1655` 주석)

## 결정

- SSOT: 기존 `TFX_DISABLE_*` 승격. 새 환경변수 신설 없음
- 우선순위 유지: 런타임 env > machine profile > 기본값 0
- HUD 표시: disabled CLI는 완전 숨김
- preflight: 관측 전용 유지. 정책 적용은 소비 지점에서만
- 새 ADR 없음. 기존 machine profile 정책의 집행 확장이다

## 설계

### 1. 공용 리더 `scripts/lib/machine-profile.mjs`

- dep-free(node:fs, node:os, node:path만). `hub/lib/cto-env.mjs` 스타일
- `setup.mjs`의 `resolveMachineProfilePath` / `parseMachineProfileContent` 이관,
  setup.mjs는 re-export로 기존 테스트 표면 유지
- 신규 export `resolveCliPolicy(env = process.env)`:
  `{ codexDisabled, antigravityDisabled, source }` 반환. env 명시값이 있으면 그것,
  없으면 profile 파일, 둘 다 없으면 0
- `scripts/lib/`에 두는 근거: `scanLibFiles()`가 디렉터리 전체를
  `~/.claude/scripts/lib/`로 자동 동기화하므로 설치본 HUD(`~/.claude/hud/`)에서
  `../scripts/lib/` 상대 import가 repo와 동일하게 성립

### 2. HUD 게이트

- `hud/hud-qos-status.mjs` rows 조립부에서 `resolveCliPolicy()` 판독
- codex disabled: codex 행 생략
- antigravity disabled: `antigravityReady`를 강제 false로 두어 기존 슬롯 로직대로
  gemini 폴백. gemini도 정보가 없으면 행 생략

### 3. spawn 게이트

- `hub/team/execution-mode.mjs`의 `buildSpawnSpecForMode`: cli가 codex/antigravity이고
  disabled면 spec 생성 대신 명시 오류 throw
- `hub/team/launcher-template.mjs`의 `buildLauncher`: 동일 게이트
- 조용한 강등 금지. 오류 메시지에 `TFX_DISABLE_X=1` 원인과 해제 방법 명시
  (tfx-route.sh exit 78 정책과 동일 정신)

### 4. 세션 라우팅 문맥 주입

- `hooks/session-start-fast.mjs`가 additionalContext에 한 줄 주입:
  `cli-policy: codex=on antigravity=off (SSOT: machine profile)`
- Claude의 스킬 선택 판단이 disable 상태를 세션 시작부터 인지

## 비범위

- `tfx-route.sh` bash 판독 로직 변경 없음(이미 정상 동작)
- preflight-cache에 disable 반영 없음
- `TFX_TIMEOUT_*` 등 machine profile의 다른 키 소비 확장 없음
- 원격 데몬·swarm 원격 shard의 disable 전파는 후속

## 미러

- `scripts/lib/machine-profile.mjs`: packages/core, packages/triflux,
  packages/remote 3계층(remote는 root subset 규칙 적용)
- `hud/*` 변경: packages/triflux + packages/core
- `hub/team/*` 변경: packages/triflux + packages/remote(import 변환은 Edit만)
- `hooks/*` 변경: packages/triflux + packages/core

## 테스트

- 리더 단위 테스트: env 우선, profile 폴백, 기본값, allowlist 위반 스킵
- 기존 `tests/unit/setup-machine-profile.test.mjs` 통과 유지(re-export 검증)
- HUD 게이트: disabled 시 행 부재, enabled 시 기존 렌더 유지
- spawn 게이트: disabled cli 요청 시 throw, 오류 메시지에 원인 포함

## 완료 기준

- `TFX_DISABLE_ANTIGRAVITY=1`만으로 HUD에서 antigravity 사라짐,
  conductor 직접 spawn 경로가 오류로 차단됨, 세션 시작 문맥에 off 표기
- `npm test` 전체 통과, 미러 검증 `diff -q` 통과
