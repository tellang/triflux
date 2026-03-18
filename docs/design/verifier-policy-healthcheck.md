# Verifier 정책 유연화 + Health Check 최적화 설계

작성일: 2026-03-13
범위: `scripts/tfx-route.sh`, `hub/workers/gemini-worker.mjs`, `hub/team/native.mjs`, `hub/workers/delegator-mcp.mjs`, 관련 테스트/문서

## 1. 요약

- 현재 `verifier`의 기본 라우트는 `codex review + thorough`다.
- 하지만 `TFX_CLI_MODE=gemini`가 걸리면 `verifier`도 다른 Codex 역할과 같이 Gemini로 리매핑되며, 현재 분기상 `gemini-3-flash-preview`로 떨어진다.
- 이 동작은 문서/스킬 일부와도 어긋나고, reviewer 역할의 품질 정책이 Gemini 모드에서 조용히 약화되는 문제가 있다.
- 또한 Gemini health check는 지금 `legacy` 경로에만 있는 “조기 silent exit 감지 + 1회 재시도” 수준이며, stream worker 경로와 quota/429 계열 실패는 별도로 다루지 못한다.
- `try_restart_hub()`는 `claim` 단계에만 적용되어 있고, 완료 보고/결과 발행 단계의 회복력은 불균등하다.

이 문서는 다음 3가지를 설계한다.

1. `TFX_VERIFIER_OVERRIDE=claude`로 Gemini 모드에서도 verifier만 Claude 계열로 유지하는 정책
2. Gemini startup health check를 공통 정책으로 끌어올리고, 재시도 횟수/간격을 벤치마크 기준으로 튜닝하는 가이드
3. `try_restart_hub()` 적용 범위를 무조건 확대하지 않고, no-fallback 경로를 우선 보강하는 설계

## 2. 현재 상태

### 2.1 라우팅

- `scripts/tfx-route.sh`의 route table에서 `verifier`는 기본적으로 `codex exec --profile thorough ... review`다.
- `apply_cli_mode()`는 `TFX_CLI_MODE=gemini`일 때 모든 Codex 역할을 Gemini로 리매핑한다.
- 이때 `verifier`는 Pro 집합에 포함되어 있지 않아 wildcard 분기로 내려가므로 현재 사실상 `gemini-3-flash-preview`가 된다.
- 반면 `explore`, `test-engineer`, `qa-tester`는 원래 `claude-native`라서 Gemini 모드에서도 유지된다.

정리:

| 조건 | 현재 verifier 결과 |
|------|---------------------|
| 기본 (`TFX_CLI_MODE=auto`) | Codex review / thorough |
| `TFX_CLI_MODE=codex` | Codex review / thorough |
| `TFX_CLI_MODE=gemini` | Gemini Flash |
| `TFX_NO_CLAUDE_NATIVE=1` | 영향 없음. verifier는 애초에 claude-native가 아니기 때문 |

핵심 문제:

- Gemini 모드에서만 verifier 품질/도구 정책이 조용히 바뀐다.
- reviewer 프로필은 `context7`, `brave-search`, `sequential-thinking` 중심의 더 좁은 도구 표면을 갖는데, provider가 바뀌면 사용감과 신뢰도가 달라진다.

### 2.2 Gemini health check

현재 `run_legacy_gemini()`의 health check 특성:

- probe 간격: `1, 2, 3, 5, 8`초
- 동작: stdout/stderr가 생기면 통과
- 실패 판정: “출력 없이 프로세스가 종료됨”
- 재시도: 1회

제약:

- `legacy` 경로에만 있다.
- stream worker 경로(`hub/workers/gemini-worker.mjs`)에는 같은 정책이 없다.
- “프로세스는 살아 있으나 장시간 출력이 없는 stall”은 실패로 보지 않는다.
- `429`, `RESOURCE_EXHAUSTED`, `requests_per_model_per_day`, `limit: 0` 같은 quota 실패와 조기 크래시를 분리하지 않는다.

### 2.3 Hub restart

현재 `try_restart_hub()`는 `team_claim_task()`에서만 호출된다.

- 첫 claim 실패 시 Hub를 재시작해 보고 claim을 1회 더 시도한다.
- `team_send_message()`와 `team_complete_task()` 내부에는 같은 재시작 훅이 없다.
- 단, `hub/bridge.mjs` 기준으로 `team-task-update`, `team-send-message`는 nativeProxy fallback이 이미 있다.
- 반면 `result` 발행은 fallback이 없다.

