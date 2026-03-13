# tfx-multi 라우팅 최적화 리서치 보고서

> 날짜: 2026-03-13
> 목적: Claude 토큰 최소화(Opus only) + Codex/Gemini 최대 위임
> 방법: tfx-route.sh 코드 분석 + 4개 Codex 워커 병렬 웹 리서치 (Native Teams)

---

## 1. 라우팅 진단

### 1.1 진단 대상

"tfx-multi에서 웹 서치가 왜 Codex/Gemini를 우선 사용하지 않는가?"

### 1.2 분석 범위

| 파일 | 역할 |
|------|------|
| `scripts/tfx-route.sh` (944줄) | CLI 라우팅 래퍼 — 에이전트→CLI 매핑, MCP 힌트, 타임아웃 |
| `hub/team/native.mjs` (162줄) | Native Teams 래퍼 — 슬림 프롬프트 생성 |
| `hub/workers/codex-mcp.mjs` (414줄) | Codex MCP transport — `codex mcp-server` stdio 연결 |
| `~/.claude/cache/mcp-inventory.json` | MCP 서버 가용 상태 캐시 |
| `~/.codex/config.toml` | Codex CLI 프로필/모델/MCP 서버 설정 |

### 1.3 핵심 결론: 3-레이어 문제

| 레이어 | 이슈 | 심각도 |
|--------|------|--------|
| **Lead 행동** | Claude Opus가 brave-search/exa/tavily에 직접 접근 가능 → 리서치를 위임 안 하고 자기가 검색 | **높음** |
| **Codex 프로필** | `CLI_EFFORT="high"` → `--profile high` → config.toml에 없음 → MCP transport 실패 → exec fallback | **중간** |
| **Gemini 필터** | `get_gemini_mcp_servers("analyze")`에 tavily 누락 → 힌트와 실제 접근 불일치 | **낮음** |
| **API 경합** | 4개 병렬 워커가 brave-search/exa/tavily quota 동시 소진 | **낮음** |

### 1.4 실증 테스트 결과

4개 Codex 워커를 Native Teams로 병렬 실행:

| Worker | CLI | 역할 | 웹 서치 | 결과 |
|--------|-----|------|---------|------|
| codex-scientist-1 | codex | scientist | brave ✓ exa/tavily ✗(rate limit) | 풍부 |
| codex-scientist-2 | codex | scientist | brave ✓ | 풍부 |
| codex-scientist-3 | codex | scientist | ✓ | 풍부 |
| codex-scientist-4 | codex | scientist-deep | ✓ | 매우 풍부 |

**결론:** `route_agent()` → Codex → 웹 서치 MCP 파이프라인 정상 작동. Lead 행동과 설정 버그가 원인.

### 1.5 수정 완료

**A. Codex `high` 프로필 추가** (`~/.codex/config.toml`)
```toml
[profiles.high]
model = "gpt-5.4"
model_reasoning_effort = "high"

[profiles.xhigh]
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
```
- fast/normal/thorough/spark_* → gpt-5.3-codex 유지 (코딩 특화)
- high/xhigh → gpt-5.4 (프론티어, 복잡 분석/설계)

**B. Gemini analyze 필터에 tavily 추가** (`tfx-route.sh` 소스 + 배포본)
```bash
# before
analyze)    echo "context7 brave-search exa" ;;
# after
analyze)    echo "context7 brave-search exa tavily" ;;
```

**C. SKILL.md Lead 행동 제어** (`tfx-multi/SKILL.md`)
```
> [필수] Lead 웹 서치 직접 사용 금지
> Lead(Claude Opus)는 brave-search, exa, tavily 등 웹 서치 MCP 도구를 직접 호출하지 마라.
> 리서치/검색 태스크는 반드시 scientist 또는 document-specialist 역할의 Codex 워커에 위임하라.
```

---

## 2. 멀티모델 MCP 오케스트레이션 (Topic 1)

### 2.1 아키텍처 패턴

| 패턴 | 설명 | 대표 프로젝트 |
|------|------|-------------|
| **Hub-Spoke** | Claude Code(Hub) → MCP → 외부 모델 서버 | Zen MCP, PAL-MCP |
| **Peer-to-Peer** | 공유 MCP 서버 경유 간접 통신 | claude-flow |
| **CLI Subprocess** | Bash → codex exec / gemini -y -p | triflux, OMC |
| **Consensus** | 다중 모델 결과 → 합의 알고리즘 통합 | PAL-MCP, Claude Octopus |

### 2.2 주요 프로젝트

| 프로젝트 | 핵심 메커니즘 | triflux 관련도 |
|---------|-------------|--------------|
| **Zen MCP Server** (BeehiveInnovations) | 단일 MCP에서 Claude/Gemini/O3 멀티 호출 | 높음 |
| **PAL-MCP-Server** | `clink with codex`, `consensus with gpt-5 and gemini-pro` | 높음 |
| **claude-gemini-mcp-slim** (cmdaltctr) | 경량 MCP 플러그인, 컨텍스트 98% 절약 | 높음 |
| **AWS CAO** (awslabs/cli-agent-orchestrator) | tmux + MCP 로컬 통신, AWS 공식 | 높음 |
| **claude-flow** (ruvnet) | DAG 기반 작업 의존성 + LMDB/SQLite 공유 메모리 | 중간 |
| **claude-squad** | git worktree + tmux 병렬 격리 | 참고 |
| **SPARC** | 5단계 구조화 개발 + Boomerang 패턴 | 참고 |

