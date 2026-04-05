# tfx-codex 라우팅 분석 — DRY RUN

**요청**: `/tfx-codex API 문서를 작성하고 디자인 가이드도 만들어줘`
**분석 기준 SKILL**: `skills/tfx-workspace/skill-snapshot/tfx-codex/SKILL.md`

---

## 1. 에이전트 리매핑 테이블

이 요청은 두 개의 독립 서브태스크로 분해됩니다:
- 서브태스크 A: "API 문서를 작성" → **writer** 역할
- 서브태스크 B: "디자인 가이드도 만들어줘" → **designer** 역할

| 에이전트 | 원래 CLI (tfx-auto) | tfx-codex에서 | effort 파라미터 | MCP 프로필 |
|----------|---------------------|---------------|-----------------|-----------|
| **writer** | ~~Gemini~~ (`docs` MCP) | **Codex** (effort: spark_fast) — Codex Spark 경량 문서 | `spark_fast` | `analyze` |
| **designer** | ~~Gemini~~ (`docs` MCP) | **Codex** (effort: high) — UI 코드 생성 | `high` | `implement` |

### 원본 tfx-auto 기준 (리매핑 전)

`tfx-auto` SKILL.md의 에이전트 매핑 테이블에서:

```
| gemini / designer / writer | Gemini | docs |
```

즉, 원래 두 역할 모두 Gemini CLI + `docs` MCP로 실행됩니다.

### tfx-codex 기준 (리매핑 후)

`tfx-codex` SKILL.md의 에이전트 라우팅 테이블에서:

```
| designer | ~~Gemini~~ | Codex (effort: high) — UI 코드 생성     | implement |
| writer   | ~~Gemini~~ | Codex Spark (effort: spark_fast) — 경량 문서 | analyze   |
```

---

## 2. TFX_CLI_MODE 환경변수

```
TFX_CLI_MODE=codex
```

이 환경변수는 tfx-route.sh에 전달되어 Gemini 에이전트가 선택될 경우 Codex로 강제 교체하도록 지시합니다. Phase 2 트리아지에서 Codex 분류기가 `gemini`를 반환하더라도 이 값에 의해 `codex`로 교체됩니다.

---

## 3. Phase 2 트리아지 동작

**자동 모드** (`/tfx-codex "API 문서를 작성하고 디자인 가이드도 만들어줘"`):

1. **Codex 분류** (`--full-auto --skip-git-repo-check`):
   - 입력 파싱 결과 예상 JSON:
     ```json
     {
       "parts": [
         { "description": "API 문서 작성", "agent": "gemini" },
         { "description": "디자인 가이드 생성", "agent": "gemini" }
       ]
     }
     ```
   - `TFX_CLI_MODE=codex` 적용 → 두 항목 모두 `"gemini"` → **`"codex"`로 강제 교체**

2. **Opus 인라인 분해** (강제 변환 이후):
   - `writer` 역할: MCP 프로필 `analyze` 할당
   - `designer` 역할: MCP 프로필 `implement` 할당
   - 두 서브태스크는 독립적(INDEPENDENT), `graph_type: "INDEPENDENT"`

3. **서브태스크 수 = 2** → tfx-multi Native Teams 모드로 자동 전환 (tfx-auto 규칙: 2개 이상 시 tfx-multi Phase 3)

---

## 4. 생성되는 Bash 커맨드 (서브태스크별)

서브태스크가 2개이므로 tfx-multi Phase 3a(TeamCreate) → Phase 3b(TaskCreate) → Phase 3c(Agent 래퍼 spawn) 순서로 실행됩니다. 각 Agent 래퍼 내부에서 다음 Bash 커맨드가 실행됩니다:

### 서브태스크 A — writer (API 문서 작성)

```bash
TFX_CLI_MODE=codex bash ~/.claude/scripts/tfx-route.sh writer 'API 문서를 작성해줘' analyze
```

- `writer` 에이전트: Codex Spark (`effort: spark_fast`) 로 실행
- MCP 프로필: `analyze` (문서 기반 리서치+작성)
- `run_in_background=true` (INDEPENDENT 병렬 실행)

### 서브태스크 B — designer (디자인 가이드 생성)

```bash
TFX_CLI_MODE=codex bash ~/.claude/scripts/tfx-route.sh designer '디자인 가이드를 만들어줘' implement
```

- `designer` 에이전트: Codex (`effort: high`) 로 실행
- MCP 프로필: `implement` (코드 기반 UI 작업)
- `run_in_background=true` (INDEPENDENT 병렬 실행)

> 두 서브태스크는 `depends_on` 없이 Level 0에서 병렬 실행됩니다.

---

## 5. MCP 프로필 변화 상세

| 에이전트 | tfx-auto 원본 MCP | tfx-codex 변경 후 MCP | 변경 이유 |
|----------|-------------------|----------------------|----------|
| **writer** | `docs` | `analyze` | Gemini → Codex 전환 시 문서 리서치+작성에 적합한 `analyze` 프로필 사용 |
| **designer** | `docs` | `implement` | Gemini → Codex 전환 시 UI 코드 생성에 적합한 `implement` 프로필 사용 |

원래 `docs` MCP는 Gemini CLI의 웹 검색/문서 접근 기능을 전제로 설계되었습니다. Codex로 리매핑 시 각 역할의 실제 작업 성격에 맞는 프로필로 교체됩니다.

---

## 6. 워크플로우 레퍼런스

**tfx-codex는 tfx-auto SKILL.md의 Phase 1~6 전체를 그대로 따릅니다.**

```
Phase 1: 입력 파싱 — 트리거 `/tfx-codex` 인식, 인자 추출
Phase 2: 트리아지
  - Codex 분류 실행 (TFX_CLI_MODE=codex)
  - gemini 반환값 → codex 강제 교체
  - Opus 인라인 분해 (writer→analyze MCP, designer→implement MCP)
Phase 3: CLI 실행
  - TFX_CLI_MODE=codex 환경변수 포함
  - tfx-route.sh 호출
  - 서브태스크 2개 → tfx-multi Phase 3 전환
Phase 4: 결과 수집
  - exit_code 0: === OUTPUT === 섹션 파싱
  - exit_code 124: === PARTIAL OUTPUT === 사용
  - 그 외: STDERR → Claude fallback
Phase 5: 실패 처리
  - 1차: Claude executor(sonnet) fallback
  - 2차: 실패 보고 + 성공 결과만 종합
Phase 6: 보고 형식 출력
  - 모드/그래프/레벨/서브태스크 상태 테이블
  - Token Savings Report
```

**핵심 차이점 요약**: Phase 2와 Phase 3에서만 동작이 달라집니다.
- Phase 2: gemini 분류 결과를 codex로 강제 변환 + MCP 프로필 재할당
- Phase 3: 모든 tfx-route.sh 호출에 `TFX_CLI_MODE=codex` 접두 추가

---

## 7. 요약

이 요청(`/tfx-codex API 문서를 작성하고 디자인 가이드도 만들어줘`)은 다음과 같이 처리됩니다:

1. 두 서브태스크로 분해 (INDEPENDENT 그래프)
2. 원래 Gemini로 라우팅될 `writer`와 `designer` 모두 Codex로 리매핑
3. MCP 프로필: writer → `analyze`, designer → `implement` (원본 `docs`에서 변경)
4. 서브태스크 2개이므로 tfx-multi Native Teams 모드로 자동 전환하여 병렬 실행
5. 전체 Phase 1~6은 tfx-auto 워크플로우를 그대로 따름
