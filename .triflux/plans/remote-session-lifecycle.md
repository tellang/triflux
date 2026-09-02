# 원격 세션 수명주기 자동화 (m2 오프로드)

## 목적

`tfx-remote spawn` 경로에 자동 attach, 화면 상태 판별, stall 감지, 양측 자동
teardown을 넣는다. 2026-09-02 m2 실측에서 드러난 감지 갭 4개를 닫는다.

## 실측 근거 (2026-09-02, m5에서 m2로 claude 왕복)

- claude 2.1.239는 REPL이 아니라 세션 매니저 홈 화면으로 부팅한다.
  `scripts/remote-spawn.mjs`의 `waitForClaudeReady` ready 패턴(`❯` 등)이 홈
  화면에도 매칭되어 준비 상태를 오판한다
- 홈 화면에서 프롬프트 제출은 즉답이 아니라 백그라운드 세션을 만들고, 그
  세션이 "Needs input"으로 무기한 대기해도 아무도 감지하지 못한다
- 로컬 tmux 세션 kill은 ssh HUP으로 원격 TUI만 죽인다. transient daemon과
  bg-pty-host는 90초 이상 잔존을 확인했고, `claude daemon stop --any`가 백그라운드
  세션까지 포함한 공식 정리 명령이다(실측: "terminated 2 background sessions",
  이후 pgrep 0)
- 비로그인 ssh에는 nvm PATH가 없어 `env node` 셔뱅이 실패, spawn이 즉사한다.
  hosts.json `capabilities_v2.claude` 경로 기반 PATH prefix가 필요하다

## 구현 항목

### T1. 화면 상태 판별기

- `classifyClaudeScreen(captureText)` 신설: `home | repl | trust_prompt |
  needs_input | busy | unknown` 반환
- 판별 신호: 홈 화면 "describe a task for a new session", trust "Is this a
  project you created", busy "esc to interrupt", needs-input "Needs input"
- `waitForClaudeReady`를 이 판별기 기반으로 교체. `repl` 또는 `home`을
  구분해 반환하고, 호출자가 목표 상태를 지정할 수 있게 한다

### T2. spawn 안정화

- 원격 명령에 hosts.json `capabilities_v2` 경로의 디렉터리를 PATH prefix로
  주입한다(darwin/linux). 하드코딩 금지, hosts-compat 해석 결과 사용
- trust 화면 감지 시 기본은 보고 후 대기. `--auto-trust` opt-in일 때만
  Enter 자동 응대

### T3. stall·문제 감지

- 상태 전이 없이 임계 시간 지속 시 stall 보고(기본 20분, machine profile
  `TFX_STALL_THRESHOLD` 존중, visible 프로파일이면 classify-only)
- `needs_input`/`trust_prompt` 감지 시 즉시 사용자 보고 이벤트
- 감지는 로컬 tmux `capture-pane` 폴링으로 수행. 원격 프로세스 조회는
  teardown 검증에서만 사용

### T4. teardown (검증된 레시피)

- `tfx-remote kill <session>` 절차를 확장:
  1. 로컬 세션은 `killPsmuxSession()` 5단계 경유(attach pane 자동 닫힘)
  2. 원격에 `claude daemon stop --any` 실행(해당 호스트 한정)
  3. readback: 원격 `pgrep -f claude` 카운트로 회수 확인, 실패면 ok:false
     명시 반환(false-positive 성공 금지, tfx-cto-hub-boundary 정신)
- 원격 정리 실패가 로컬 정리를 막지 않는다. 결과에 양측 상태를 분리 보고

### T5. 자동 attach 기본값

- spawn 성공 후: 리드가 tmux 안이면 `tmux split-window` + `env -u TMUX`로
  현재 창에 attach(2026-09-02 실증 경로), 아니면 기존 `openAttachTab` 유지
- opt-out: `--no-attach`

### T6. darwin/linux tmux spawn 레인 (구현 1차에서 확인된 게이트 갭)

- 현상: `shouldUsePsmux()`가 `IS_WINDOWS_LOCAL && hasPsmux()`라서 macOS spawn
  진입점은 세션 없는 fallback으로 빠지고, T2 PATH 주입과 T5 자동 attach가
  spawn 경로에서 도달 불가
- 수정: 로컬이 darwin/linux이고 tmux가 있으면 detached tmux 세션
  `tfx-spawn-<host>-<slug>`를 만들고 그 pane에서
  `buildRemotePosixSpawnCommands()` 결과(PATH prefix + `ssh -t`)를 실행한다.
  이후 `waitForClaudeScreenState`(목표 home|repl), `attachSpawnedSession`,
  `--monitor`/`--kill` 표면이 세션명 기준으로 그대로 동작한다
- Windows psmux 레인은 불변. pwsh 인용 빌더를 posix 레인에서 쓰지 않는다
- 테스트: 레인 선택(darwin+tmux, windows 불변)과 posix 명령 조립(mock) 추가

## 후속 관찰

- hosts-compat `normalizeHost()`가 `capabilities_v2` 값을 Boolean으로 강제해
  경로 문자열을 잃는다. 현재는 `raw.capabilities_v2`를 읽어 우회. 정규화가
  경로를 보존하도록 별도 슬라이스에서 수정 검토
- 전체 스위트 부하 시 간헐 실패하는 기존 flake 2건(전부 단독 통과, 이 작업과
  무관): `tests/unit/session-end-cleanup.test.mjs`(hooks/session-end-cleanup.mjs:126
  `ps` 자식 timeout 400ms가 부하에서 ETIMEDOUT, null 반환),
  `tests/unit/swarm-locks.test.mjs:91`(lease TTL 연장 타이밍). 각각 별도 슬라이스
  후보. 2026-09-02 실측 기록

## 비범위

- codex/agy 원격 레인(m2에 codex 미설치, claude 왕복만 대상)
- 원격 daemon 상주 등록(native-bridge 원격 PRD 별도)
- swarm shard 수명주기(swarm-hypervisor 소관)

## 수용 기준

- 홈 화면/REPL/trust/needs-input을 판별기가 구분한다(캡처 픽스처 단위 테스트)
- needs_input 상태가 임계 없이 즉시 보고된다
- kill 후 로컬 세션 부재 + 원격 pgrep 0이 readback으로 확인된다
- PATH 미주입 셔뱅 실패 케이스가 재발하지 않는다(스폰 명령 조립 테스트)
- `npm test` 전체 통과, 변경 파일 lint clean(변경분 한정)

## 미러

- `scripts/remote-spawn.mjs`가 npm files 포함 여부를 확인하고 포함 시
  packages/triflux 동일 반영. hub/team 변경 시 triflux+remote 미러 규칙 적용