### 2.3 인터럽트 프로토콜 비교

| 프로토콜 | 지연 | 양방향 | 인터럽트 | 사용처 |
|---------|------|--------|---------|-------|
| stdio JSON-RPC | 매우 낮음 | ✓ | `notifications/cancelled` | MCP 기본 |
| SSE | 낮음 | 서버→클라 | 연결 종료 | MCP HTTP |
| Streamable HTTP | 낮음 | ✓ | 요청 취소 | MCP 최신 |
| 파일 시스템 | 높음 | 폴링 | 감시 파일 | OMC, triflux |
| tmux IPC | 중간 | ✓ | send-keys | claude-squad, CAO |

### 2.4 핵심 인사이트

- MCP가 멀티모델 통합의 사실상 표준 (Claude/Codex/Gemini 모두 지원)
- Server-to-Server 직접 통신은 MCP 스펙 미지원 → Composite Server/Gateway로 우회
- `notifications/cancelled`이 유일한 MCP 내장 인터럽트
- tmux 기반 격리가 주류 (claude-squad, CAO, OMC)

---

## 3. Claude Hooks MCP Skills (Topic 2)

### 3.1 Hook 이벤트 체계

| 이벤트 | 시점 | 핵심 용도 |
|--------|------|----------|
| PreToolUse | 도구 실행 전 | 검증/차단/컨텍스트 주입 |
| PostToolUse | 도구 실행 후 | 로깅/후처리 |
| SessionStart | 세션 시작 | 환경 부트스트랩 |
| Stop | 응답 완료 | 자동 검증/후속 트리거 |
| Notification | 알림 시 | 외부 연동 |

### 3.2 주요 프로젝트

| 프로젝트 | 핵심 가치 |
|---------|----------|
| **claude-plugins.dev** | 6,000+ 스킬 인덱싱, 매시간 GitHub 크롤링 |
| **claude-flow** (ruvnet) | Hook lifecycle 관리 + 에이전트 자동 할당 |
| **claude-code-infrastructure-showcase** (diet103) | 프로덕션 인프라 참조 라이브러리 |
| **Code Assistant Manager** (Chat2AnyLLM) | 멀티 어시스턴트 플러그인 매니저 |
| **oh-my-opencode** | Claude SKILL.md/Hook을 OpenCode에 이식 |
| **Anthropic 공식 플러그인** | 28개 공식 플러그인 |

### 3.3 MCP 도구 매칭 패턴

```json
{ "matcher": "mcp__figma__.*", "hooks": [{ "command": "figma-guard.sh" }] }
```

### 3.4 알려진 한계

