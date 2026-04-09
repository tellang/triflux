# Remaining Issues Batch — #4, #6, #8, #9, #10

> 미해결 이슈 5건을 병렬 처리한다. 각 shard는 독립적이며 파일 충돌 없음.

## Shard: mission-board
- agent: codex
- files: hud/mission-board.mjs, hud/renderers.mjs, tests/unit/mission-board.test.mjs
- prompt: |
    Issue #4 P1: HUD Mission Board 구현.
    tfx-multi/tfx-team 실행 시 에이전트별 실시간 진행률을 HUD에 표시한다.
    - hud/mission-board.mjs 신규 생성: getMissionBoardState() 함수 — .omc/state/sessions/ 디렉토리에서 팀 상태를 읽어 {agents: [{name, status, progress}], dagLevel, totalProgress} 반환
    - hud/renderers.mjs: renderMissionBoard() 추가 — 에이전트별 상태를 1줄 compact 포맷으로 렌더링 (예: "🔨 codex:auth ✅ gemini:ui ⏳ codex:perf")
    - tests/unit/mission-board.test.mjs: getMissionBoardState + renderMissionBoard 단위 테스트
    - 기존 429 백오프 로직(이미 구현됨)은 건드리지 않는다

## Shard: skill-active-state
- agent: codex
- files: scripts/lib/skill-state.mjs, scripts/setup.mjs, tests/unit/skill-state.test.mjs
- prompt: |
    Issue #6: Skill Active State 라이프사이클 구현.
    stop-hook은 이미 구현됨. 스킬 시작/종료 시 상태를 추적하는 시스템 추가.
    - scripts/lib/skill-state.mjs 신규 생성:
      - activateSkill(skillName) — .omc/state/{skillName}-active 파일 생성 (timestamp, pid 포함). 이미 활성이면 Error throw
      - deactivateSkill(skillName) — 상태 파일 삭제
      - getActiveSkills() — 활성 스킬 목록 반환
      - pruneOrphanSkillStates() — pid가 죽은 상태 파일 정리
    - scripts/setup.mjs: SessionStart에서 pruneOrphanSkillStates() 호출 추가 (기존 로직 뒤에 1줄)
    - tests/unit/skill-state.test.mjs: activate/deactivate/duplicate/orphan 테스트

## Shard: psmux-demo
- agent: gemini
- files: scripts/demo.mjs, docs/demo-guide.md
- prompt: |
    Issue #8: psmux 데모/쇼케이스 스크립트 작성.
    triflux의 멀티모델 오케스트레이션을 시각적으로 보여주는 데모 스크립트.
    - scripts/demo.mjs: CLI 실행 가능한 데모 스크립트
      - 3개 psmux 패널 생성 (codex, gemini, claude 시뮬레이션)
      - 각 패널에서 순차적으로 작업 시뮬레이션 출력
      - HUD 상태라인 표시
      - 종료 시 결과 요약
    - docs/demo-guide.md: 데모 실행 방법 + 스크린샷 가이드
    - psmux API 사용: new-session, split-window, send-keys
    - 실제 CLI 호출은 하지 않고 echo로 시뮬레이션

## Shard: path-utils
- agent: codex
- files: hub/lib/path-utils.mjs, tests/unit/path-utils.test.mjs
- prompt: |
    Issue #9: Windows 경로 유틸 통합 모듈 추출.
    산재된 경로 변환 로직을 하나의 모듈로 통합한다.
    - hub/lib/path-utils.mjs 신규 생성:
      - toPosixPath(windowsPath) — C:\foo\bar → /c/foo/bar
      - toWindowsPath(posixPath) — /c/foo/bar → C:\foo\bar
      - normalizePath(p) — OS에 맞게 정규화
      - resolveShellPath(path, shellType) — git-bash, wsl, cmd, powershell 별 변환
      - detectShellType() — 현재 셸 감지 (git-bash, wsl, cmd, powershell)
      - isWslPath(p), isGitBashPath(p) — 경로 타입 판별
    - tests/unit/path-utils.test.mjs: 각 함수의 변환 정확성 테스트 (Windows/POSIX 양방향)
    - 기존 파일은 수정하지 않는다 (추후 마이그레이션)

## Shard: runtime-strategy
- agent: codex
- files: hub/team/runtime-strategy.mjs, tests/unit/runtime-strategy.test.mjs
- prompt: |
    Issue #10: Runtime Strategy 패턴 도입.
    3-way 분기(tmux/in-process/wt)를 Strategy 패턴으로 추상화한다.
    - hub/team/runtime-strategy.mjs 신규 생성:
      - class TeamRuntime (추상 인터페이스): start(), stop(), isAlive(), focus(), sendKeys(), interrupt(), getStatus()
      - class PsmuxRuntime extends TeamRuntime — psmux 기반 구현
      - class NativeRuntime extends TeamRuntime — Claude Native Teams 기반 구현
      - class WtRuntime extends TeamRuntime — Windows Terminal 독립 모드 구현
      - createRuntime(mode) — 팩토리 함수, mode에 따라 적절한 런타임 반환
    - tests/unit/runtime-strategy.test.mjs: 팩토리 함수 + 각 런타임의 인터페이스 준수 테스트
    - 기존 11곳 분기는 수정하지 않는다 (추후 마이그레이션)
