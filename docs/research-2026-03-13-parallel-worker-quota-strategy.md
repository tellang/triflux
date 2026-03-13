# triflux 병렬 워커 API Quota 분배 전략

> 날짜: 2026-03-13
> 범위: `scripts/tfx-route.sh`, `hub/team/native.mjs`, 테스트

---

## 1. 현재 문제 정량화

### 1.1 현재 코드 상태

- `analyze` 프로필의 검색 힌트는 모든 워커에 동일한 우선순위를 준다.
  - 현재 기본 순서: `brave-search -> tavily -> exa`
  - 위치: `scripts/tfx-route.sh`
- 워커 식별자는 `TFX_TEAM_AGENT_NAME`만 전달되고, 검색 quota 분산용 인덱스는 없었다.
  - 위치: `hub/team/native.mjs`

### 1.2 실제 실패 패턴

- 2026-03-12 06:07:02Z turn 로그:
  - Brave 1건 성공 후 같은 turn 안에서 `429`
  - Tavily `432`
  - Exa `402`
  - 파일: `.omx/logs/turns-2026-03-12.jsonl`
- 2026-03-11 09:33:53Z / 09:40:31Z turn 로그:
  - `Context7` quota 초과
  - `Tavily 432`
  - `Exa 402`
  - 최종적으로 공식 페이지 직접 방문
  - 파일: `.omx/logs/turns-2026-03-11.jsonl`
- 2026-03-13 내부 핸드오프 요약:
  - 4개 병렬 Codex 워커 실행 시 “Worker 1만 brave-search 성공, 나머지 rate limit”
  - 파일: `docs/handoff/2026-03-13-midterm-actions.md`

### 1.3 핵심 해석

- 현재 문제는 “모든 워커가 같은 첫 번째 도구를 동시에 친다”는 구조적 문제다.
- `402 에러 시 다음 도구로 전환` 힌트는 이미 있었지만, 실제 실패는 `429`와 `432`도 빈번하다.
- 즉, 현재 힌트는 불완전하고, 힌트만으로는 동시성 충돌을 줄이지 못한다.

---

## 2. 최신 Rate Limit 정보

### 2.1 Brave Search

- 공식 페이지: `https://brave.com/search/api/`
- 2026-03-13 기준 공개 정보:
  - Search: `50 queries per second`
  - Answers: `2 queries per second`
  - 매월 `$5 free credits`
- 라이브 API 응답(현재 triflux에 연결된 키):
  - `plan=Free`
  - `rate_limit=1`
  - `quota_limit=2000`
  - 이 값은 `brave-search` MCP 호출의 실제 `429` 응답 payload에서 확인

정리:
- 공식 유료 Search capacity는 50 QPS로 보인다.
- 그러나 현재 triflux가 쓰는 실제 키는 2026-03-13 시점에 Free 플랜 1 req/sec, 월 2000 quota 상태다.
- 따라서 사용자 전제의 `15 req/sec (Pro)`는 현재 환경 기준으로는 맞지 않다.

### 2.2 Tavily

- 공식 문서: `https://docs.tavily.com/documentation/api-reference/endpoint/search`
- 2026-03-13 기준 공개 정보:
  - 인증 방식: `Bearer tvly-...` API key
  - 비용 모델:
    - `basic`, `fast`, `ultra-fast`: 1 credit
    - `advanced`: 2 credits
  - 응답/오류 코드 탭에 `429`, `432`, `433`가 명시됨
- 라이브 API 응답:
  - `"This request exceeds your plan's set usage limit"`

정리:
- Tavily는 per-plan, per-key 형태로 quota를 집행하는 것으로 보인다.
- 공개 API 문서에서는 free/paid tier별 QPS 표를 찾지 못했다.
- `429` 외에 `432`도 실제 운영에서 자주 보이므로 fallback 조건에 포함해야 한다.

### 2.3 Exa

- 공식 페이지: `https://exa.ai/pricing`
- 2026-03-13 기준 공개 정보:
  - Free: `Run up to 1,000 requests for free every month`
  - Search: `$7 / 1k requests`
  - Enterprise: `Custom rate limits (QPS)`
- 라이브 API 응답:
  - `Search error (402)`