즉, 지금 구조는 “claim 단계만 적극 복구”이고 “완료/결과 단계는 경로별 내구성이 제각각”이다.

## 3. 목표와 비목표

### 3.1 목표

- 기본 동작을 보존하면서 verifier만 선택적으로 예외 처리한다.
- Gemini 모드에서도 verifier 정책을 명시적으로 유지할 수 있게 한다.
- verifier override가 팀 래퍼, delegator, 직접 실행 경로에서 일관되게 동작하게 한다.
- Gemini startup 실패를 `silent exit / silent stall / quota`로 구분한다.
- 재시도는 “더 많이”가 아니라 “실패 클래스별로 다르게” 적용한다.
- Hub restart는 no-fallback 경로를 우선 보강한다.

### 3.2 비목표

- 전 provider 공통 circuit breaker 구현
- 검색 도구 전체의 글로벌 quota 조정기 구현
- Claude native 팀 실행 모델의 전면 재설계

## 4. 제안 1: `TFX_VERIFIER_OVERRIDE=claude`

### 4.1 환경변수 계약

신규 환경변수:

```bash
TFX_VERIFIER_OVERRIDE=auto|claude
```

초기 안정 범위는 두 값만 지원한다.

- `auto` (기본값): 현재 동작 유지
- `claude`: `AGENT_TYPE=verifier`일 때 provider 정책을 Claude로 고정

왜 값이 `claude-native`가 아니라 `claude`인가:

- 라우팅 의도는 “verifier를 Claude 계열로 유지”하는 것이다.
- 실제 실행은 기존 구조상 상황에 따라 달라진다.
  - 대화형/메타데이터 경로: `claude-native`
  - 팀 non-TTY 경로: 기존 로직에 따라 `claude` stream wrapper로 전환
- 따라서 override 이름은 provider 의도를 표현하는 `claude`가 더 정확하다.

### 4.2 precedence

권장 precedence:

1. `route_agent()`
2. `apply_cli_mode()`
3. `apply_no_claude_native_mode()`
4. `apply_verifier_override()`

이 순서를 권장하는 이유:

- `TFX_CLI_MODE=gemini`가 verifier를 Gemini로 바꾼 뒤에도 `TFX_VERIFIER_OVERRIDE=claude`가 최종 우선권을 가져야 한다.
- `TFX_NO_CLAUDE_NATIVE=1`보다 verifier 전용 override가 더 구체적이므로 마지막에 덮는 편이 자연스럽다.

### 4.3 동작 매트릭스

| 조건 | `TFX_VERIFIER_OVERRIDE=auto` | `TFX_VERIFIER_OVERRIDE=claude` |
|------|-------------------------------|---------------------------------|
| `TFX_CLI_MODE=auto` | Codex review / thorough | Claude 계열 유지 |
| `TFX_CLI_MODE=codex` | Codex review / thorough | Claude 계열 유지 |
| `TFX_CLI_MODE=gemini` | Gemini Flash | Claude 계열 유지 |
| 팀 non-TTY | 기존 라우트 유지 | `claude-native`로 라우팅 후 기존 stream wrapper 전환 허용 |

주의:

- `claude` override는 `verifier`에만 적용한다.
- `explore`, `test-engineer`, `qa-tester`의 기존 `claude-native` 정책은 그대로 둔다.
- reviewer용 MCP profile은 그대로 `reviewer`를 사용한다.

### 4.4 구현 위치

#### `scripts/tfx-route.sh`

추가:

- `TFX_VERIFIER_OVERRIDE="${TFX_VERIFIER_OVERRIDE:-auto}"`
- 유효성 검증: `auto|claude`
- `apply_verifier_override()` 신설
- 메타로그에 `verifier_override=...` 추가

의사코드:

```bash
apply_verifier_override() {
  [[ "$AGENT_TYPE" != "verifier" ]] && return

  case "$TFX_VERIFIER_OVERRIDE" in
    auto|"")
      return
      ;;
    claude)
      ORIGINAL_AGENT="${ORIGINAL_AGENT:-$AGENT_TYPE}"
      CLI_TYPE="claude-native"
      CLI_CMD=""
      CLI_ARGS=""
      CLI_EFFORT="n/a"
      DEFAULT_TIMEOUT=1200
      RUN_MODE="fg"
      OPUS_OVERSIGHT="false"
      echo "[tfx-route] TFX_VERIFIER_OVERRIDE=claude: verifier -> claude-native" >&2
      ;;
  esac
}
```

#### `hub/team/native.mjs`

