---
id: 0002
title: 문서 파운데이션 + 개발 플로우 아키텍처
status: accepted
date: 2026-07-01
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0001]
pr: null
---

# ADR-0002: 문서 파운데이션 + 개발 플로우 아키텍처

## 컨텍스트와 문제 (Context)
triflux 문서는 양은 많지만(docs/ 100+ 파일, 루트 MD 9개, `.claude/rules/` 9개, `.triflux/plans/` 21개) 조직적으로 파편화돼 있다. 결정 기록 체계(ADR)가 없어 "왜 이렇게 했나"가 여러 트리(`docs/design`·`docs/prd`·`.triflux/plans`)에 흩어지고, 문서 인덱스·`CONTRIBUTING`·`ARCHITECTURE`가 없으며, 공개/비공개 경계가 `.gitignore` grandfathering으로 불명확하다(현행 allowlist가 `docs/adr/`를 포함하지 않아 신규 ADR 파일이 조용히 유실될 정도). 목적: 문서 기반 + 개발 플로우를 명시적 SSOT로 확립.

## 결정 (Decision)
우리는 다음 문서 아키텍처와 개발 플로우를 채택한다.

- **정책 SSOT는 `.claude/rules/`(harness auto-load)에 그대로 둔다.** 흡수/이동하지 않고 `docs/README.md`가 가리키기만 한다.
- **`docs/`를 목적별로 분리한다**: `adr/`(결정·불변), `prd/`(요구), `design/`(설계), `research/`(조사), `process/`(거버넌스), `recovery|troubleshooting|mcp/`(운영 런북). 진입점은 `docs/README.md`.
- **ADR 포맷 = MADR-minimal** — Nygard 골격(Context/Decision/Consequences) + 필수 `## 결정`·`## 검토한 대안`. 경로 `docs/adr/NNNN-kebab.md`, 상태머신 `proposed→accepted→superseded/deprecated/rejected/withdrawn`, accepted 후 불변 + supersede 체인.
- **2층 거버넌스** — 불변 ADR("왜") + 가변 `docs/adr/CONVENTIONS.md`("어떻게"), 정책 캘리브레이션은 `.document-harness.toml`(must/should/deferred + automation_trigger 25/2).
- **개발 플로우** — idea → (결정 필요 시 ADR proposed→accepted) → PRD/plan → 구현(기본 CLI=Codex) → 교차리뷰(Claude↔Codex, self-approve 금지) → ship(`/tfx-ship`, CI OIDC) → CHANGELOG. 온보딩 단선: README → CONTRIBUTING → ARCHITECTURE → docs/README → docs/adr/README.
- **공개/비공개** — ADR·prd·design·research·process·rules = PUBLIC(GitHub commit). runtime 상태(`.omx/`·`.omc/`·`.tfx/`·`.triflux/{lake,reports,swarm-logs,subagents}`)·secrets·hosts = LOCAL(git-ignore). 공개 표면 3개(GitHub `.gitignore` / npm `package.json.files` / agent `.claudeignore`)를 구분하고, `.gitignore` grandfathering을 explicit allowlist로 교체한다. **ADR은 GitHub 공개**(민감정보 sanitize; 보안취약점·NDA만 carve-out).

## 검토한 대안 (Considered Options)
- **ADR 포맷 — MADR-minimal(채택) vs Nygard-only vs 전체 MADR**: Nygard는 대안 기록을 강제하지 않고, 전체 MADR(Decision Drivers 등)은 소규모/솔로에 과중. MADR-minimal이 "왜 그 안을 안 골랐나"를 최저비용으로 포착. mnk-callbot 실사용 + 2개 독립 리서치가 수렴.
- **폴더 — 제자리 유지 + allowlist(채택) vs operations/ 통합**: 제자리 유지가 저위험(되는 것을 부수지 않음). `operations/` 통합은 후순위 옵션으로 남긴다.
- **결정 프로세스 — ADR-only(채택) vs RFC repo**: RFC/KEP식 무거운 프로세스는 외부 기여자 커뮤니티 형성 전까지 과잉. 드문 횡단 제안은 GitHub Discussion → 결론을 ADR로 fold.
- **정책 위치 — `.claude/rules/` 유지(채택) vs docs로 흡수**: 흡수 시 harness auto-load 강제력을 잃고 수동 위키로 전락.

## 결과 (Consequences)
긍정: 결정에 단일·검색가능·불변 집이 생기고, 온보딩이 단선화되며, 공개 경계가 명시화되고, 신규 ADR이 실제로 커밋 가능해진다(gitignore 교정). 부정: accepted ADR 불변 규율 + 상태보드 등재 의무 + 작성 비용. 트레이드오프: 초기 수동 운영(자동화는 `automation_trigger` 도달 시). 되돌릴 조건: ADR 체계가 부담만 되고 실사용되지 않으면 이 ADR을 superseded 처리하고 경량 `decisions.md`로 축소. 후속: 마이그레이션 Phase 0~5 상세는 `.triflux/plans/2026-07-01-docs-adr-foundation.md`.
