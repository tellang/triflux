# PRD: reflexion.mjs store API 통합

## 목표
reflexion.mjs의 store 함수들(lookupSolution, learnFromError, reportOutcome, promoteRule, decayRules, getActiveAdaptiveRules)이
store-adapter.mjs의 adaptive_rules API(addAdaptiveRule, findAdaptiveRule, updateRuleConfidence)와 다른 API surface를 사용하는 문제 해소.

## 배경
- reflexion.mjs는 store.findReflexion / store.addReflexion 사용
- store-adapter.mjs는 store.addAdaptiveRule / store.findAdaptiveRule 사용
- 두 경로가 독립적으로 존재하여 데이터가 교차되지 않음
- promoteRule, decayRules는 이미 server.mjs에서 호출하도록 연결됨 (937b28c)
- 하지만 내부적으로 store.getReflexion/store.patchReflexion을 사용하여 adaptive_rules 테이블과 연결 안 됨

## Shard 1: reflexion store 함수 → adaptive_rules 호환
- agent: codex
- files: hub/reflexion.mjs, hub/store-adapter.mjs
- prompt: |
    hub/reflexion.mjs의 다음 함수들을 수정하여 store-adapter.mjs의 adaptive_rules API를 사용하도록 변경하라:

    1. promoteRule(store, ruleId, errorContext): store.getReflexion → store.findAdaptiveRule 사용
    2. decayRules(store, sessionCount): store.listReflexion → adaptive_rules 전체 조회 사용
    3. getActiveAdaptiveRules(store, projectSlug): store.listReflexion → store의 adaptive_rules 조회 사용

    lookupSolution, learnFromError, reportOutcome은 현재 미사용이므로 @deprecated JSDoc 주석만 추가.

    기존 테스트(tests/unit/reflexion-adaptive.test.mjs)가 통과해야 함.
    커밋 메시지: "refactor: reflexion store 함수를 adaptive_rules API로 통합"

## Shard 2: 테스트 검증
- agent: codex
- files: tests/unit/reflexion-adaptive.test.mjs, tests/unit/store-adapter-tier2.test.mjs
- prompt: |
    reflexion.mjs의 store 함수 변경 후 다음 테스트를 실행하여 통과 확인:
    - node --test tests/unit/reflexion-adaptive.test.mjs
    - node --test tests/unit/store-adapter-tier2.test.mjs
    실패하면 테스트를 수정하여 통과시켜라.
    커밋 메시지: "test: reflexion adaptive rules 통합 테스트 수정"
