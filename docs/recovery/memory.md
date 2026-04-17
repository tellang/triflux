# Memory/Checkpoints Recovery Report

## 스캔 메모
- `C:/Users/tellang/.claude/projects/C--Users-tellang-Desktop-Projects-triflux/memory/`의 `MEMORY.md`, `feedback_*.md`, `user_*.md`, `project_*.md`, `reference_*.md`를 전수 확인했다.
- `~/.gstack/projects/triflux/`에서는 `checkpoints/`, `routing-weights.json`, `tellang-main-design-20260412-143422.md`를 확인했다.
- `.claude/settings.local.json`에는 TODO/FIXME가 없었다.
- 최근 실패 세션 후보 중 `timeout-and-parsing`은 이후 커밋(`315e294`, `8a6d31e`, `540286f`, `eb473ae`, `f99bdbd`)로 후속 수정 흔적이 확인되어 **현재 미해결 항목**에서는 제외했다.
- 디자인 스냅샷의 release-governance open question 3개는 현재 `.github/workflows/release.yml`, `docs/process/release-policy.md`, `scripts/release/publish.mjs`에 문서화/구현 흔적이 있어 live omission으로 승격하지 않았다.

## 발견 항목

### [M1] feedback_codex_mcp_tool_approval_reversion.md — type: `bug`+`reason`+`omission`
- **문제**: oh-my-codex 재설치/업데이트가 `~/.codex/config.toml`의 8개 MCP tool `approval_mode`를 `approve`로 되돌려 `codex exec` subprocess를 stall시킨다.
- **이유(reason)**: 메모에 따르면 템플릿 소유권이 `node_modules/oh-my-codex` 쪽에 있고, 당시 `scripts/tfx-route.sh`의 감지 로직이 top-level approval/sandbox만 보고 per-tool `approve` 상태를 놓쳤다.
- **현재 해결책 여부**: 로컬 repo에는 이후 완화 커밋(`f99bdbd`, `eb473ae`, `540286f`)이 남아 있어 **로컬 증상은 부분 완화**됐지만, 메모가 지적한 upstream override 보존/기본값 수정 자체는 외부 의존이라 아직 `omission` 상태다.
- **근거**: memory index 24행, `feedback_codex_mcp_tool_approval_reversion.md` 3/26행.
- **권장**: 메모를 “로컬 guard 존재 + upstream permanent fix 미완료” 상태로 동기화하고, upstream issue URL을 명시적으로 추적한다.

### [M2] feedback_remote_spawn_setup_guard.md — type: `omission`+`intent`
- **문제**: `/tfx-remote-spawn`가 `hosts.json` 누락·probe 만료·SSH 진단 실패 시 자동으로 `/tfx-remote-setup` 단계로 복귀해야 한다는 요구가 메모에 남아 있다.
- **현재 상태**: `scripts/remote-spawn.mjs`에는 probe TTL(`REMOTE_ENV_TTL_MS`)과 캐시 로직은 있지만, `setup --add/--edit/--diagnose`를 자동 호출하는 preflight는 찾지 못했다. `skills/tfx-remote-spawn/SKILL.md`도 여전히 “`hosts.json`이 없으면 `/tfx-remote-setup` 안내” 수준이다.
- **유실 메커니즘**: 환경 진단 로직은 구현됐지만, 사용자 개입 없는 “자동 복귀” intent가 코드/스킬 양쪽에 닫히지 않았다.
- **근거**: `feedback_remote_spawn_setup_guard.md` 7-19행, `scripts/remote-spawn.mjs` 48-49/811-890행, `skills/tfx-remote-spawn/SKILL.md` 78/245-249행.
- **권장**: remote-spawn 진입부에 setup guard를 구현하고, 스킬 문서도 “안내”가 아니라 “자동 복구” 흐름으로 맞춘다.

### [M3] Gstack checkpoint 20260413-013010-native-bash-wrapper-hardening.md — type: `loss`+`intent`
- **중단된 작업**: Windows에서 raw `.sh` command string이 파일 열기로 오인되지 않도록 `native-supervisor` 경로를 hardening하는 5파일 follow-up patch.
- **어디서 멈췄나**: 체크포인트가 아직 `status: in-progress`이며, 남은 작업이 “5파일 패치 커밋 여부 결정 → Lore 커밋 작성 → 더 큰 `$plan-eng-review`로 복귀”로 남아 있다.
- **재개 가능성**: 체크포인트 본문에 수정 대상 파일, 검증 명령, 의도까지 남아 있어 재구성은 가능하다. 다만 2026-04-13 이후 해당 5파일에 대한 `git log`가 비어 있고 현재 working tree도 깨끗해서, 실제 patch 자체는 유실됐을 가능성이 높다.
- **근거**: `~/.gstack/projects/triflux/checkpoints/20260413-013010-native-bash-wrapper-hardening.md`, `git log --since='2026-04-13' -- hub/lib/bash-path.mjs ...`, `git status --short -- <5 files>`.
- **권장**: 체크포인트를 기준으로 patch를 재현할지, 아니면 이미 다른 경로로 해결됐는지 먼저 diff 재검증 후 결정한다.