- PostToolUse stdout이 컨텍스트에 직접 주입 안 됨 (#18427)
- 서브디렉토리 실행 시 hook 미작동 (#10367)
- `approve: false` 반환 시 도구 차단 불완전 (#4362)

### 3.5 핵심 인사이트

- Hook = 결정론적 가드레일 (CLAUDE.md는 LLM이 무시 가능, Hook은 코드 레벨 강제)
- 크로스 플랫폼 이식성 진행 중 (oh-my-opencode, opencode-skills)
- 스킬 생태계 폭발: 6,000+ 커뮤니티 스킬

---

## 4. 세션 핸드오프 패턴 (Topic 3)

### 4.1 핸드오프 프레임워크 비교

| 프레임워크 | 핸드오프 방식 | 상태 관리 | 특징 |
|-----------|-------------|----------|------|
| **OpenAI Agents SDK** | Handoff-as-Tool, 대화 이력 전체 전달 | 인메모리 | ~30줄로 triage 시스템 |
| **Google ADK** | A2A 프로토콜, Agent Card 등록 | session.state | 양방향 스트리밍 |
| **AWS CAO** | Handoff(동기)/Assign(비동기)/Send | 로컬 MCP | 완전 로컬 실행 |
| **LangGraph** | DAG + checkpointing | 그래프 state | 실행 일시중지→재개 |
| **CrewAI** | 역할 기반 Sequential/Hierarchical | 세션 메모리 | 빠른 구축 |
| **Claude Agent SDK** | stdin/stdout JSON-lines subprocess | subprocess | MCP 서버 lifecycle 관리 |

### 4.2 AWS CAO 3종 패턴

```
Handoff (동기): supervisor가 완료 대기
Assign (비동기): supervisor가 위임 후 다음 작업 진행
Send Message: 상태 확인만 (비차단)
```

### 4.3 MCP 기반 컨텍스트 전달 (arXiv 2504.21030)

4종 메모리 표준 인터페이스:
- Episodic: 상호작용 기록
- Semantic: 개념적 지식
- Procedural: 행동 시퀀스
- Working: 태스크 관련 정보

### 4.4 핵심 인사이트

- Google A2A 프로토콜이 프레임워크 독립적 에이전트 통신 표준으로 부상
- 에이전트 로직과 오케스트레이션 분리가 핵심 원칙
- 장기 상태는 외부 관리 (MCP = 전송/집행만, 영속성은 별도)

---

## 5. 토큰 절약 프로젝트 (Topic 4)

### 5.1 컨텍스트 압축 MCP

> **주의**: 아래 절감률은 각 프로젝트 README/마케팅 자료의 자체 주장이며, 독립 벤치마크로 검증되지 않았다.
> 측정 조건(작업 유형, 베이스라인, 코드베이스 규모)이 명시되지 않은 수치는 참고용으로만 활용할 것.

| 프로젝트 | 절감률 (자체 주장, 미검증) | 핵심 메커니즘 |
|---------|--------------------------|-------------|
| **Context Mode** (mksglu) | 98% | MCP 출력을 FTS5 샌드박스에 가상화, PreToolUse 훅 연동 |
| **Headroom** (chopratejas) | 40-90% | ML 라우터로 데이터 유형별 최적 압축 자동 선택 |
| **Context Engine** (Context-Engine-AI) | 75%+ | batch_search/batch_symbol_graph로 배치 쿼리 |
| **Token Optimizer** (ooples) | 95%+ | 캐싱 + 압축 + 스마트 도구 인텔리전스 |
| **Codebase Memory** (DeusData) | 99.2% | Go 단일 바이너리, 코드베이스 지식 그래프, 64개 언어 |
| **Code Review Graph** (tirth8205) | 6.8-49x | Tree-sitter 증분 분석, 변경 사항만 추적 |

### 5.2 Codex/Gemini 위임 패턴

| 프로젝트 | 핵심 메커니즘 |
|---------|-------------|
| **Claude Delegator** (jarrodwatts) | Claude→Codex/Gemini MCP 직접 위임, 자동 CLI 감지 |
| **Claude Octopus** (nyldn) | 멀티모델 적대적 리뷰 + 합의 게이트 |
| **Claude Code Bridge** (bfly123) | 데몬 기반 실시간 멀티AI 병렬, 유휴 시 자동 종료 |
| **MetaSwarm** (dsifry) | 18 에이전트, 13 스킬, TDD 강제 + 품질 게이트 |

### 5.3 동적 도구 로딩

| 프로젝트 | 절감률 (자체 주장, 미검증) | 방식 |
|---------|--------------------------|------|
| **Speakeasy Gram** (speakeasy-api) | 160x | 시맨틱 검색으로 필요한 도구만 동적 발견 |
| **Claude Code Tool Search** (내장) | 46.9% | deferred tools, 51K→8.5K 토큰 |

### 5.4 비용 추적/모니터링

| 도구 | 특징 |
|------|------|
| **TokTrack** (mag123c) | Claude/Codex/Gemini 통합 추적 |
| **Langfuse** | 가장 인기 있는 오픈소스 LLM 관측성 |
| **LiteLLM** | 100+ LLM 프록시 + 비용 추적 + 시맨틱 캐싱 |

### 5.5 즉시 설치 가능 확인

| 도구 | 설치 명령 | 난이도 |
|------|---------|--------|
| Context Mode | `/plugin marketplace add mksglu/context-mode` | 쉬움 |
| Codebase Memory | `irm https://...setup-windows.ps1 \| iex` | 보통 |
| TokTrack | `npx toktrack` | 매우 쉬움 |

---

## 6. 액션 아이템

### 완료

| # | 항목 | 검증 |
|---|------|------|
| 1 | Gemini analyze 필터에 tavily 추가 | `git diff` 확인: `tfx-route.sh` 1줄 변경 |
| 2 | SKILL.md Lead 웹서치 직접사용 금지 | `skills/tfx-multi/SKILL.md`에 규칙 추가 |
| 3 | `setup.mjs`에 `high` 프로필 추가 + `xhigh` gpt-5.4 동기화 | `scripts/setup.mjs` 수정 |

> **참고**: `~/.codex/config.toml` 수동 변경은 `tfx setup` 재실행 시 `setup.mjs`의 정의로 덮어써짐.
> 프로필 변경은 반드시 `setup.mjs`의 `REQUIRED_CODEX_PROFILES`를 truth source로 관리할 것.

### 즉시 적용 권장

| # | 항목 | 효과 | 난이도 |
|---|------|------|--------|
| 5 | Context Mode MCP 설치 | 98% 토큰 절감 | 쉬움 |
| 6 | Codebase Memory MCP 설치 | 99.2% 탐색 절감 | 보통 |
| 7 | TokTrack 설치 | 멀티CLI 비용 가시성 | 매우 쉬움 |

### 중기 (핸드오프 문서 참조)

| # | 항목 | 우선순위 |
|---|------|---------|
| 8 | Claude Delegator 패턴 확장 | 1 (최상) |
| 9 | AWS CAO 3종 패턴 적용 | 2 |
| 10 | Speakeasy Gram 동적 도구 로딩 | 3 |
| 11 | Google A2A 프로토콜 검토 | 4 |
| 12 | 병렬 워커 API quota 분배 전략 | 5 |
