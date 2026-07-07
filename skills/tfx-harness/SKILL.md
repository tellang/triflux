---
name: tfx-harness
internal: true
description: >
  메타 라우팅 단일 진입점. 어떤 스킬/워크플로우/실행 레인으로 처리할지부터 판정해야 할 때
  사용한다. '어떤 스킬 쓰지?', '스킬 추천', '스킬 라우팅', '작업 라우팅', '메타 라우팅',
  'which skill', 'tfx-harness' 같은 요청에 사용. 작업 자체를 수행하는 스킬이 아니라
  최소 유기적 경로를 구성해 다음 스킬로 핸드오프하는 라우터다.
---

# tfx-harness — TFX/gstack/superpowers/OMC 라우팅 하니스 (Claude 정본)

## 계약

이 스킬은 라우팅 하니스이지 실행 엔진이 아니다.

**핵심 행동: 최소 유기적 경로를 구성한 뒤 핸드오프한다.** 사용자의 작업을 분류하고,
superpowers + gstack + OMC + TFX 중 가장 작은 유용한 조합을 고르고, 즉시 핸드오프
대상 스킬을 Skill tool로 invoke한다. 다운스트림 스킬이나 오케스트레이션 레인이 없을
때만 하니스가 직접 작업한다.

라우팅 정책의 SSOT는 `.claude/rules/tfx-routing.md`다. 이 스킬은 그 정책을
"어느 스킬로 넘길지" 판정으로 번역할 뿐, 표를 복제하지 않는다. 충돌 시 rules 문서가 이긴다.

## 레이어 모델

네 계열을 역할별로 함께 쓴다. 한 계열이 다른 계열을 대체하지 않는다.

| 레이어 | 소유 | 대표 진입점 |
| --- | --- | --- |
| superpowers | 방법론·품질 규율 | systematic-debugging, test-driven-development, writing-plans, verification-before-completion |
| gstack | 운영 워크플로우·증거 수집 | context-save/restore, qa, review, ship, investigate |
| OMC | 실행 토폴로지·지속성 | autopilot, ralph, ultrawork, team, ralplan |
| TFX | 로컬 자동화·CLI 브리지 | tfx-auto, tfx-plan, tfx-analysis, tfx-find, tfx-research, tfx-qa, tfx-review, tfx-ship |

유기적 경로 문법:

```text
선행조건(복원/안전가드/소유권 탐색) -> 방법론 -> 운영 워크플로우 -> 실행 소유자 -> 검증/배포/저장
```

단계 중 하나만 **즉시 핸드오프 소유자**다. 나머지 레이어는 후속 단계 또는 제약으로 명시한다.

## 판정 절차

1. 지배적 레인 식별: 신규 계획 / 계속 / 직접 구현 / 디버그 / 리서치 / 검증 / 릴리즈 /
   저장·복원 / 병렬 / 원격.
2. `.claude/rules/tfx-routing.md`의 기본 워크플로우 ladder와 행동 유형 매핑으로 경로 구성.
3. 즉시 핸드오프 소유자 하나를 선택한다. 하니스 안에서 전체 경로를 실행하지 않는다.
4. 사용자가 "어떤 스킬?"만 물었다면: 경로 + 즉시 소유자 + 한 문장 근거로 답하고 실행하지
   않는다 (recommendation-only).
5. 진행 요청이거나 경로가 명백하면: Skill tool로 소유자 스킬을 invoke해 핸드오프한다.
6. 혼합 요청은 선행조건 우선: 복원 → 탐색 → 디버그 → 수정 → 리뷰/QA → ship → 저장.
7. 핸드오프 이후에는 tfx-harness를 활성 상태로 취급하지 않는다.

## CLI 정책

`.claude/rules/tfx-routing.md`의 "CLI 우선순위 정책 — default = Codex"를 따른다.
구현/수정/디버그/리뷰/분석 레인의 기본 워커는 Codex(tfx-auto 경유), Antigravity는
교차 확인, Claude는 메타 라우팅·planning gate·gstack 표면·최종 수단이다.
모델명/프로파일은 이 문서에 하드코딩하지 않는다 — 프로필 설정이 SSOT다.

## 출력 형태

```text
[tfx-harness]
lane: <지배적 레인>
layers: method=<superpowers|none>, workflow=<gstack|none>, orchestration=<omc|none>, automation=<tfx|none>
next: <즉시 핸드오프 소유자>
followups: <후속 경로, 유용할 때만>
reason: <한 문장>
status: dispatching | recommendation-only | blocked
```

## 회귀 가드

- 존재하지 않는 스킬 이름을 출력하지 않는다. 현재 세션의 available skills 목록에 있는
  이름만 쓴다.
- 한 계열이 다른 계열을 대체하게 하지 않는다: superpowers=방법론, gstack=워크플로우,
  OMC=오케스트레이션, TFX=자동화.
- 다운스트림 소유자가 정해진 뒤에도 하니스 안에서 작업을 계속하지 않는다.
- 신선한 검증 증거 없이 ship으로 라우팅하지 않는다.

## Codex twin

Codex 세션용 트윈(영문, `$skill` 문법, "Claude 실행 금지" 규정 포함)은 이 저장소가 아니라
Codex 사용자 환경 배포 경로(`~/.codex` 스킬 표면)로 별도 배포한다. 이 저장소의
`skills/tfx-harness/SKILL.md`는 Claude Code 정본이며, 두 문서는 라우팅 표를 공유하되
호스트 규정(실행 금지 대상, 스킬 문법)만 다르다. 트윈을 이 파일로 덮어쓰지 않는다.