### [M4] .triflux/swarm-logs/recovery-git — type: `loss`+`bug`+`intent`
- **문제**: 최근 recovery swarm이 `docs/recovery/git.md` 생성을 목표로 3회 재시도했지만 모두 실패하고 dead 상태로 종료됐다.
- **실패 흔적**: `conductor-events.jsonl`에 `exit code=1` → `restart_1/2` → `restart_2/2` → `maxRestarts(2)_exceeded`가 남고, err log에는 `The system cannot find the path specified.`만 반복된다.
- **왜 recovery 대상인가**: 프롬프트 자체가 “main에 반영되지 않았거나 유실 위험 있는 작업 식별” intent를 담고 있었는데, 산출물(`docs/recovery/git.md`)은 생성되지 않았다.
- **근거**: `.triflux/swarm-logs/recovery-git/conductor-events.jsonl`, `.triflux/swarm-logs/recovery-git/swarm-recovery-git-1776411815909.err.log`, 현재 `docs/recovery/git.md` 부재.
- **권장**: recovery swarm의 cwd/경로 조합을 먼저 재현 가능한 최소 케이스로 검증하고, 그 다음 동일 프롬프트를 재실행한다.

### [M5] hud/mission-board.mjs TODO — type: `omission`
- **라인/내용**: `hud/mission-board.mjs:52` — `// TODO: derive dagLevel from real mission dependency metadata instead of hardcoding 0.`
- **의미**: mission board가 DAG 레벨을 실제 dependency metadata 대신 `0`으로 하드코딩하고 있어, 시각화가 현재 구조적 의존성을 반영하지 못한다.
- **범위 메모**: 최근 1주 수정 파일 기준 `TODO/FIXME` 검색에서는 문서/스킬 텍스트를 제외하면 이 TODO가 실코드에서 가장 직접적인 후속 작업이다.
- **권장**: 실제 mission dependency graph에서 `dagLevel`을 계산해 넣거나, 당장 표시하지 않을 값이면 UI/필드를 제거한다.

### [M6] routing-weights.json — type: `diff`
- **현재 상태**: `total_routes=147`, `overrides=0`, `mode_bias={ auto: 0.692, persist: 0.116, swarm: 0.074, remote-spawn: 0.069, fullcycle: 0.040, hub: 0.010 }`.
- **왜 diff인가**: `hooks/hook-orchestrator.mjs`는 bias를 빈 맵에서 시작해 completion이면 `+0.05`, abort/override면 `-0.1` 후 정규화한다. 즉 현재 파일은 “과거 누적 선택 편향”의 snapshot인데, 별도 이전 스냅샷이 없어 exact historical diff는 복원되지 않는다.
- **의미 있는 드리프트**: override가 0인데 `auto`가 0.692까지 치우쳐 있어, 현재 학습 상태는 사실상 auto 모드 우선으로 고착된 상태다. 실패/재고 이벤트가 bias 파일에 남지 않으면 왜곡을 되돌릴 수 없다.
- **근거**: `~/.gstack/projects/triflux/routing-weights.json`, `hooks/hook-orchestrator.mjs` 305-340행.
- **권장**: bias 파일에 주기적 snapshot/reset 정책을 두고, 의미 있는 bias 변화(예: 0.15 이상)는 별도 로그/메모로 남긴다.

## 종합 권장
- **type 분포**: `omission` 3건, `intent` 3건, `loss` 2건, `bug` 2건, `reason` 1건, `diff` 1건.
- **메모 동기화 필요**: 2건
  - `M1`: 로컬 완화 vs upstream 미해결 상태를 반영하도록 memory 업데이트 필요
  - `M3`: checkpoint가 실제로 구조 유실인지, 이미 대체 구현이 있었는지 상태 확정 필요
- **이슈/백로그화 권장**: 4건
  - `M2`: remote-spawn setup guard 자동화
  - `M4`: recovery swarm path/cwd 실패 원인 수정
  - `M5`: mission-board DAG metadata 연동
  - `M6`: routing bias snapshot/reset 정책
