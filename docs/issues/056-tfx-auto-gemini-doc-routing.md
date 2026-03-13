# #56 tfx-auto 문서작업 Gemini 라우팅 정책 명확화

> 등록: 2026-03-13
> 상태: open
> 분류: design
> 심각도: low
> 관련: skills/tfx-auto/SKILL.md, scripts/tfx-route.sh

## 질문

tfx-auto에서 문서작업이 Gemini에 정확히 할당되고 있는가?

## 현재 정의

SKILL.md 기준 Gemini 직행 커맨드:

| 커맨드 | 에이전트 | MCP |
|--------|---------|-----|
| `explain` | writer | docs |
| `document` | writer | docs |

에이전트 매핑 테이블:

| 입력 | CLI | MCP |
|------|-----|-----|
| gemini / designer / writer | Gemini | docs |

## 잠재 문제

1. **자동 모드 트리아지**: Codex 분류 결과에서 `agent: "gemini"`이 나올 때만 Gemini로 라우팅됨.
   Codex가 문서 작업을 `codex`로 분류하면 Gemini에 안 감
2. **커맨드 숏컷 외의 경우**: `document`/`explain` 숏컷은 Gemini 직행이지만,
   자동 분해된 서브태스크 중 문서 작업은 Opus 분해 결과의 `agent` 필드에 의존
3. **Opus 분해 프롬프트**에 "문서/UI 작업은 gemini로 라우팅" 지시가 명시되어 있는지 확인 필요

## 조사 필요

- [ ] Opus 인라인 분해 프롬프트에서 에이전트 라우팅 힌트 확인
- [ ] Codex 분류 프롬프트에서 gemini 라우팅 조건 확인
- [ ] 실제 자동 모드에서 문서 서브태스크가 gemini로 분배되는지 테스트

## 해결 방향

- Opus 분해 프롬프트에 명시적 라우팅 규칙 추가: "writer/designer → gemini"
- 또는 에이전트명 기반 자동 매핑으로 Opus에 라우팅 책임을 넘기지 않음