정리:
- Exa는 free monthly allowance와 enterprise custom QPS는 공개하지만, 일반 유료 tier의 고정 QPS는 공개하지 않는다.
- 현재 triflux 환경에서는 Exa가 `402`로 실패하므로 “rate limit fallback” 이전에 “plan/billing fallback”이 필요한 상태다.

### 2.4 Per-key vs Per-IP

- Brave, Tavily, Exa 모두 API key 기반 인증을 사용한다.
- Brave의 실제 `429` payload는 `plan`, `quota_limit`, `org_rate_limit` 같은 account/key 단위 메타데이터를 반환한다.
- Tavily는 Bearer API key와 “plan's set usage limit” 메시지를 반환한다.
- Exa는 dashboard/API pricing 구조를 사용한다.

판정:
- 셋 다 per-IP보다 per-key / per-account 집행으로 보는 것이 타당하다.
- 다만 Tavily/Exa의 “per-IP 아님”을 공개 문서 문장으로 직접 확인하지는 못했고, 인증/에러 모델을 근거로 한 추론이다.

---

## 3. 전략 3종 설계

### A. Round-Robin

목표:
- 워커마다 첫 번째 검색 도구를 다르게 해서 첫 충돌을 줄인다.

설계:
- 새 환경변수 `TFX_WORKER_INDEX` 도입
- `get_mcp_hint()`가 `TFX_WORKER_INDEX`를 보고 `brave-search -> tavily -> exa` 순서를 회전
- 예시:
  - Worker 1: `brave-search, tavily, exa`
  - Worker 2: `tavily, exa, brave-search`
  - Worker 3: `exa, brave-search, tavily`
  - Worker 4: `brave-search, tavily, exa`

구현 포인트:
- `scripts/tfx-route.sh`
  - `TFX_WORKER_INDEX` 검증 추가
  - search order 계산기 추가
  - analyze/implement/docs 힌트에 반영
- `hub/team/native.mjs`
  - `agentName` 말미 숫자 또는 명시적 `workerIndex`에서 `TFX_WORKER_INDEX` 주입

### B. Dedicated

목표:
- 워커별로 특정 검색 도구를 우선 사용하게 고정한다.

설계:
- 새 환경변수 `TFX_SEARCH_TOOL=brave-search|tavily|exa`
- strict single-tool 강제보다 “primary pin + fallback 유지”로 설계
  - 예: `TFX_SEARCH_TOOL=exa`면 `exa -> brave-search -> tavily`

이유:
- strict dedicated는 장애 시 워커 전체가 무력화된다.
- primary pin 방식이면 품질/복원력을 모두 보존할 수 있다.

구현 포인트:
- `scripts/tfx-route.sh`
  - `TFX_SEARCH_TOOL` 검증 추가
  - search order 계산에서 `TFX_SEARCH_TOOL` 우선
- `hub/team/native.mjs`
  - wrapper prompt에 `TFX_SEARCH_TOOL` 주입 가능하게 확장

### C. Rate-Aware Fallback

목표:
- transient / plan-limit 실패를 만나면 같은 도구를 재시도하지 않고 즉시 다음 도구로 넘어간다.

현재 상태:
- 기존 힌트는 `402 에러 시 즉시 다음 도구로 전환`

검증 결과:
- 이것만으로는 부족하다.
- 실제 운영 실패가 `429`, `432`, `quota exceeded`로 더 자주 나타난다.
- 또한 모든 워커가 같은 첫 도구에 몰리므로 fallback만 있어도 첫 충돌 자체는 줄지 않는다.

개선안:
- 힌트 문구를 `402, 429, 432, 433, quota`로 확대
- 실패 시 재시도 금지 유지

---

## 4. 트레이드오프

| 전략 | 구현 복잡도 | 검색 품질 | 장애 복원력 | 확장성 |
|------|-------------|-----------|-------------|--------|
| Round-Robin | 낮음 | 약간의 편차, 전체 다양성은 증가 | 높음 | 높음 |
| Dedicated | 낮음~중간 | 도구 편향 큼 | 중간 | 중간 |
| Rate-Aware Fallback만 | 매우 낮음 | 기존과 유사 | 중간 | 낮음 |

### 해석

- Round-Robin:
  - 가장 작은 변경으로 first-hit collision을 줄인다.
  - 병렬 워커 수가 늘어도 `worker_index % tool_count`로 자연스럽게 확장된다.
