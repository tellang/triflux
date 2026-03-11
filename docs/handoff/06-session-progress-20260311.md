# Session Progress Handoff (2026-03-11)

## 목적

이 문서는 2026-03-11 세션에서 실제로 확정된 요구사항, 운영 원칙, 수행 작업, 현재 런타임 상태, 생성 산출물, 남은 작업, 자주 쓰는 명령을 다음 작업자가 한 번에 이어받을 수 있게 정리한 handoff다.

## 이번 세션의 요구사항

- Claude `/tfx-team` 운영 문제를 기준으로 원인과 복구 경로를 정리한다.
- Hub off 상황에서 왜 워커 UI와 Shift 네비게이션이 사라지는지 명확히 설명 가능한 상태를 만든다.
- 세션 시작 시 Hub 점검/복구는 포그라운드가 아니라 백그라운드 비동기로 동작해야 한다.
- npm `dev` 배포와 전역 설치 경로가 실제로 어떻게 연결되는지 확인한다.
- `tfx update`의 dev 채널 UX를 잘못된 문구 없이 다시 정리한다.
- 변경은 `dev` 브랜치에서 단계별 커밋으로 남긴다.

## 확정된 운영 원칙

### 범위 관리

- 이번 턴의 직접 범위는 Claude `/tfx-team` 관련 전체다.
- `codex-team` 런타임은 같은 저장소에 있어도 이번 요구사항의 직접 범위와 섞지 않는다.
- 요구사항을 다시 묻기 전에 기존 로컬 PRD, handoff 문서, 공식 Claude Code 문서를 먼저 source of truth로 대조한다.

### UX / 운영

- `/tfx-team` preflight 확인은 기본적으로 비동기/요약 출력이 맞다.
- Hub off 시 직접 Bash 병렬 실행 폴백으로 내려가면 Native Team 워커 UI와 Shift 네비게이션은 생기지 않는다.
- Hub 생존 판정은 `/health`만 믿지 말고 `/status` 기준 probe를 우선한다.
- `postinstall` 단계에서는 Hub를 자동으로 띄우지 않아야 한다.

### 배포 / 설치

- 이 프로젝트의 dev 배포 방식은 `npm dist-tag dev`다.
- 전역 업데이트의 기준 UX는 `tfx update --dev` 또는 `tfx update dev`다.
- PowerShell에서는 `@dev`가 셸 단계에서 의도와 다르게 해석될 수 있어 문서 기준 명령으로 쓰지 않는다.
- npm publish는 git commit이 아니라 현재 워크트리 기준으로 패키징하므로, `files`에 포함된 미커밋 런타임 파일은 실제 배포물에 들어갈 수 있다.

## 실제 수행 작업

### 1. Claude `/tfx-team` 문제 분석

- 워커 호출 실패 여부와 워커 UI 부재를 분리해서 봤다.
- 직접 원인은 `Hub off -> 직접 Bash 병렬 실행 폴백` 경로라는 점을 정리했다.
- Shift 네비게이션 이슈와 워커 UI 부재가 같은 문제가 아니라는 점을 명확히 했다.
- 기존 27888 Hub에서 `/status`는 200인데 `/health`는 404인 상태를 확인했다.

### 2. Hub 복구/상태 경로 보강

아래 변경이 런타임 코드에 반영됐다.

- SessionStart에서 Hub ensure를 포그라운드와 분리해 비동기로 처리하도록 보강
- `postinstall` 상황에서 Hub 자동 기동 방지
- `hub/server.mjs`에 `/health`, `/healthz` 추가
- Hub probe 및 PID 상태 판정 강화
- Shift 이전 이동용 대체 키 경로 유지
- `skills/tfx-team/SKILL.md`의 preflight 정책 보강

관련 파일:

- `scripts/setup.mjs`
- `scripts/hub-ensure.mjs`
- `hub/server.mjs`
- `hub/team/cli.mjs`
- `hub/team/session.mjs`
- `skills/tfx-team/SKILL.md`

### 3. npm dev 배포 / 전역 설치 구조 확인

검증 결과:

- `npm run dev` 스크립트는 없다.
- 실제 dev 배포는 `triflux@dev` dist-tag 방식이다.
- 전역 shim `tfx`, `tfl`, `triflux`는 `%APPDATA%\npm\node_modules\triflux\bin\triflux.mjs`를 가리킨다.
- 기존 전역 설치본은 한때 `3.2.0-dev.6`이었고, 현재는 `3.2.0-dev.8`까지 갱신됐다.
- `.6` 비교 결과, `files`에 포함된 런타임 코드 기준으로는 당시 미커밋 변경이 실제 배포물에 포함됐었다.

### 4. dev 업데이트 UX / Windows 전역 업데이트 보강

문제:

- 기존 구현은 `--dev`만 인식하고 `dev`, `@dev`는 인식하지 못했다.
- Windows에서 Hub가 떠 있으면 `better-sqlite3.node` 파일 잠금 때문에 전역 업데이트가 불안정했다.
- `scripts/setup.mjs`의 일부 sync 로직은 버전 문자열이 없는 파일을 놓칠 수 있었다.

적용:

- `bin/triflux.mjs`에 dev 채널 인자 파싱 보강: `--dev`, `dev`, `@dev`
- 전역 업데이트 전 Hub 정지, 업데이트 후 setup 재실행, Hub 재기동 순서 추가
- `import.meta.url` 경로 해석을 `fileURLToPath` 기반으로 정리
- setup sync를 버전 문자열 비교가 아니라 실제 텍스트 diff 기준으로 보강
- README 안내 문구를 stable/dev 채널 기준으로 재정리

