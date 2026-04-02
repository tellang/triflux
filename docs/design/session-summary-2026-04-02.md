# Session Summary — 2026-04-02

> 상태: Draft  
> 범위: v9.6.0~v9.7.0 작업 흐름, 이후 후속 검증 및 수습 포함

---

## 1. 릴리즈 흐름

- 오늘 로그 기준 버전 범프는 `v9.6.0`과 `v9.7.0`까지 확인됐다.
- `git log`만으로 실제 `npm publish` 실행까지 단정하지는 않는다.

## 2. 오늘 축적된 핵심 변화

- Gemini stall, async 출력 캡처, route/psmux/headless 생명주기 버그를 순차적으로 줄였다.
- 레퍼런스 문서 복구와 `docs/design` 자산 정리가 진행됐다.
- MCP 중앙화 가드 시스템이 SessionStart, PostToolUse, setup/update, `tfx mcp sync` 경로로 확장됐다.
- `tfx doctor`는 docs sync, Gemini MCP, route 정합성 검사에 이어 hook coverage까지 확인할 수 있는 방향으로 강화됐다.

## 3. 오늘 드러난 운영 문제

### 스웜 작업 디렉터리

- `.codex-swarm/wt-*` 디렉터리는 실제 git worktree로 보장되지 않았다.
- 그 결과 일부 시도는 메인 리포지토리에 직접 변경을 남겼다.

### 훅 경로 해석

- `CLAUDE_PLUGIN_ROOT`가 worktree성 경로로 오염되면 Stop 훅이 `pipeline-stop.mjs`를 잘못 찾는 문제가 재현됐다.
- 이 문제는 settings에 잘못된 훅 경로가 기록될 때 더 악화된다.

### 문서 생성 보고의 신뢰성

- 외부 one-shot 호출이 "파일 생성 완료"라고 응답해도, 메인 리포지토리에 실제 파일이 없을 수 있었다.
- 이후 이 턴에서 `docs/design/execution-modes.md`, `docs/design/session-summary-2026-04-02.md`를 실제로 생성해 불일치를 정리했다.

## 4. 이번 턴에서 실제로 마무리한 것

- `scripts/setup.mjs`
- hook 자동 등록 로직이 invalid `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`를 신뢰하지 않도록 보강했다.
- 유효한 triflux 패키지 루트를 검증한 뒤에만 settings 훅 명령을 생성하도록 했다.

- `bin/triflux.mjs`
- `doctor --json`이 `hook_coverage`를 구조화된 필드로 반환하도록 유지했다.
- `doctor --fix`에서 hook registry 기반 자동 등록과 coverage 재평가 흐름이 연결된 상태를 검증했다.

- `tests/unit/setup-sync.test.mjs`
- 잘못된 `CLAUDE_PLUGIN_ROOT`가 settings에 새겨지지 않는 회귀 테스트를 추가했다.

- `tests/integration/triflux-cli.test.mjs`
- `hook_coverage` JSON 스키마 표면 검증을 유지했다.

## 5. 검증 결과

- `node --test tests/unit/setup-sync.test.mjs` 통과
- `node --test tests/integration/triflux-cli.test.mjs` 통과
- `npm test` 전체 통과

## 6. 다음 우선순위

- `.codex-swarm/wt-*`를 진짜 worktree로 만들지, 아니면 단순 작업 디렉터리 모델로 명확히 고정할지 정해야 한다.
- swarm 완료 감지는 pane 텍스트가 아니라 git 상태와 테스트 결과를 함께 집계하는 공식 status 명령으로 승격하는 편이 낫다.
- 스킬 문서와 런처 예시에 "구현은 mode C/D, 텍스트 산출은 mode A/B" 규칙을 더 강하게 못박을 필요가 있다.