- Dedicated:
  - quota 비율이 명확할 때는 좋다.
  - 지금처럼 Exa `402`, Tavily usage limit 상태에서는 특정 워커를 죽은 도구에 묶기 쉽다.
- Rate-Aware Fallback만:
  - 이미 일부 구현되어 있지만, 구조적 쏠림을 해결하지 못한다.

---

## 5. 권장안

### 권장: A를 기본으로, C를 같이 강화

이유:
- ROI가 가장 높다.
- `tfx-route.sh` 힌트 계산만 바꿔도 바로 효과가 난다.
- Dedicated는 운영 키 상태가 안정된 뒤 2차 최적화로 넣는 편이 낫다.

판단 기준:
- 현재 실제 환경은 Brave Free 1 req/sec, Tavily usage limit 초과, Exa 402다.
- 이런 상태에서는 “각 워커를 특정 도구에 고정”하는 것보다 “일단 분산하고, 실패 시 넓게 폴백”하는 편이 낫다.

---

## 6. 이번 변경 사항

### 변경 파일

- `scripts/tfx-route.sh`
- `hub/team/native.mjs`
- `tests/integration/tfx-route-smoke.test.mjs`
- `tests/unit/native-wrapper.test.mjs`

### 반영 내용

- `TFX_WORKER_INDEX` 추가
- `TFX_SEARCH_TOOL` 추가
- analyze 검색 우선순위 회전 지원
- dedicated primary tool 지원
- fallback 에러 범위를 `402, 429, 432, 433, quota`로 확대
- wrapper prompt가 `TFX_WORKER_INDEX` / `TFX_SEARCH_TOOL`를 route script로 전달 가능하게 변경

### diff 예시

```diff
- [[ -n "$search_tools" ]] && hint+="웹 검색 우선순위: ${search_tools%, }. 402 에러 시 즉시 다음 도구로 전환. "
+ [[ -n "$ordered_tools_csv" ]] && hint+="웹 검색 우선순위: ${ordered_tools_csv}. 402, 429, 432, 433, quota 에러 시 즉시 다음 도구로 전환. "
```

```diff
- Bash(command: 'TFX_TEAM_NAME="..." TFX_TEAM_AGENT_NAME="${agentName}" bash ${ROUTE_SCRIPT} ...')
+ Bash(command: 'TFX_TEAM_NAME="..." TFX_TEAM_AGENT_NAME="${agentName}" TFX_WORKER_INDEX="${workerIndex}" TFX_SEARCH_TOOL="${searchTool}" bash ${ROUTE_SCRIPT} ...')
```

---

## 7. 테스트 방법

### 자동 테스트

- `node --test --test-name-pattern="검색 도구 힌트 분배|route env prefix" tests/integration/tfx-route-smoke.test.mjs tests/unit/native-wrapper.test.mjs`

검증 항목:
- `TFX_WORKER_INDEX=2`면 `tavily -> exa -> brave-search`
- `TFX_SEARCH_TOOL=exa`면 `exa -> brave-search -> tavily`
- 잘못된 env 값이면 즉시 실패
- wrapper prompt가 새 env 변수를 주입

### 수동 테스트

- 기본:
  - `bash scripts/tfx-route.sh executor 'quota-test' analyze`
- Round-Robin:
  - `TFX_WORKER_INDEX=2 bash scripts/tfx-route.sh executor 'quota-test' analyze`
- Dedicated:
  - `TFX_SEARCH_TOOL=exa bash scripts/tfx-route.sh executor 'quota-test' analyze`

기대 결과:
- stderr에 `worker_index`, `search_tool`가 출력
- prompt 힌트의 검색 우선순위가 의도대로 바뀐다

---

## 8. 후속 로드맵

1. `tfx multi` 또는 Native Teams actual caller에서 워커 생성 시 `workerIndex`를 명시적으로 넘긴다.
2. 팀 스케줄러가 Brave/Tavily/Exa의 최근 실패를 공유 상태로 기억하게 한다.
3. 일정 시간 동안 `429/432/402`가 난 도구는 팀 단위 circuit breaker로 잠시 뒤로 미룬다.
4. vendor key 상태가 안정되면 `TFX_SEARCH_TOOL` 기반 weighted allocation을 도입한다.

---

## 참고 링크

- Brave Search API: https://brave.com/search/api/
- Tavily Search API docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Exa Pricing: https://exa.ai/pricing