`buildRouteEnvPrefix()`에 optional `verifierOverride` 인자를 추가한다.

- 역할이 `verifier`일 때만 `TFX_VERIFIER_OVERRIDE`를 prefix에 넣는다.
- 다른 역할에는 넣지 않아도 되지만, 구현 단순화를 위해 항상 넣어도 무해하다.

#### `hub/workers/delegator-mcp.mjs`

`DelegateInputSchema`에 추가:

```ts
verifierOverride: z.enum(['auto', 'claude']).optional()
```

`_buildRouteEnv()`에서 `env.TFX_VERIFIER_OVERRIDE` 주입.

### 4.5 기대 효과

- `$tfx-gemini`나 `provider=gemini` 팀 실행에서 reviewer 정책만 따로 고정할 수 있다.
- Gemini quota가 불안정할 때 verifier를 Claude로 고정해 reviewer lane을 분리할 수 있다.
- 현재 문서/스킬의 기대와 실제 코드를 다시 맞출 수 있다.

### 4.6 구현 가이드 및 시나리오 명세

#### 1. 환경변수 파싱 및 검증
- **파싱 로직**: `TFX_VERIFIER_OVERRIDE` 값을 읽을 때 대소문자를 무시하도록 소문자 변환 후 검증.
- **기본값 Fallback**: 허용되지 않은 값(예: `gpt`, 빈 문자열 등)이 들어오면 경고 로그 출력 후 `auto`로 fallback.

#### 2. 예외 및 Fallback 로직
- **`claude` 지정 시 Fallback**: 만약 `TFX_VERIFIER_OVERRIDE=claude`가 지정되었으나 Claude 실행 환경(CLI 혹은 인증)이 정상적이지 않은 경우, Hub 차원에서 Health Check 실패로 간주하고 기존 `auto`(해당 시점 모델)로 조용히 downgrade하여 리뷰 파이프라인의 블로킹을 방지.

#### 3. 테스트 시나리오
- **시나리오 A (Normal Override)**: 
  - 설정: `TFX_CLI_MODE=gemini`, `TFX_VERIFIER_OVERRIDE=claude`, `AGENT_TYPE=verifier`
  - 기대결과: 라우팅 결과가 `claude-native`가 되며, 다른 agent는 `gemini`로 라우팅됨.
- **시나리오 B (Invalid Override)**:
  - 설정: `TFX_VERIFIER_OVERRIDE=unknown_value`, `AGENT_TYPE=verifier`
  - 기대결과: Warning 출력 후 현재 기본 모델(`auto` 정책) 유지.
- **시나리오 C (Non-Verifier Exclusion)**:
  - 설정: `TFX_VERIFIER_OVERRIDE=claude`, `AGENT_TYPE=coder`
  - 기대결과: override 무시됨. coder는 현재 CLI 모드(예: Gemini)를 따름.

## 5. 제안 2: Gemini Health Check 공통화

### 5.1 설계 원칙

현재 health check는 “조기 silent exit 감지”에만 치우쳐 있다. 이를 다음 3종 실패 클래스로 나눈다.

1. `silent_exit`
   - 출력 없이 프로세스가 조기 종료
2. `silent_stall`
   - 프로세스는 살아 있으나 startup grace 내에 아무 출력도 없음
3. `quota_or_rate_limit`
   - stderr / error event에 `429`, `RESOURCE_EXHAUSTED`, `quota`, `requests_per_model_per_day`, `limit: 0` 등이 감지됨

이 분류를 `legacy`와 `stream worker`에 공통 적용하는 것이 목표다.

### 5.2 구현 방향

권장안:

- startup probe 정책의 소스 오브 truth를 `hub/workers/gemini-worker.mjs` 쪽으로 올린다.
- `run_legacy_gemini()`는 가능한 한 같은 판정 규칙을 재사용한다.
- `tfx-route.sh`가 stream worker를 우선 사용하므로, 공통화가 `legacy`에만 남으면 체감 효과가 작다.

권장 구조:

```text
GeminiStartupPolicy
  - probe checkpoints
  - classify failure(stderr/events/exit)
  - retry budget by class
```

최소 구현 단위:

- `gemini-worker.mjs`에 startup-first-output probe 추가
- `run_legacy_gemini()`는 같은 상수/판정 함수 사용
- error text 분류기 추가

### 5.3 초기 권장 정책

#### startup probe

기본 checkpoint 권장값:

- `1s, 3s, 6s, 10s, 15s`

의미:

