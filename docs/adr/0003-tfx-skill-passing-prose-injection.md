---
id: 0003
title: headless CLI 스킬 전달은 즉석 prose 주입으로 한다
status: accepted
date: 2026-06-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: "#387"
---

# ADR-0003: headless CLI 스킬 전달은 즉석 prose 주입으로 한다

## 컨텍스트와 문제 (Context)
triflux는 codex/antigravity를 100% headless(`codex exec` / `agy --print`)로 구동한다. codex 0.137 / agy 1.0.6 모두 SKILL.md 시스템은 있으나 `/name` 슬래시는 **인터랙티브 TUI 전용**이고, headless one-shot에는 named-skill 호출 플래그가 없다(모델 description auto-load는 비결정적). headless 워커에 스킬 지식을 신뢰성 있게 전달할 방법이 필요하다.

## 결정 (Decision)
스킬 내용을 **즉석 prose로 프롬프트 앞에 prepend**한다. `tfx-route.sh`에 `prepend_skill(prompt)`를 추가해 `TFX_INJECT_SKILL`/`--skill <name>` 설정 시 `skills/<name>/SKILL.md` 본문을 delimited block으로 prepend하고, 미설정 시 no-op한다. codex(argv `--` 뒤 전달, 셸 재확장 없음)·agy(stdin `printf '%s'`) 양 레인에서 parse-safe하며 path-traversal 가드(`/`·`..` 거부)를 둔다. 커맨드→스킬 auto-map은 convention(default-off, 부적절 스킬 누출 방지).

## 검토한 대안 (Considered Options)
- **A안: 즉석 prose 주입 (채택)** — 장점: headless 100% 신뢰, 기존 `prepend_codex_north_star()` CLI-agnostic 패턴 재사용(DRY), parse 위험 0 추가. 단점: 스킬 본문이 프롬프트 토큰을 소비.
- **B안: 네이티브 CLI 스킬 호출 (기각)** — headless 미지원 + 비결정적(auto-load) + CLI 버전 결합으로 fragile. 신뢰 불가.
- **C안: description 너프 (사용자 기각)** — 근본 해결 아님.
- 참고: 레퍼런스 오케스트레이션 프로젝트도 정확히 prose 주입을 쓰고 네이티브 스킬을 의도적으로 회피(자기 role .md를 raw text prepend). 검증된 패턴.

## 결과 (Consequences)
긍정: headless에서 결정적 스킬 전달, DRY, parse-safe($·₩·`\\`·`--flag` 리터럴 보존, 테스트 9개). Gemini 3.x 과신 완화(ITEM3)를 agy 레인 anti-overclaim prose로 통합. 부정/리스크: live 실프로세스 transcript는 headless-guard로 미실행 — 정적 + 함수레벨 단위테스트로 리터럴 보존을 증명(갈음). 구현: commit 31594494, PR #387. 상세 근거는 `.triflux/plans/decision-tfx-skill-passing.md`(원본, 승격됨).
