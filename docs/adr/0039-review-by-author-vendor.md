---
id: 0039
title: 작성 벤더와 다른 벤더에 코드 리뷰를 배정한다
status: accepted
date: 2026-10-14
deciders: [tellang]
supersedes: [0038]
superseded_by: null
relates: [0004, 0036, 0037]
pr: null
---

# ADR-0039: 작성 벤더와 다른 벤더에 코드 리뷰를 배정한다

## 결정

Claude, Codex, Argon High 의 리드별 3자 토론 4라운드 합의와 사용자 결정에 따라 `code-reviewer`, `quality-reviewer`를 작성 벤더와 다른 벤더로 배정한다. `TFX_REVIEW_AUTHOR=codex|claude|antigravity`로 작성 벤더를 받고 미지정이면 기본 구현자인 Codex로 본다. 잘못된 값은 오류로 끝낸다.

| 작성 벤더 | 기본 리뷰 | Claude 주간 사용량 80% 이상 |
| --- | --- | --- |
| Codex | Claude Opus | Argon High |
| Claude | Codex Sol | Codex Sol |
| Antigravity | Claude Opus | Codex Sol |

Claude는 기존 워커 경로의 `--model opus`, Argon은 `argon_high`, Codex는 `sol_high`와 `review` 서브커맨드를 쓴다. Claude 주간 사용량은 `~/.claude/cache/claude-usage-cache.json`의 `data.weeklyPercent`로 판단하고, 읽을 수 없으면 한도 미만으로 본다. 명시 CLI 선택의 우선순위를 유지하고, 선택한 리뷰어와 작성 벤더, 사용량 전환 여부를 결과 머리말에 남긴다.

`security-reviewer`는 Argon High로 옮긴다. 세 리드 조건의 3자 토론이 모두 합의했다. 합의에서 채택한 근거는 CWE-bench v1의 Astra와 Argon 동률(68)과 Argon의 간접 프롬프트 주입 성공률 0.7%다.

`architect`, `planner`, `analyst`, `critic`은 Astra `astra_xhigh`를 유지한다. verifier와 explore는 리드별 네이티브 호출 절차만 문서로 정하고 코드 기본값을 유지한다. Codex 리드의 verifier는 빌드, 테스트, 요구사항 충족 증거만 확인하며 코드 승인은 하지 않는다. 리드별 표는 `skills/tfx-lead/SKILL.md`에 둔다.

ADR-0038의 Argon 가족 프로필과 옛 Flash 이름 해석, document-specialist의 Antigravity 배정, 큰 코드베이스 읽기의 Antigravity 배정은 유지한다. 이 결정에서 명시하지 않은 역할과 재시도 체인도 유지한다.

## 검토한 대안

- 설계 역할을 Opus로 옮기기: Opus가 Astra보다 한 등급 아래라는 사용자 판단에 따라 버렸다. 옮기면 역할 등급이 내려간다.
- Codex 작성 코드의 기본 리뷰를 Argon High에 맡기기: 2026-10-14 실측에서 Sol이 잡은 실제 결함 두 개를 Argon High는 둘 다 놓쳤다. 프롬프트와 커밋 시점이 같았으므로 기본 리뷰어로 채택하지 않았다.
- Codex Sol의 자기 리뷰 유지: 작성 벤더와 다른 벤더가 리뷰한다는 교차 리뷰 규칙을 위반한다.
