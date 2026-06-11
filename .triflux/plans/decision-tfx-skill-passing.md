# DECISION — tfx-auto의 codex/agy 스킬 전달 방식

> 출처: 세션 d8696d4e research 워크플로우(omc gh + codex/agy 네이티브 스킬 + gemini 환각, 4 agents) + tfx-route.sh 정적 감사. 2026-06-08.

## 1. 결정 (DECIDE)

**채택: 즉석 prose 주입 (skill 내용을 프롬프트 앞에 prepend) — 2.3.1 "네이티브 CLI 스킬 호출"은 기각, 2.3.2 너프는 사용자 기각.**

근거 4가지:
1. **네이티브 headless 스킬 호출이 미지원** — codex 0.137 / agy 1.0.6 둘 다 SKILL.md 시스템은 있으나 `/name` 슬래시는 **인터랙티브 TUI 전용**이고, `codex exec` / `agy --print` 같은 headless one-shot엔 named-skill 호출 플래그가 없다. codex `$skill-name`은 프롬프트 본문 텍스트(exec에서 honor 미문서), 그 외엔 모델 description auto-load(비결정적). triflux는 100% headless이므로 네이티브 경로는 신뢰 불가. (출처: developers.openai.com/codex/cli/slash-commands·reference; dev.to antigravity guide; 로컬 SKILL.md 실측)
2. **레퍼런스(omc)가 정확히 prose 주입을 쓴다** — omc는 codex/gemini에 항상 plain-text 프롬프트를 넘기고 네이티브 스킬을 의도적으로 회피. 유일한 스킬화는 자기 role .md를 raw text로 prepend(`--agent-prompt`). 검증된 패턴. (출처: omc src/cli/ask.ts:231-234, scripts/run-provider-advisor.js)
3. **triflux 전달이 이미 parse-safe** — codex argv `--` 뒤 전달(셸 재확장 없음), agy stdin `printf '%s'`(백슬래시/₩ 미해석). omc의 shell:false + stdin fallback과 동일. prose 주입은 파싱 위험 0 추가.
4. **DRY + explicit-over-clever** — `prepend_codex_north_star()`(tfx-route.sh)가 이미 CLI-agnostic prose-prepend로 존재. 같은 패턴으로 `prepend_skill()` 추가만 하면 됨. 네이티브 스킬 브릿지는 clever·fragile·CLI 버전 결합이라 회피.

**하이브리드 단서**: codex `~/.codex/skills/`에 description 매칭 스킬이 등록돼 있으면 exec에서도 auto-load될 *수도* 있으나 비결정적·미문서 → **의존하지 않는다**.

## 2. 파싱 안전 규칙 (구현 불변식)

주입은 반드시 `printf`/`cat` → temp file → prompt 앞에 붙이는 방식만 사용. `eval`/unquoted 확장 금지. codex는 argv `--` 뒤, agy는 stdin pipe 유지. `$`·`₩`·`\`는 리터럴 보존.

## 3. 구현 (IMPLEMENT) — ✅ 완료 (commit 31594494, branch worktree-tfx-skill-inject)

- `prepend_skill(prompt)`: `TFX_INJECT_SKILL` 설정 시 `skills/<name>/SKILL.md` 본문을 delimited block으로 prepend. 미설정 no-op. path-traversal 가드(`/`·`..` 거부). codex·agy 레인 공통.
- `append_agy_anti_overclaim(prompt)`: agy 레인 전용, 완료/grounding 규율 블록을 프롬프트 END에 append (ITEM3).
- codex 레인(north-star 직후) + agy 레인 wiring.
- `packages/triflux/scripts/tfx-route.sh` byte-identical 미러.
- `tfx-auto` SKILL.md: `--skill <name>` 플래그 + 커맨드→스킬 convention + agy anti-overclaim 문서화.
- 테스트: `tests/unit/tfx-route-skill-inject.test.mjs` 9개(주입/no-op/parse-safety $·₩·\\·--flag/traversal 거부/anti-overclaim/레인 wiring). north-star 회귀 5/5 무손상. lint:skills 42 PASS.

## 4. ITEM3 — gemini/agy 환각·거짓완료 완화

Gemini 3.x 과신은 실증됨(AA-Omniscience: 정확도 53-56% 대비 환각률 88-91%, 추상화 최저; 3.1 Pro는 88→50% 개선). 완화책을 prose 주입으로 agy 레인에 통합:

- **agy anti-overclaim 블록**(append_agy_anti_overclaim, 기본 on): fresh 증거 없이 완료 주장 금지(superpowers verification-before-completion Iron Law), grounded abstention("No Info" 후 중단), "주어진 context로 추론 + accurate abstention 우선". 부정 제약은 Gemini 3 공식 가이드대로 END 배치, blanket "do not guess" 회피.
- agy 자기보고 완료 불신: 기존 commit-evidence 게이트 + codex↔claude 교차리뷰로 이미 방어(메모리 feedback_agy_swarm_no_commit). 강화.
- Context7 MCP(이미 가용): codex/agy 코드답변 grounding 권장.
- API-level(Search grounding, Vertex check-grounding 0-1 score+citation_threshold)은 CLI 레인 밖 → 후속.
- ⚠️ Antigravity Artifacts/Walkthrough는 human-review aid지 hard gate 아님(같은 과신 모델이 생성) → 단독 의존 금지.

## 5. 미해결 / 리스크

- live EMPIRICAL: codex/agy에 `$`/`₩` 포함 스킬 프롬프트 실제 전달은 `prepend_skill` 함수 경유 smoke + 단위테스트로 리터럴 보존 증명(headless-guard로 codex/agy 실프로세스 transcript는 미실행, 정적+함수레벨 증명으로 갈음).
- 커맨드→스킬 auto-map은 convention(tfx-auto가 `--skill` set)으로만 제공, 코드 자동 매핑은 의도적으로 default-off(부적절 스킬 누출 방지).
- 커뮤니티 환각 완화 efficacy 수치는 control group 없는 blog claim.
