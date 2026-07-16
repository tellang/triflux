# docs 컨벤션 (살아있는 규칙)

> 근거·왜는 [ADR-0002](0002-doc-and-devflow-architecture.md). 이 문서는 **어떻게**(가변 규칙)다. 규칙이 바뀌면 여기를 고치고 ADR은 건드리지 않는다.
> 원칙: 발명하지 말고 얼라인한다. 네이밍/폴더는 SHOULD, 아래 **MUST 3개**만 강제.

## MUST (3개)

1. **ADR 상태머신** — `proposed` → `accepted` → (`superseded` | `deprecated` | `rejected` | `withdrawn`). `accepted`는 불변(오타/링크만 수정). 결정을 바꾸려면 **새 번호** ADR을 만들고 옛 것을 `superseded`로 두며 `superseded_by: NNNN`으로 교체 번호를 명시한다. 모든 ADR은 [README.md](README.md) 상태보드에 행이 있어야 한다.
2. **supersede/deprecate → archive** — 대체/무효화된 ADR만 `docs/_archive/adr/`로 이동(또는 원위치에 1줄 stub `→ moved to _archive/…, superseded by NNNN`). **"완료(done)"는 아카이빙 트리거가 아니다** — accepted는 살아있는 정본. 삭제하지 않는다(추적성).
3. **필수 헤딩 계약** — 모든 ADR 본문에 `## 결정`과 `## 검토한 대안`이 있어야 한다(순서 무관, 추가 섹션 자유). loose 계약이라 저자와 싸우지 않으며 CI 구조 검증(`tests/unit/docs-adr-structure.test.mjs`)이 이것만 강제한다.

## SHOULD (맞추면 됨, 차단 게이트 아님)

- 파일명 `docs/adr/NNNN-kebab-title.md`, 4자리 zero-pad, 순차 단조 증가(삭제 후 재사용 금지). 산문 참조는 `ADR-0007`.
- **번호 발번은 `max(로컬 디스크, git ls-tree origin/main) + 1`로 교차확인한다** — 멀티세션/swarm 환경에서 로컬만 보면 두 세션이 같은 번호를 이중배정할 수 있다(선제 방어; mnk-callbot 0054/0055 이중배정 사고 근거). 발번 후 즉시 상태보드 등재+커밋.
- `NNNN`는 **크로스폴더 척추** — 동일 주제가 `docs/prd/`·`.triflux/plans/`로 퍼지면 같은 번호를 재사용해 파일명만으로 추적.
- 아래 권장 frontmatter 템플릿 사용.

## ADR 템플릿

```markdown
---
id: 0007
title: <명령형 짧은 제목>
status: proposed          # proposed | accepted | rejected | superseded | deprecated | withdrawn
date: YYYY-MM-DD
deciders: [tellang]
supersedes: []            # 이 ADR이 대체하는 번호들
superseded_by: null       # 이 ADR을 대체한 번호
relates: []               # 관련 ADR/PRD 번호 (NNNN 척추)
pr: null                  # 구현 PR/커밋 (예: "#449")
---

# ADR-0007: <명령형 짧은 제목>

## 컨텍스트와 문제 (Context)
<!-- 무엇을 왜 결정해야 하나. 배경·제약·강제 요인. 2~5문장. -->

## 결정 (Decision)
<!-- 택한 것. 명령형 한 문단. "우리는 …하기로 한다." -->

## 검토한 대안 (Considered Options)
<!-- 결정이 실제로 경합했을 때 채운다. 루틴 결정이면 간단히. -->
- **A안**: … — 장점 … / 단점 …
- **B안**: … — 장점 … / 단점 …

## 결과 (Consequences)
<!-- 긍정/부정 파급, 트레이드오프, 후속, 되돌릴 조건. -->
```

## ADR vs PRD vs plan vs design vs rules

| 산출물 | 답하는 질문 | 위치 | 가변성 |
|---|---|---|---|
| **ADR** | 무엇을 **왜** 정했나(아키텍처/정책) | `docs/adr/` | accepted 후 불변 |
| **PRD** | 사용자/제품 관점 **무엇을 만드나** | `docs/prd/` | 갱신 유지 |
| **plan** | **어떻게·어떤 순서로** 짓나 | `.triflux/plans/` | 폐기성 |
| **design** | 지어진 것이 **어떻게 생겼나** | `docs/design/` | 갱신 유지 |
| **rules** | 에이전트가 **항상 지킬 규칙** | `.claude/rules/` | 가변(SSOT) |

## 보류 (자동화 — `.document-harness.toml` `automation_trigger` 충족 시)

ADR 25개 초과 **또는** 상태보드 drift 2회 관측 시 → 상태보드 자동생성·구조 lint·아카이브 트랜잭션 도입. 그때까지 수동. 조기 자동화 금지.