## 커밋 이력

이번 세션에서 남긴 단계별 커밋:

1. `2033238` `Fix dev update flow and harden team setup`
2. `8ed4315` `Fix global dev update flow on Windows`

최근 로그:

- `8ed4315` `Fix global dev update flow on Windows`
- `2033238` `Fix dev update flow and harden team setup`
- `0366903` `Feat: tfx-team v2.2 Phase 2 — 모니터링 통합 + HUD 팀 상태 라인`
- `8923736` `Feat: tfx-team v2.2 — 슬림 래퍼로 Shift+Down 네비게이션 복원`

## 배포 및 전역 설치 상태

### 최종 배포 상태

- npm 패키지 버전: `3.2.0-dev.8`
- `dev` dist-tag: `3.2.0-dev.8`
- npm registry `gitHead`: `8ed43151c9d033ab33749b4cf997636f47515571`
- 현재 로컬 `package.json` 버전: `3.2.0-dev.8`

### 전역 설치 상태

- `tfx --version` => `v3.2.0-dev.8`
- `npm ls -g triflux --depth=0` => `triflux@3.2.0-dev.8`
- 실행 shim: `%APPDATA%\npm\tfx.cmd`, `%APPDATA%\npm\tfl.cmd`, `%APPDATA%\npm\triflux.cmd`

### 해석

- 현재 전역 설치본은 로컬 최신 dev publish 결과와 맞다.
- 이번 세션에서 수정한 dev update 경로를 이용해 전역 설치도 갱신 검증이 끝났다.

## 현재 상태

### 코드 / 배포

- 핵심 코드 변경은 커밋 및 publish 완료 상태다.
- 최종 dev 배포본은 `3.2.0-dev.8`이다.
- 전역 설치도 `3.2.0-dev.8`로 맞춰져 있다.

### 문서 / 산출물

- `docs/handoff/05-triflux-v2.2-session-handoff.md`는 Claude `/tfx-team` 중심 초기 handoff다.
- 이 문서는 그 이후 npm dev 배포/전역 설치 작업까지 포함한 세션 전체 handoff다.

### 워크트리

현재 `git status --short` 기준 untracked 문서:

- `docs/handoff/01-teammate-spawn-deepdive.md`
- `docs/handoff/02-teammate-lifecycle-state.md`
- `docs/handoff/03-alternative-registration-paths.md`
- `docs/handoff/05-triflux-v2.2-session-handoff.md`

주의:

- 위 문서들은 아직 커밋되지 않았다.
- 코드 변경은 커밋됐지만, handoff 문서류는 별도 정리 여부를 판단해야 한다.

## 생성 산출물

### handoff / 문서

- `docs/handoff/05-triflux-v2.2-session-handoff.md`
- `docs/handoff/06-session-progress-20260311.md`

### 조사 문서

- `docs/handoff/01-teammate-spawn-deepdive.md`
- `docs/handoff/02-teammate-lifecycle-state.md`
- `docs/handoff/03-alternative-registration-paths.md`
- `docs/handoff/04-re-findings-summary.md`

### Gemini artifact

- `.omx/artifacts/gemini-session-insights-20260311T131427Z.md`
- `.omx/artifacts/gemini-session-insights-raw-20260311T131238Z.md`
- `.omx/artifacts/gemini-session-insights-rewrite-raw-20260311T131427Z.md`

## 남은 작업

### Claude `/tfx-team` 쪽

- 로컬 PRD와 공식 Claude Code 문서 5종을 대조한 요구사항 매트릭스 작성
- `teamKill()` fallback, 포트 하드코딩 잔존 이슈를 Claude 범위에서 바로 처리할지 분리할지 결정
- Hub가 왜 죽는지 재현 가능한 근본 원인 정리
- Shift+위 방향키 문제를 Claude 내부 문제와 triflux 우회 가능성으로 분리해 검증

### 문서 / 프로세스 쪽

- untracked handoff 문서를 커밋할지 별도 보관할지 결정
- `05`와 `06` handoff의 역할을 정리해 중복을 줄일지 판단
- 향후 publish 전에 `npm pack --dry-run` 또는 동등 검증 절차를 운영 원칙으로 고정할지 결정

## 자주 쓰는 명령

### 버전 / 설치 확인

```powershell
tfx --version
npm ls -g triflux --depth=0
npm view triflux@dev version gitHead --json
```

### dev 채널 업데이트

```powershell
tfx update --dev
tfx update dev
```

### 로컬에서 update 경로 검증

```powershell
node bin/triflux.mjs update dev
```

### Hub / 팀 상태 확인

```powershell
tfx hub status
tfx team status
curl -sf http://127.0.0.1:27888/status
curl -sf http://127.0.0.1:27888/health
```

### 기본 검증

```powershell
node --check bin/triflux.mjs
node --check scripts/setup.mjs
node --check scripts/hub-ensure.mjs
npm run test:route-smoke
git status --short
```

## 후속 작업자 메모

- 현재 런타임 기준으로는 `dev.8`까지 정리됐다.
- 다음 작업은 코드보다 요구사항 매트릭스와 Claude `/tfx-team` 범위 재고정이 먼저다.
- publish와 전역 설치는 정리됐지만, 문서와 운영 기준은 아직 후속 정리가 필요하다.