- 빠른 crash는 첫 1~3초 구간에서 잡는다.
- healthy but slow startup는 10초 안쪽에서 흡수한다.
- 15초가 넘어가도 출력이 없으면 startup stall로 보고 kill + retry 후보로 본다.

현재값 `1, 3, 6, 11, 19`보다 나은 점:

- 9초 전후 first output을 더 짧게 흡수한다.
- no-output tail을 19초에서 15초로 줄인다.

#### retry budget

권장 초기값:

- `silent_exit`: 2회 재시도
- `silent_stall`: 1회 재시도
- `quota_or_rate_limit`:
  - transient `429` / 일반 `RESOURCE_EXHAUSTED`: 1회 지연 재시도
  - `requests_per_model_per_day`, `limit: 0`, 일일 quota/preview hard cap 시그니처: 재시도 0회

#### quota retry backoff

권장 초기값:

- transient quota 재시도 대기: `15s`
- hard quota 시그니처: 즉시 실패

이렇게 분기하는 이유:

- Google 공식 문서 기준 Gemini API rate limit은 프로젝트 단위로 걸리고, 일일 quota는 태평양 시간 자정에 리셋된다.
- Preview/experimental 계열은 더 제한적일 수 있으므로, hard quota 상태에서 즉시 재시도해도 회복 가능성이 낮다.

### 5.4 짧은 fixture baseline

`fake-gemini-cli.mjs`로 확인한 현재 구현의 baseline:

- `FAKE_GEMINI_DELAY_MS=9000` healthy startup: 총 elapsed 약 `11s`
- `FAKE_GEMINI_SILENT_CRASH=1`: 실패 surface 약 `2s`

해석:

- 현재 정책은 “빠른 silent crash”에는 나쁘지 않다.
- 하지만 9초 전후 지연 startup은 다음 checkpoint까지 기다리므로 tail이 길다.
- 더 중요한 문제는 silent stall과 quota를 분리하지 못한다는 점이다.

### 5.5 벤치마크 기반 튜닝 가이드

튜닝은 다음 4종 데이터를 분리 수집해야 한다.

1. Healthy cold start TTFB
2. Healthy warm start TTFB
3. Silent exit recovery latency
4. Quota error classification accuracy

권장 절차:

1. 100회 이상 실행해 `first_output_ms` histogram 수집
2. checkpoint 마지막 값은 healthy p99 + 1초 이상으로 둔다
3. `silent_exit` 재시도 총 penalty는 10초 이내를 목표로 둔다
4. hard quota 시그니처는 false positive 0%를 우선한다

권장 추가 fixture:

- `FAKE_GEMINI_NO_OUTPUT_HANG_MS`
- `FAKE_GEMINI_STDERR_TEXT`
- `FAKE_GEMINI_RESULT_EVENT_ERROR`

검증 포인트:

- 9~10초 startup이 false kill되지 않아야 한다
- no-output hang는 15초 내 restart되어야 한다
- `requests_per_model_per_day`는 retry 없이 종료되어야 한다
- 일반 `429 RESOURCE_EXHAUSTED`는 1회만 delay retry해야 한다

## 6. 제안 3: `try_restart_hub()` 확장 범위

### 6.1 현재 평가

`try_restart_hub()`는 지금 `claim` 경로에만 직접 적용된다. 이것을 모든 bridge 호출에 기계적으로 붙이는 것은 권장하지 않는다.

이유:

- `team-task-update`, `team-send-message`는 이미 `hub/bridge.mjs`에서 nativeProxy fallback이 있다.
- 여기에 다시 restart를 무차별로 붙이면 sleep/wake 직후 다수 워커가 동시에 Hub 재시작을 시도할 수 있다.
- 완료 보고와 메시지는 중복 가능성이 있어, 재시도/재시작이 곧바로 duplicate side effect가 되기 쉽다.

### 6.2 적용 우선순위

| 지점 | 현재 fallback | restart 권장 여부 | 판단 |
|------|---------------|-------------------|------|
| `team_claim_task()` | 제한적 | 유지 | startup 일관성에 직접 영향 |
| `team_complete_task()` 내 `team-task-update` | nativeProxy 있음 | 기본 no | 우선은 bridge fallback을 신뢰 |
| `team_send_message()` | nativeProxy 있음 | 기본 no | 낮은 중요도, 중복 메시지 위험 |
| `team_complete_task()` 내 `result` 발행 | 없음 | yes | 현재 가장 취약한 no-fallback 경로 |
| `register_agent()` | 없음 | phase 2 | 운영상 중요하지만 현재 직접 장애가 적음 |

