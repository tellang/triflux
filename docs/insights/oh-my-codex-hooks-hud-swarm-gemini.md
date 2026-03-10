# Gemini 분석 메모 기반 정리: Codex + oh-my-codex 확장 구조

> 생성 방식: Gemini CLI로 초안 생성 후, 로컬 코드/공식 문서 기준으로 사실 검증해 정제함.

## 1) 공식 Codex 기준

- Hooks:
  - 일반 플러그인형 hooks 프레임워크가 아니라 `notify` 명령 기반 확장 포인트가 제공된다.
  - 출처: OpenAI Codex Config Reference (`notify`).
- HUD:
  - 공식 문서에서 독립 HUD 기능은 확인되지 않는다.
  - 기본은 TUI/CLI 기능 중심.
- Multi-agent:
  - 공식적으로 지원되지만 `experimental` 기능이며 명시적 활성화가 필요하다.
  - 출처: OpenAI Codex Multi-agent 문서.

## 2) oh-my-codex가 보강하는 지점

로컬 설치본(`C:/Users/SSAFY/AppData/Roaming/npm/node_modules/oh-my-codex`) 기준:

- Hooks 계층:
  - `scripts/notify-hook.js`
  - `dist/cli/hooks.js`
  - `dist/hooks/extensibility/loader.js`
  - `dist/hooks/extensibility/dispatcher.js`
  - 의미: notify 이벤트를 받아 `.omx/hooks/*.mjs` 플러그인 흐름으로 확장.

- HUD 계층:
  - `dist/hud/index.js`
  - `dist/hud/state.js`
  - `dist/hud/render.js`
  - 의미: `.omx/state` 기반으로 상태줄/HUD 렌더링.

- Team/Swarm 계층:
  - `dist/cli/team.js`
  - `dist/hooks/keyword-registry.js`
  - 의미: `swarm`은 별도 엔진보다 `team` 호환 alias로 처리.

## 3) triflux 연동 포인트

- Codex notify 연결:
  - `C:/Users/SSAFY/.codex/config.toml`의 `notify = ["node", ".../notify-hook.js"]`
- triflux 라우팅:
  - `scripts/tfx-route.sh`
- triflux 스킬:
  - `skills/tfx-auto/SKILL.md`
  - `skills/tfx-team/SKILL.md`
  - `skills/tfx-auto-codex/SKILL.md` (이번 추가)

## 4) Codex에서 Claude 역할 대체 전략

실행 레이어에서 Claude 네이티브 역할을 Codex로 치환하면 된다.

- 구현 포인트:
  - `scripts/tfx-route.sh`의 `TFX_NO_CLAUDE_NATIVE=1`
- 치환 대상:
  - `explore`, `verifier`, `test-engineer`, `qa-tester`
- 유지 대상:
  - `designer`, `writer`는 Gemini 경로 유지 가능

## 5) 체크리스트

1. `.codex/config.toml`에서 `notify`가 활성화되어 있는지 확인
2. `oh-my-codex` 설치본에서 `omx hooks`, `omx hud`, `omx team` 명령 사용 가능 여부 확인
3. `scripts/tfx-route.sh`에 `TFX_NO_CLAUDE_NATIVE=1` 적용 경로 점검
4. `/tfx-auto-codex` 실행 시 Claude 네이티브 분기가 발생하지 않는지 로그로 확인
5. DAG 실행 시 context 전달(`5번째 인자`)이 유지되는지 확인

