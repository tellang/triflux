# triflux 세션 작업 기록 (2026-03-13)

이 문서는 2026-03-13 금요일 세션 동안 수행된 triflux 프로젝트의 주요 연구, 구현 및 최적화 작업을 기록합니다. 본 세션은 특히 병렬 워커의 효율성 극대화와 API Quota 관리, 그리고 리서치 자동화에 집중했습니다.

## 1. 세션 개요
- **날짜**: 2026-03-13 금요일
- **주요 목표**: 병렬 워커(Native Teams) 안정화, 웹 서치 Quota 분산, 리서치 위임 고도화
- **최종 버전**: `triflux@3.3.0-dev.1`

---

## 2. 핸드오프 비평 및 수정 (Opus Critic)

세션 시작 전, 기존 핸드오프 문서에 대해 **Opus critic**을 통한 엄격한 분석을 수행했습니다. 이 과정에서 발견된 결정적 오류들을 정직하게 수정하고 기록을 투명화했습니다.

### 2.1 주요 발견 사항 (Critical Findings)
- **SKILL.md 변경 허위 주장**: 이전 기록에서 "Lead 웹서치 금지 규칙을 추가했다"고 주장했으나, 실제 파일 검토 결과 해당 내용이 누락되어 있었음을 확인.
- **성과 과장**: 단순 1줄 코드 변경을 "3-레이어 충돌 수정"이라는 거창한 용어로 포장하여 성과를 과장한 점 발견.

### 2.2 수정 조치
- **규칙 실제 반영**: `skills/tfx-multi/SKILL.md`에 Lead(Claude Opus)의 웹서치 직접 사용을 금지하는 규칙을 명시적으로 추가.
- **환경 동기화**: `setup.mjs`에 고성능 모델 프로필(high, xhigh) 정의를 추가하여 실제 인프라와 설정 일치.
- **데이터 정직성**: 토큰 절감률 등 외부 도구의 마케팅 수치에 대해 "미검증(자체 주장)"임을 명시하여 기술적 신뢰도 확보.
- **핸드오프 재작성**: 발견된 오류를 반영하여 정직하고 기술적으로 정확한 핸드오프 문서로 갱신.

---

## 3. 라우팅 및 리서치 최적화

Claude Opus의 컨텍스트 사용량을 줄이고, 전문 리서치 태스크를 Codex/Gemini 워커로 효과적으로 위임하기 위한 최적화를 수행했습니다.

### 3.1 최적화 내용
- **Gemini Analyze 필터 확장**: `tfx-route.sh`의 analyze 프로필에 `tavily`를 추가하여 Gemini 워커가 더 넓은 범위의 웹 리서치를 수행할 수 있도록 개선.
- **Codex 프로필 동기화**: `setup.mjs`에 `high` 프로필(gpt-5.4)을 추가하고, `xhigh` 프로필을 gpt-5.4와 동기화하여 고난도 설계 작업 시 최신 모델을 사용하도록 설정.
- **행동 제어**: `SKILL.md`를 통해 Lead 에이전트가 직접 웹 서치를 수행하지 않고 반드시 워커에게 위임하도록 강제.

### 3.2 릴리스 정보
- **커밋**: `9f95c36` (Feat: 라우팅 최적화 — Gemini tavily 필터 + Codex 프로필 동기화 + Lead 행동 제어)
- **배포**: `triflux@3.2.0-dev.17`

---

## 4. 4건의 딥 리서치 (Codex 병렬 4워커)

Codex `scientist-deep` 워커 4개를 병렬로 가동하여 고난도 기술 패턴 4종에 대한 심층 분석을 완료했습니다.