### 6.3 권장안

Phase 1:

- `team_claim_task()`의 현재 restart 유지
- `bridge_cli result` 실패 시에만 `try_restart_hub()` 후 1회 재발행
- `team-task-update`, `team-send-message`는 우선 현행 유지

Phase 2:

- `bridge_cli_with_recovery(op_class, ...)` 래퍼 도입
- `op_class=no_fallback`일 때만 restart 허용
- 워커당 1회, 또는 프로세스당 cooldown을 둬서 restart storm 방지

### 6.4 권장 래퍼 계약

예시:

```bash
bridge_cli_with_recovery() {
  local op_class="$1"
  shift

  local response
  response=$(bridge_cli "$@" || true)
  if [[ -n "$response" ]]; then
    printf '%s\n' "$response"
    return 0
  fi

  [[ "$op_class" != "no_fallback" ]] && return 1
  try_restart_hub || return 1
  bridge_cli "$@" || return 1
}
```

적용 대상:

- `result`
- 필요 시 `register`

적용 보류:

- `team-send-message`
- `team-task-update`

## 7. 테스트 계획

### 7.1 라우팅

- `tests/integration/tfx-route-smoke.test.mjs`
  - `TFX_VERIFIER_OVERRIDE=claude + TFX_CLI_MODE=gemini`에서 `ROUTE_TYPE=claude-native`
  - `TFX_VERIFIER_OVERRIDE=auto`면 기존 동작 유지
- `tests/integration/gemini.test.mjs`
  - verifier가 Gemini 모드에서도 override 시 Claude 계열 유지
- `tests/unit/native-wrapper.test.mjs` 또는 동등 테스트
  - wrapper prompt/env prefix에 `TFX_VERIFIER_OVERRIDE` 전파
- `tests/integration/delegator-mcp.test.mjs`
  - delegator route env에 `TFX_VERIFIER_OVERRIDE` 반영

### 7.2 Gemini health

- `silent_exit`: 2회 재시도 후 실패/성공 분기 검증
- `silent_stall`: startup grace 초과 시 kill + retry 검증
- `quota_or_rate_limit`:
  - transient 429는 1회만 재시도
  - daily quota 시그니처는 즉시 실패

### 7.3 Hub recovery

- `tests/integration/hub-restart.test.mjs`
  - `result` publish 실패 시 restart 후 재발행 성공
- `tests/pipeline/bridge-fallback.test.mjs`
  - `team-task-update`, `team-send-message`는 기존 nativeProxy fallback이 유지됨을 재확인

## 8. 롤아웃 순서

1. `TFX_VERIFIER_OVERRIDE=auto|claude` 도입
2. 팀/native/delegator env 전파
3. verifier 관련 테스트 추가
4. Gemini startup policy를 `gemini-worker.mjs`에 먼저 도입
5. `run_legacy_gemini()`를 같은 policy로 정렬
6. `result` publish에만 `try_restart_hub()` 확장
7. README/skill 문서 정리

## 9. 결정

권장 결정은 다음과 같다.

- 기본 동작은 유지한다.
- 다만 Gemini 모드에서 reviewer lane을 분리해야 하는 운영 환경을 위해 `TFX_VERIFIER_OVERRIDE=claude`를 도입한다.
- 이 override는 `apply_cli_mode()`보다 나중, `apply_no_claude_native_mode()`보다도 나중에 적용한다.
- Gemini health check는 legacy 전용 shell 로직이 아니라 `GeminiWorker` 중심의 공통 startup policy로 옮긴다.
- `try_restart_hub()`는 blanket 확대가 아니라 `result` 같은 no-fallback 경로부터 확장한다.

이 설계는 “provider를 많이 바꾸는 것”보다 “reviewer lane만 명시적으로 분리하는 것”에 초점을 둔다. 현재 코드와 운영 현실을 함께 보면, 이것이 가장 작은 변경으로 가장 큰 예측 가능성을 주는 방향이다.

## 10. 참고 자료

외부 문서:

- Google AI for Developers, Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Anthropic, Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview

내부 코드/문서:

- `scripts/tfx-route.sh`
- `hub/workers/gemini-worker.mjs`
- `hub/bridge.mjs`
- `hub/team/native.mjs`
- `hub/workers/delegator-mcp.mjs`
- `scripts/lib/mcp-filter.mjs`
- `docs/internal/gemini-rate-limits-429.md`
- `docs/research-2026-03-13-parallel-worker-quota-strategy.md`
