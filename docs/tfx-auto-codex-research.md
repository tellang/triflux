# Codex 제약 주장 검증 리서치 (2026-03-10)

## 검증 대상

주장: "Codex는 hooks, HUD, agent swarm을 지원하지 않고, Rust라 확장이 어렵다."

## 결론 요약

- **Hooks**: 완전 미지원은 아님. 공식 Codex에 `notify` 기반 확장 포인트가 존재.
- **HUD**: 공식 Codex의 전용 HUD 기능은 확인되지 않음. TUI 중심.
- **Agent swarm/multi-agent**: 공식 Codex에서 **experimental**로 제공.
- **Rust 기반 확장 난이도**: 코어 수정 난이도는 높지만, 외부 확장(설정/notify/MCP)은 가능.
- **oh-my-codex**: hooks/HUD/team 기능을 Codex 위에 보강하는 로컬 확장 레이어로 동작.

## 근거 매트릭스

### 1) 공식 Codex

1. Config reference  
   - <https://developers.openai.com/codex/config-reference>  
   - `notify` 항목 존재 (알림 시 외부 명령 실행).
   - `features.multi_agent` 항목 존재 (experimental 기능 플래그).

2. Multi-agent 문서  
   - <https://developers.openai.com/codex/multi-agent>  
   - multi-agent는 experimental이며 명시적 활성화가 필요.

3. Codex CLI features  
   - <https://developers.openai.com/codex/cli/features>  
   - multi-agent 섹션 존재.
   - HUD라는 별도 기능 명시는 확인되지 않음.

4. 공식 저장소  
   - <https://github.com/openai/codex>  
   - Rust 구현(`codex-rs`)이 유지되는 기본 구현으로 안내됨.

### 2) oh-my-codex (보강 레이어)

1. README (설치본/원본)  
   - `omx hooks`, `omx hud`, `omx team` 명령 제공
   - Hooks extension을 `.omx/hooks/*.mjs`로 제공

2. 설치본 로컬 구현 근거
   - `scripts/notify-hook.js`
   - `dist/cli/hooks.js`
   - `dist/hud/*`
   - `dist/cli/team.js`
   - `dist/hooks/keyword-registry.js` (`swarm`을 `team` alias로 처리)

## 해석

- "Codex는 hooks/HUD/swarm을 전혀 지원하지 않는다"는 현재 시점 기준으로 부정확하다.
- 더 정확히는:
  - 공식 Codex: `notify` + `experimental multi-agent` 중심
  - oh-my-codex: hooks/HUD/team orchestration을 상위 레이어로 확장

## triflux 적용 관점

- triflux의 `tfx-route`/`tfx-team`은 이미 이 확장 모델과 친화적이다.
- Codex 전용 `tfx-auto`를 만들 때는 Claude 네이티브 예외 역할만 Codex로 매핑하면 일관성이 크게 올라간다.

