# PRD: 고아 모듈 정리 + Q-Learning 게이트 해제

## 목표
런타임 호출 0인 고아 모듈 5개에 @experimental 마킹 + Q-Learning 라우터 활성화 경로 준비

## Shard 1: 고아 모듈 @experimental 마킹
- agent: codex
- files: hub/research.mjs, hub/intent.mjs, hub/token-mode.mjs, hub/fullcycle.mjs, hub/codex-compat.mjs
- prompt: |
    다음 5개 파일의 모듈 JSDoc 주석 맨 위에 @experimental 태그를 추가하라:
    - hub/research.mjs: "자율 리서치 오케스트레이션 — 런타임 미연결, 테스트만 존재"
    - hub/intent.mjs: "사용자 의도 분류 — 런타임 미연결, 테스트만 존재"
    - hub/token-mode.mjs: "토큰 압축/확장 — 런타임 미연결, 테스트만 존재"
    - hub/fullcycle.mjs: "Fullcycle 아티팩트 관리 — 런타임 미연결, re-export만 존재"
    - hub/codex-compat.mjs: "Codex 호환 레이어 — 런타임 미연결, 테스트만 존재"

    기존 코드를 변경하지 말고 JSDoc 주석만 추가. 각 파일의 첫 export 또는 함수 앞에:
    ```javascript
    /** @experimental 런타임 미연결 — 향후 통합 예정 */
    ```
    커밋 메시지: "chore: 고아 모듈 5개에 @experimental 마킹"

## Shard 2: Q-Learning 라우터 환경변수 문서화
- agent: codex
- files: hub/routing/index.mjs, CLAUDE.md
- prompt: |
    hub/routing/index.mjs의 isDynamicRoutingEnabled 함수(line 38-41)를 확인하라.
    현재 TRIFLUX_DYNAMIC_ROUTING=true 환경변수가 필요한데 아무 문서에도 없다.

    CLAUDE.md의 <routing> 섹션 마지막에 다음을 추가:
    ```
    ### Q-Learning 동적 라우팅 (실험적)
    TRIFLUX_DYNAMIC_ROUTING=true 설정 시 Q-Learning 기반 동적 스킬 라우팅 활성화.
    routing-weights.json + Q-table로 스킬 선택 최적화. 기본 비활성.
    ```
    커밋 메시지: "docs: Q-Learning 동적 라우팅 환경변수 문서화"