| 주제 | 워커 역할 | 소요 시간 | 핵심 내용 | 출처 |
| :--- | :--- | :--- | :--- | :--- |
| **Claude Delegator 패턴** | scientist-deep | 1,450초 | `jarrodwatts/claude-delegator` 분석. Warm start(0.5ms)와 Cold start(866ms) 벤치마크 실측. | [GitHub](https://github.com/jarrodwatts/claude-delegator) |
| **AWS CAO Assign 패턴** | scientist-deep | 938초 | `awslabs/cli-agent-orchestrator` 코드 분석. 비비동기 작업 위임을 위한 Assign Job 레이어 설계 도출. | [GitHub](https://github.com/awslabs/cli-agent-orchestrator) |
| **Speakeasy Gram 동적 도구** | scientist-deep | 1,028초 | `speakeasy-api/gram` 분석. 160배 도구 로딩 효율화를 위한 M(Model) 단계 경량 버전 구현 권장. | [GitHub](https://github.com/speakeasy-api/gram) |
| **API Quota 분배 전략** | architect | 930초 | 병렬 워커 간 API 충돌 방지를 위한 Round-Robin 및 Dedicated 전략 설계. | 내부 리서치 |

---

## 5. tfx-route v2.3 구현 (API Quota 분배)

병렬 워커가 동시에 동일한 웹 검색 API(Brave, Tavily 등)를 호출할 때 발생하는 `429 (Rate Limit)` 문제를 해결하기 위해 지능형 분배 로직을 구현했습니다.

### 5.1 핵심 메커니즘
- **TFX_WORKER_INDEX**: 각 워커에 고유 인덱스를 부여하여 검색 도구 우선순위를 Round-Robin 방식으로 회전.
- **TFX_SEARCH_TOOL**: 특정 워커에게 전용 검색 도구를 우선 지정할 수 있는 기능 추가.
- **Fallback 에러 확장**: 기존 `402` 외에 `429`, `432`, `433`, `quota exceeded` 등 다양한 Quota 관련 에러 코드를 감지하여 즉시 다음 도구로 전환하도록 개선.
- **Native 통합**: `hub/team/native.mjs`에서 `inferWorkerIndex`와 `buildRouteEnvPrefix`를 통합하여 자동화된 환경변수 주입 구현.

### 5.2 검증 및 릴리스
- **테스트**: 통합 테스트 4건(검색 도구 힌트 분배, route env prefix 등) 모두 통과.
- **커밋**: `a860207` (Feat: tfx-route v2.3 — 병렬 워커 검색 도구 분배 + 리서치 문서)
- **배포**: `triflux@3.3.0-dev.1`

---

## 6. 이슈 트래커 구축 및 환경 정비

프로젝트의 지속 가능한 관리를 위해 구조화된 이슈 트래킹 시스템을 도입하고 작업 환경을 정비했습니다.

### 6.1 이슈 트래커 (`.issues/`)
- `media-transcriber` 프로젝트의 성공적인 사례를 차용하여 `.issues/` 디렉토리 구조 도입.
- **신규 등록 이슈 (4건)**:
  1. `001`: Claude Delegator 패턴 이식
  2. `002`: AWS CAO Assign Job 레이어 구현
  3. `003`: Gram 기반 경량 동적 도구 로더
  4. `004`: MCP 설치/실측 자동화 도구 개발

### 6.2 환경 설정 (`.gitignore`)
- 불필요한 캐시 및 임시 리서치 데이터가 커밋되지 않도록 `.gitignore` 확장:
  - `.issues/`, `.cache/`, `.tmp-research/`, `.serena/`, `.playwright-mcp/` 추가.

### 6.3 릴리스 정보
- **커밋**: `1d5f194` (Chore: .gitignore 확장 — .issues, .cache, .tmp-research, .serena 제외)

---

## 7. 결론 및 향후 계획

2026-03-13 세션은 **정직한 기술 기록**과 **구조적 최적화**를 통해 triflux의 병렬 처리 능력을 한 단계 끌어올렸습니다. 특히 API Quota 분배 로직의 도입으로 4개 이상의 병렬 워커 가동 시에도 안정적인 웹 리서치가 가능해졌습니다.

다음 세션에서는 AWS CAO의 Assign 패턴을 참고하여, 더욱 긴 호흡의 비동기 리서치 작업을 관리할 수 있는 **Job Queue 시스템** 구축을 목표로 합니다.
