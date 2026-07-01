# triflux 문서 파운데이션 + 개발 플로우 확립 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** triflux의 흩어진 문서를 목적별 아키텍처로 정돈하고, `docs/adr/` ADR 체계 + 개발 플로우 + 공개/비공개 경계를 명시적 SSOT로 확립한다.

**Architecture:** `.claude/rules/`(harness auto-load 정책 SSOT)는 그대로 두고(P1), `docs/`에 결정(`adr/`)·요구(`prd/`)·설계(`design/`)·리서치(`research/`)·프로세스(`process/`)를 목적별로 분리한다. 불변 ADR("왜") + 가변 CONVENTIONS("어떻게") 2층 거버넌스를 `.document-harness.toml`(must/should/deferred + automation_trigger) 한 곳으로 캘리브레이션한다. 공개/비공개는 grandfathering을 explicit allowlist로 교체한다.

**Tech Stack:** Markdown 문서, TOML 정책 파일, `.gitignore` allowlist, Node `node:test`(구조 검증), 기존 `npm test` / `npm run lint`(biome) 파이프라인. 신규 시스템 의존성 없음(lychee/mdschema는 Phase 5 옵션).

## 실행 상태 (2026-07-01, 브랜치 `worktree-docs-adr-foundation`)

- ✅ **Phase 0 완료·커밋** — gitignore 공개경계 교정(`e4b7f47f`), ADR 부트스트랩 0001/0002+보드+CONVENTIONS(`79d37f69`), `.document-harness.toml`(`eae48822`), 구조 테스트(`9be4cba2`). ADR 구조 테스트 3/3 pass. gitignore 교정 untracked-probe로 검증(docs/adr 등 trackable, superpowers/plans LOCAL 유지).
- ✅ **Phase 1 완료·커밋** — docs/README 인덱스+_archive 규약(`dedb865d`), CONTRIBUTING+ARCHITECTURE+README 포인터(`557da744`), docs/process(`db6f2967`), tfx-doc-governance 규칙(`0d9cca3c`). 5종 병렬 서브에이전트 저작, 링크 정합.
- ✅ **Phase 2 완료·커밋** — design PRD 2건 → docs/prd 이동(`b3eb78c2`), decision-tfx-skill-passing → ADR-0003 승격+보드등재+원본배너(`f35ad3bb`). 구조 테스트 3/3(0003 포함).
- ⏳ **Phase 3 미착수** — 3.1 psmux 3-way(psmux 버전 실측 + 결정 + 코드/미러 가능성, Windows 전용), 3.2 CODEX/GEMINI resync, 3.3 ROADMAP/TODOS/decisions.md, 3.4 PRD 템플릿 codex-exec 정합. 판단·검증 필요 항목이라 별도 리뷰 배치로 진행.
- 📋 **Phase 4~5** — 로드맵(backfill ADR / threshold-gated 자동화).

## Global Constraints

- **`.claude/rules/`의 기존 9개는 이동/흡수/재작성 금지**(harness auto-load 속성 보존). 새 문서는 rules를 "가리키기만" 한다. **예외 2건**: 신규 `tfx-doc-governance.md` 1개 추가(Task 1.5), psmux 모순 해소 시 `tfx-psmux.md` 수정 가능성(Task 3.1) — 이 둘은 **auto-load 정책 변경**이므로 별도 리뷰 대상.
- **미러 정책.** 기본 산출물(`docs/`, 루트 `*.md`, `.gitignore`, `.document-harness.toml`, `tests/unit/`, `.github/CODEOWNERS`, `.claude/rules/`)은 전부 `packages/` 미러 대상이 아니다(`tests/` 미러 제외, docs는 `docs/assets`만 npm 포함, `.claude/`는 미러 목록 밖). **예외: Task 3.1에서 `scripts/lib/psmux-info.mjs`를 수정하면 `.claude/rules/tfx-mirror-policy.md`에 따라 packages/{core,triflux,remote} 미러 동반 필수.** Phase 5 자동화가 `scripts/`에 doc-lint를 추가할 때도 동일.
- **AI attribution 금지.** 모든 커밋 메시지에 Co-Authored-By / AI trailer / "Generated with" 금지(triflux 릴리즈 정책).
- **커밋은 태스크 단위.** 각 태스크 끝에서 변경 파일만 add 후 커밋. `git add -A` 금지(워크트리에 unrelated 산출물 존재 가능).
- **공개 안전.** ADR/문서에 토큰·계정명·개인 호스트·Tailscale IP·로컬 절대경로·비공개 고객 내용 금지. 그런 값은 LOCAL 문서에만.
- **정본 우선(SSOT).** 같은 주제 문서가 여럿이면 `docs/README.md`가 가리키는 진입점이 정본. 모순 발견 시 SSOT 쪽으로 정렬하고 반대편은 위임/deprecate.

## 설계 근거 (요약)

이 플랜은 이원(consensus) 리서치의 수렴 결과다. 상세 설계 근거는 채택 시 `docs/adr/0002-*.md` 본문이 된다.
- **리서치 소스:** ADR 관행(Nygard ~723 repos / MADR / Y-statements), 유명 OSS(Rust·React·K8s RFC/KEP vs Vite·Deno·Astro·Zod 경량 ADR), 참조 오케스트레이션 프로젝트의 "선언 공개·실행상태 로컬" 3-tier 모델, mnk-callbot의 성숙한 doc-governance(30 ADR + `.document-harness.toml` + 상태보드 + `_archive/`), triflux 현행 감사.
- **수렴 결정(교차 확인됨):** ADR 포맷 = **MADR-minimal**(Nygard 골격 + 필수 `## 결정`·`## 검토한 대안`), 경로 `docs/adr/NNNN-kebab.md`, 상태머신(proposed→accepted→superseded/deprecated/rejected), 불변+supersede 체인, 2층 거버넌스, 저위험-우선 마이그레이션.

## 공개/비공개 결정 (사용자 질문에 대한 답)

**질문: "ADR을 GitHub에 공개하나?" → 답: 예. `docs/adr/`에 in-repo로 공개 커밋한다.**

근거: (1) ADR은 이미 공개된 코드의 결정을 서술 — 숨길 게 없고 온보딩 레버리지 최대. (2) OSS 규범이 공개(참조 프로젝트도 결정/설계 문서를 공개 소스에 커밋). (3) git 이력이 검색 가능한 불변 결정 로그가 됨. (4) 유일한 예외(carve-out): 미공개 보안 취약점·NDA 벤더/가격 조건 — 이 경우만 공개 stub + 상세는 LOCAL.

**공개 표면 3개는 서로 다른 파일이 지배한다(혼동 주의):**
| 표면 | 지배 파일 | docs 취급 |
|---|---|---|
| GitHub repo | `.gitignore` | ADR·prd·design·research·process = **공개**. runtime = ignore |
| npm tarball | `package.json.files` | `docs/assets`만 포함, 나머지 docs 제외 |
| agent visibility | `.claudeignore` 등 | 공개 정책과 무관(방어선) |

**카테고리 분류(요약):** PUBLIC(commit) = `docs/adr|prd|design|research|process/`, `.claude/rules/`, root `README*|CONTRIBUTING|ARCHITECTURE|CHANGELOG|CLAUDE|AGENTS|CODEX|GEMINI`, `.document-harness.toml`, `.triflux/plans/`, `.github/`. LOCAL(git-ignore) = `.triflux/{lake,swarm-logs,subagents,reports}/`, `.omc/`, `.tfx/`, `.omx/`, `docs/superpowers/plans/`, secrets/`.env`/hosts.

---

## Phase 0 — 스켈레톤 & 공개경계 교정 (최저 위험, 대량 이동 없음)

이 Phase 완료 시: ADR 체계가 존재하고, 신규 `docs/adr/` 파일이 실제로 커밋 가능해지며(현재는 조용히 유실됨), 정책 SSOT(`.document-harness.toml`)가 생긴다. 기존 문서는 무손상.

### Task 0.1: docs/adr/ 부트스트랩 (0001 + 상태보드 + CONVENTIONS)

**Files:**
- Create: `docs/adr/0001-record-architecture-decisions.md`
- Create: `docs/adr/README.md` (상태보드 SSOT)
- Create: `docs/adr/CONVENTIONS.md` (가변 "어떻게" + 템플릿)

**Interfaces:**
- Produces: ADR 파일 규약(`NNNN-kebab-title.md`, 필수 헤딩 `## 결정`·`## 검토한 대안`), 상태보드 표 스키마(`| ADR | 결정 | 상태 | 관련 |`). 이후 모든 태스크의 ADR은 이 규약을 따른다.

- [ ] **Step 1: `docs/adr/0001-record-architecture-decisions.md` 작성**

```markdown
---
id: 0001
title: ADR로 아키텍처 결정을 기록한다
status: accepted
date: 2026-07-01
deciders: [tellang]
supersedes: []
superseded_by: null
relates: []
pr: null
---

# ADR-0001: ADR로 아키텍처 결정을 기록한다

## 컨텍스트와 문제 (Context)
triflux의 "왜 이렇게 했나"가 `ROADMAP.md`, `.triflux/plans/`, `docs/design/`, PRD, 규칙 파일에 흩어져 있어, 신규 기여자(사람/에이전트)가 확정된 결정을 재논쟁한다. 결정의 단일 집이 없다.

## 결정 (Decision)
우리는 아키텍처·정책·횡단 결정을 `docs/adr/`에 번호화된 불변 ADR로 기록한다. 포맷은 MADR-minimal(Nygard 골격 + 필수 `## 결정`·`## 검토한 대안`)이며, 운영 규약은 `docs/adr/CONVENTIONS.md`, 근거의 근거는 각 ADR이 소유한다.

## 검토한 대안 (Considered Options)
- **A안: ADR 도입(채택)** — 장점: 결정에 단일·검색가능·불변 집. 단점: 작성 규율 필요.
- **B안: 현행 유지(design/plan 산재)** — 장점: 추가 작업 0. 단점: 결정 추적 불가, 재논쟁 반복.
- **C안: RFC repo(Rust/K8s식)** — 장점: 무거운 합의 프로세스. 단점: 소규모/솔로에 과잉(P6).

## 결과 (Consequences)
긍정: 결정 이력이 git에 남아 온보딩·중복 방지. 부정: `accepted` 후 불변 규율 + 상태보드 등재 의무. 후속: ADR-0002가 문서 아키텍처 전체를 규정.
```

- [ ] **Step 2: `docs/adr/README.md` 상태보드 작성** (모든 ADR은 여기 행이 있어야 "존재")

```markdown
# ADR — triflux 아키텍처 의사결정 기록

triflux의 아키텍처·정책·횡단 결정을 ADR로 남긴다. **행이 없는 ADR은 존재로 인정하지 않는다.**
규약(어떻게)은 [CONVENTIONS.md](CONVENTIONS.md), 근거(왜)는 각 ADR.

## 상태보드

| ADR | 결정 | 상태 | 관련 |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | ADR로 결정을 기록한다 | Accepted | — |
| [0002](0002-doc-and-devflow-architecture.md) | 문서 아키텍처 + 개발 플로우 | Accepted | 0001 |

상태 범례: **Proposed**(제안) · **Accepted**(확정, 불변) · **Superseded**(대체됨→`_archive/`) · **Deprecated**/**Rejected**/**Withdrawn**(무효화→`_archive/`).
```

- [ ] **Step 3: `docs/adr/CONVENTIONS.md` 작성** (템플릿 포함 — mnk-callbot 3-MUST 패턴 차용)

```markdown
# docs 컨벤션 (살아있는 규칙)

> 근거·왜는 [ADR-0002](0002-doc-and-devflow-architecture.md). 이 문서는 **어떻게**(가변 규칙)다. 규칙이 바뀌면 여기를 고치고 ADR은 건드리지 않는다.
> 원칙: 발명하지 말고 얼라인한다. 네이밍/폴더는 SHOULD, 아래 **MUST 3개**만 강제.

## MUST (3개)
1. **ADR 상태머신**: `proposed`→`accepted`→(`superseded`|`deprecated`|`rejected`|`withdrawn`). `accepted`는 불변(오타/링크만). 결정 변경 = **새 번호** ADR + `superseded_by`로 교체 명시. 모든 ADR은 `README.md` 상태보드에 행이 있어야 한다.
2. **supersede/deprecate → archive**: 대체/무효화된 ADR만 `docs/_archive/adr/`로 이동(또는 원위치 1줄 stub). **"완료(done)"는 아카이빙 트리거가 아니다** — accepted는 살아있는 정본. 삭제 금지(추적성).
3. **필수 헤딩 계약**: 모든 ADR 본문에 `## 결정`과 `## 검토한 대안`이 있어야 한다(순서·추가 섹션 자유). loose 계약이라 저자와 싸우지 않는다.

## SHOULD (맞추면 됨)
- 파일명 `docs/adr/NNNN-kebab-title.md`, 4자리 zero-pad, 순차 단조 증가(삭제 후 재사용 금지). 산문 참조는 `ADR-0007`.
- `NNNN`는 크로스폴더 척추 — 동일 주제가 `docs/prd/`·`.triflux/plans/`로 퍼지면 같은 번호 재사용.
- frontmatter 권장 템플릿(아래).

## ADR 템플릿

​```markdown
---
id: 0007
title: <명령형 짧은 제목>
status: proposed          # proposed|accepted|rejected|superseded|deprecated|withdrawn
date: YYYY-MM-DD
deciders: [tellang]
supersedes: []
superseded_by: null
relates: []
pr: null
---

# ADR-0007: <명령형 짧은 제목>

## 컨텍스트와 문제 (Context)
<!-- 무엇을 왜 결정해야 하나. 배경·제약. 2~5문장. -->

## 결정 (Decision)
<!-- 택한 것. "우리는 …하기로 한다." -->

## 검토한 대안 (Considered Options)
- **A안**: … — 장점 … / 단점 …
- **B안**: … — 장점 … / 단점 …

## 결과 (Consequences)
<!-- 긍정/부정 파급, 트레이드오프, 후속, 되돌릴 조건. -->
​```

## 보류 (자동화 — `.document-harness.toml` automation_trigger 충족 시)
ADR 25개 초과 **또는** 상태보드 drift 2회 관측 시 → 상태보드 자동생성·구조 lint·아카이브 트랜잭션 도입. 그때까지 수동.
```

> 주의: 위 CONVENTIONS 본문의 중첩 코드펜스는 실제 파일에선 4-backtick 또는 `~~~`로 감싸 렌더 깨짐을 방지한다.

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0001-record-architecture-decisions.md docs/adr/README.md docs/adr/CONVENTIONS.md
git commit -m "docs(adr): bootstrap ADR system (0001 + status board + conventions)"
```

### Task 0.2: ADR-0002 (문서 아키텍처 결정 승격)

**Files:**
- Create: `docs/adr/0002-doc-and-devflow-architecture.md`

**Interfaces:**
- Consumes: Task 0.1의 ADR 템플릿/규약.
- Produces: 문서 아키텍처·개발플로우·공개정책의 정본 결정 기록. 이후 모든 Phase가 이 ADR을 구현한다.

- [ ] **Step 1: ADR-0002 작성** (이 플랜의 "설계 근거"·"공개/비공개 결정" 섹션을 정식 ADR 본문으로. `## 결정`에 목표 문서 트리 요약, `## 검토한 대안`에 Nygard vs MADR / operations 통합 vs 제자리 / RFC repo vs ADR-only를 기록, `## 결과`에 마이그레이션 Phase 개요와 되돌릴 조건.)

- [ ] **Step 2: 상태보드는 Task 0.1 Step 2에서 이미 0002 행 포함 확인** (누락 시 추가)

- [ ] **Step 3: 커밋**

```bash
git add docs/adr/0002-doc-and-devflow-architecture.md
git commit -m "docs(adr): record doc-foundation and dev-flow architecture (ADR-0002)"
```

### Task 0.3: `.document-harness.toml` 정책 SSOT

**Files:**
- Create: `.document-harness.toml` (repo 루트)

**Interfaces:**
- Produces: 문서 정책의 기계가독 SSOT. doc-lint/자동화(Phase 5)와 사람이 동일 파일을 읽는다.

- [ ] **Step 1: `.document-harness.toml` 작성**

```toml
# document-harness 프로젝트 설정 (calibration)
# 근거: docs/adr/0002-doc-and-devflow-architecture.md · 운영규칙: docs/adr/CONVENTIONS.md
# 정책: 3 MUST 강제 + 나머지는 advisory(SHOULD) 또는 보류(deferred). 이 한 곳이 SSOT.

root_marker = "docs"

[enforce]
adr_lifecycle        = "must"      # 상태머신: proposed→accepted→superseded/deprecated/rejected/withdrawn
archive_on_supersede = "must"      # supersede/deprecate → docs/_archive/ (수동·삭제금지)
required_headings    = "must"      # ADR 본문 `## 결정` + `## 검토한 대안` 존재

frontmatter_template = "should"    # 권장 YAML frontmatter
naming_convention    = "should"    # NNNN-kebab
folder_layout        = "should"    # docs 목적별 분리

status_board_autogen = "deferred"
patchlog             = "deferred"  # docs/PATCHLOG.md (ADR↔commit)
link_check           = "deferred"  # lychee
mdschema_contract    = "deferred"  # 구조 계약 검증

[automation_trigger]
adr_count_over     = 25
drift_observations = 2

[paths]
adr         = "docs/adr"
archive     = "docs/_archive"
conventions = "docs/adr/CONVENTIONS.md"
index       = "docs/README.md"
```

- [ ] **Step 2: `.document-harness.toml`이 커밋 가능한지 확인** (루트 dotfile은 ignore 안 됨)

Run: `git check-ignore .document-harness.toml && echo IGNORED || echo OK`
Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add .document-harness.toml
git commit -m "docs: add document-harness policy calibration (SSOT)"
```

### Task 0.4: `.gitignore` 공개경계 교정 (핵심 — ADR 커밋 가능화)

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 0.1~0.3이 만든 `docs/adr/` 경로.
- Produces: `docs/adr/`·`docs/_archive/`·`docs/process/`·grandfathered 디렉토리의 신규 파일이 실제로 tracked. **이 태스크 없이는 Phase 0의 ADR 파일이 조용히 유실된다.**

- [ ] **Step 1: 교정 전 현실 확인 (실패 재현)**

Run:
```bash
git check-ignore -v --no-index docs/adr/9999-probe.md || echo "not-ignored"
```
Expected: `docs/*` 매치로 IGNORED 표시 — allowlist에 `docs/adr/`가 없어 신규 파일이 무시됨이 핵심. (tracked 파일은 `git check-ignore`가 거짓음성을 내므로 반드시 **untracked probe 경로 + `--no-index`**로 확인 — Codex 리뷰 P2.)

- [ ] **Step 2: `.gitignore`의 `docs/*` allowlist 블록에 negation 추가**

`.gitignore`의 `!docs/research/` 다음 줄들 뒤에 아래를 추가(기존 `docs/*` 라인은 유지):
```gitignore
# 문서 파운데이션 공개 경계 (ADR-0002) — 의도적 공개 하위트리 명시
!docs/adr/
!docs/adr/**
!docs/_archive/
!docs/_archive/**
!docs/process/
!docs/process/**
!docs/recovery/
!docs/recovery/**
!docs/troubleshooting/
!docs/troubleshooting/**
!docs/README.md
# docs/superpowers: 부모가 docs/* 로 막혀 있어 2단계 re-include 필요 (git 규칙: 부모 디렉토리 제외 시 하위 직접 re-include 불가 — Codex 리뷰 P1)
!docs/superpowers/
docs/superpowers/*
!docs/superpowers/specs/
!docs/superpowers/specs/**
```
> `docs/superpowers/*` 재-ignore로 `plans/`는 LOCAL 유지, `specs/`만 공개된다.

- [ ] **Step 3: `CLAUDE.md` 오분류 제거** (실제 커밋+npm 배포되는데 ignore-list에 있음)

`.gitignore`에서 `CLAUDE.md` 라인(line 18 근처)을 제거하거나 그 앞에 명시 주석:
```gitignore
# CLAUDE.md 는 공개 SSOT (tracked + npm files) — ignore 하지 않는다
```
(라인 삭제. tracked 파일이라 동작 변화는 없으나, ignore-list가 진실을 왜곡하는 것을 교정.)

- [ ] **Step 3b: grandfathered tracked 파일 공개/LOCAL 확정** (Codex 리뷰 P1)

`docs/superpowers/plans/`는 신규 파일이 ignore되지만 **기존 tracked 파일이 있으면 여전히 공개**다(gitignore는 tracked를 LOCAL로 못 만듦). 설계 의도(plans=LOCAL)에 맞춰 캐시에서 제거:
```bash
git ls-files docs/superpowers/plans/
# 나온 파일을 LOCAL 전환 (기본값). 공개 유지가 필요하면 docs/superpowers/specs/ 로 git mv 승격.
git rm --cached docs/superpowers/plans/2026-05-20-agy-phase1-finish.md
```
(⚠️ `rm --cached`는 GitHub에서 제거되는 **의도된 삭제** — 실행 전 파일 내용 확인. 공개 가치가 있으면 specs로 승격.)

- [ ] **Step 4: 교정 검증 (untracked probe 경로 사용)**

Run:
```bash
for p in docs/adr/9999-x.md docs/_archive/adr/x.md docs/process/x.md docs/recovery/x.md docs/troubleshooting/x.md docs/superpowers/specs/x.md; do
  git check-ignore -q "$p" && echo "IGNORED(FAIL): $p" || echo "ok: $p"
done
# CLAUDE.md 는 tracked 라 --no-index 로 규칙만 검사 (Codex 리뷰 P2)
git check-ignore -q --no-index CLAUDE.md && echo "CLAUDE rule still ignores(FAIL)" || echo "ok: CLAUDE.md rule"
```
Expected: 모든 줄 `ok:` (IGNORED 없음). probe 경로는 untracked라 정확.

- [ ] **Step 5: `docs/superpowers/plans/` 신규 파일은 여전히 LOCAL인지 확인** (과다 공개 방지)

Run: `git check-ignore -q docs/superpowers/plans/x.md && echo "ok(local)" || echo "leaked(check)"`
Expected: `ok(local)` (신규 plans는 LOCAL 유지; 기존 tracked는 Step 3b에서 처리).

- [ ] **Step 6: 커밋**

```bash
git add .gitignore
git commit -m "docs: fix public/private boundary (allowlist docs/adr, process, recovery, superpowers/specs; unignore CLAUDE.md)"
```

### Task 0.5: ADR 구조 검증 테스트 (경량, mirror-free)

**Files:**
- Create: `tests/unit/docs-adr-structure.test.mjs`

**Interfaces:**
- Consumes: `docs/adr/` 파일들, `.document-harness.toml`.
- Produces: `npm test`에 편입되는 구조 계약 — ADR 파일명 규약 + 필수 헤딩(`## 결정`·`## 검토한 대안`) + 상태보드 등재를 검증. `tests/`는 미러 제외라 mirror 부담 없음.

- [ ] **Step 1: 실패 테스트 작성**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const adrDir = join(repoRoot, "docs", "adr");

test("docs/adr exists with bootstrap ADRs", () => {
  assert.ok(existsSync(adrDir), "docs/adr/ must exist");
  assert.ok(existsSync(join(adrDir, "README.md")), "status board must exist");
  assert.ok(existsSync(join(adrDir, "CONVENTIONS.md")), "conventions must exist");
});

test("every ADR file follows NNNN-kebab naming and required headings", () => {
  const files = readdirSync(adrDir).filter((f) => /^\d{4}-.+\.md$/.test(f));
  assert.ok(files.length >= 2, "at least ADR-0001 and ADR-0002");
  for (const f of files) {
    const body = readFileSync(join(adrDir, f), "utf8");
    assert.match(body, /^\d{4}-[a-z0-9-]+\.md$/.test(f) ? /.*/ : /$^/, `${f} kebab`);
    assert.ok(body.includes("## 결정"), `${f} missing '## 결정'`);
    assert.ok(body.includes("## 검토한 대안"), `${f} missing '## 검토한 대안'`);
  }
});

test("every ADR has a row in the status board", () => {
  const board = readFileSync(join(adrDir, "README.md"), "utf8");
  const files = readdirSync(adrDir).filter((f) => /^\d{4}-.+\.md$/.test(f));
  for (const f of files) {
    const id = f.slice(0, 4);
    assert.ok(board.includes(`[${id}]`), `ADR ${id} not registered in status board`);
  }
});
```

- [ ] **Step 2: 테스트 실행 → 통과 확인** (Task 0.1~0.2가 이미 조건 충족)

Run: `node --test tests/unit/docs-adr-structure.test.mjs`
Expected: PASS (3 tests). 실패 시 해당 ADR에 헤딩/보드행 보정.

- [ ] **Step 3: 전체 스위트 회귀 없음 확인**

Run: `npm test 2>&1 | tail -20`
Expected: 신규 3 test 추가, 기존 pass 수 유지, 0 fail.

- [ ] **Step 4: 커밋**

```bash
git add tests/unit/docs-adr-structure.test.mjs
git commit -m "test(docs): assert ADR naming, required headings, status-board registration"
```

---

## Phase 1 — 온보딩 진입점 (신규 파일만, 저위험)

이 Phase 완료 시: 사람이 README→CONTRIBUTING→ARCHITECTURE→docs/README→docs/adr/README 5-홉으로 진입 가능하고, 거버넌스 PRD가 약속했던 `docs/process/`가 배달된다.

### Task 1.1: `docs/README.md` 문서 인덱스 (purpose→canonical 맵)

**Files:**
- Create: `docs/README.md`

**Interfaces:**
- Produces: 사람·에이전트 두 진입점이 만나는 지점. "무엇을 알고 싶으면 어디" 표 + public/local/npm 3분류 계약.

- [ ] **Step 1: mnk-callbot `docs/README.md` 패턴 차용해 작성** — 섹션: (1) "처음이면 이 3개"(README·ARCHITECTURE·docs/adr/README), (2) 목적별 진입점 표(무엇을 만드나→prd, 왜→adr, 규칙→.claude/rules, 지금 상태→ARCHITECTURE, 프로세스→docs/process), (3) 공개/local/npm 3분류 계약 표(위 "공개/비공개 결정"에서 복사), (4) 안 봐도 되는 것(`docs/_archive/`).
- [ ] **Step 2: 링크 유효성 확인** — Run: `grep -oE '\]\([^)]+\)' docs/README.md | sed -E 's/\]\(|\)//g' | while read l; do [ -e "docs/$l" ] || [ -e "$l" ] || echo "DANGLING: $l"; done` — Expected: DANGLING 없음(아직 안 만든 CONTRIBUTING/ARCHITECTURE는 Task 1.2/1.3 후 재확인).
- [ ] **Step 3: 커밋** — `git add docs/README.md && git commit -m "docs: add documentation index (purpose->canonical map + public/private contract)"`

### Task 1.2: `CONTRIBUTING.md`

**Files:**
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: 작성** — 섹션: 빌드/설치, `npm test`·`npm run lint`(biome check=lint+format 주의), 브랜치 네이밍(`feat|fix|docs|refactor/<issue>-<slug>`), 개발 플로우(아래 "개발 플로우" 요약 + docs/process 링크), **교차리뷰 계약**(Claude 작성→Codex 리뷰 / Codex 작성→Claude 리뷰, self-approve 금지), 릴리즈 진입점(`/tfx-ship`), AI trailer 금지. `.claude/rules/`가 에이전트 정책 SSOT임을 명시.
- [ ] **Step 2: 커밋** — `git add CONTRIBUTING.md && git commit -m "docs: add CONTRIBUTING with dev flow and cross-review contract"`

### Task 1.3: `ARCHITECTURE.md`

**Files:**
- Create: `ARCHITECTURE.md`
- Reference: `README.md`(265~329줄 인라인 아키텍처), `docs/assets/architecture.svg`

- [ ] **Step 1: README 인라인 아키텍처를 추출·확장** — 패키지 레이아웃(root + `packages/{core,remote,triflux}`), core/remote/cli 데이터 흐름, hub/mesh 역할, 3-layer mirror 관계(→`.claude/rules/tfx-mirror-policy.md` 링크). README는 요약만 남기고 ARCHITECTURE로 링크.
- [ ] **Step 2: 커밋** — `git add ARCHITECTURE.md README.md && git commit -m "docs: extract ARCHITECTURE.md from README inline architecture"`

### Task 1.4: `docs/process/` 배달 (거버넌스 PRD 미배달분)

**Files:**
- Create: `docs/process/branch-policy.md`, `docs/process/pr-review-contract.md`

- [ ] **Step 1: `docs/process/`가 이제 tracked인지 확인** — Run: `git check-ignore docs/process/x.md >/dev/null && echo FAIL || echo ok` — Expected: `ok`(Task 0.4에서 allowlist됨).
- [ ] **Step 2: `branch-policy.md` 작성** — 브랜치 클래스(현재 거버넌스 PRD 내부에 갇힌 정책 추출), main 보호, 워크트리/스웜 브랜치 규약.
- [ ] **Step 3: `pr-review-contract.md` 작성** — 교차리뷰 게이트(5개 검증 명령: `npm test`·`npm run lint`·`release:check-sync`·`release:check-mirror`·`lint:skills`), PR 템플릿의 Cross-model review 섹션 계약.
- [ ] **Step 4: 커밋** — `git add docs/process/ && git commit -m "docs(process): deliver branch-policy and pr-review-contract"`

### Task 1.5: `.claude/rules/tfx-doc-governance.md` (rules↔docs 경계)

**Files:**
- Create: `.claude/rules/tfx-doc-governance.md`

**Interfaces:**
- Produces: harness auto-load되는 얇은 규칙 — "정책은 `.claude/rules/`(SSOT), 결정 근거는 `docs/adr/`, 요구는 `docs/prd/`, 실행은 `.triflux/plans/`" 경계 + ADR/CONVENTIONS 포인터. `.claude/rules/`를 흡수하지 않고 가리키기만 하는 P1 보장.

- [ ] **Step 1: 작성** — 짧게(1화면). ADR vs PRD vs plan vs design vs rules 결정표(플랜 설계의 표 복사) + "새 결정은 ADR proposed부터" 규칙.
- [ ] **Step 2: rules 린트 통과** — Run: `npm run lint:skills 2>&1 | tail -5` (rules 파일이 lint 대상이면 통과 확인; 아니면 skip).
- [ ] **Step 3: 커밋** — `git add .claude/rules/tfx-doc-governance.md && git commit -m "docs(rules): add doc-governance boundary (rules SSOT <-> docs/adr pointer)"`

---

## Phase 2 — 통합/이동 (파일 이동, 중위험)

이 Phase 완료 시: PRD가 `docs/prd/` 한 집에 모이고, 유일한 결정 문서가 정식 ADR이 된다.

### Task 2.1: `docs/design/`의 PRD → `docs/prd/` 이동

**Files:**
- Move: `docs/design/prd-issue-31-login-cache-refresh-2026-04-02.md` → `docs/prd/`
- Move: `docs/design/prd-multi-startup-cache-2026-04-02.md` → `docs/prd/`

- [ ] **Step 1: `git mv`로 이동** (이력 보존)
```bash
git mv docs/design/prd-issue-31-login-cache-refresh-2026-04-02.md docs/prd/
git mv docs/design/prd-multi-startup-cache-2026-04-02.md docs/prd/
```
- [ ] **Step 2: 인바운드 링크 갱신** — Run: `grep -rn "design/prd-issue-31\|design/prd-multi-startup" docs/ .claude/ *.md 2>/dev/null` → 나온 참조를 `docs/prd/`로 수정.
- [ ] **Step 3: 커밋** — `git add -u docs/ && git commit -m "docs: consolidate design PRDs into docs/prd/"`

### Task 2.2: `decision-tfx-skill-passing.md` → 정식 ADR 승격

**Files:**
- Source: `.triflux/plans/decision-tfx-skill-passing.md`
- Create: `docs/adr/0003-tfx-skill-passing-prose-injection.md`

- [ ] **Step 1: 내용을 ADR 템플릿으로 변환** — 기존 결정 문서를 `## 컨텍스트/결정/검토한 대안/결과`로 재구성. status는 이미 구현·머지된 결정이므로 `accepted`, `pr: "#387"`(관련 PR 확인 후 기입).
- [ ] **Step 2: 상태보드에 0003 행 추가** (`docs/adr/README.md`).
- [ ] **Step 3: 원본은 stub 또는 archive** — `.triflux/plans/decision-tfx-skill-passing.md`에 1줄 stub `→ docs/adr/0003-*.md 로 승격` 남김(이력 인바운드 보존).
- [ ] **Step 4: 구조 테스트 재실행** — Run: `node --test tests/unit/docs-adr-structure.test.mjs` — Expected: PASS(0003 포함).
- [ ] **Step 5: 커밋** — `git add docs/adr/ .triflux/plans/decision-tfx-skill-passing.md && git commit -m "docs(adr): promote tfx-skill-passing decision to ADR-0003"`

### Task 2.3: 링크 무결성 1회 검사

- [ ] **Step 1: 상대경로 링크 dangling 스캔** (외부 툴 없이 grep 기반)
```bash
git ls-files 'docs/**/*.md' '*.md' | while read f; do
  d=$(dirname "$f"); grep -oE '\]\((\.\.?/[^)]+|[^):]+\.md)\)' "$f" 2>/dev/null | sed -E 's/\]\(|\)//g' | while read l; do
    case "$l" in http*|\#*) continue;; esac
    t="$d/${l%%#*}"; [ -e "$t" ] || echo "DANGLING $f -> $l"
  done
done
```
- [ ] **Step 2: 나온 dangling 링크 수정 후 재확인** — Expected: 출력 없음(또는 알려진 의도적 예외만).
- [ ] **Step 3: 커밋**(수정분 있으면) — `git commit -am "docs: fix dangling links after consolidation"`

---

## Phase 3 — Stale 정합화 (중위험)

이 Phase 완료 시: 정책 모순이 사라지고, 에이전트 온보딩 문서가 현행 스킬과 일치한다.

### Task 3.1: psmux 정책 3-way 정합화 (codex-conventions ↔ tfx-psmux ↔ psmux-info.mjs) (Codex 리뷰 P1)

**Files:**
- Modify: `docs/codex-conventions.md`
- Decide/Modify: `.claude/rules/tfx-psmux.md` (RULE 5), `scripts/lib/psmux-info.mjs` (코드 계약)
- SSOT: `.claude/rules/tfx-psmux.md`

**주의:** 3개 소스가 서로 모순 — `tfx-psmux.md` RULE 5는 detach-first를 **MUST**, `docs/codex-conventions.md`는 "detach-client 3.3.x **미지원**", `scripts/lib/psmux-info.mjs`는 `PSMUX_RECOMMENDED_VERSION="3.3.1"` + `detach-client`를 **OPTIONAL**. codex-conventions만 지우면 SSOT↔코드 모순이 남는다. **단순 삭제 금지.**

- [ ] **Step 1: 실측** — `psmux -V`; `psmux detach-client -h 2>&1 | head`. 현재 설치본에서 detach-client 동작 여부 확인.
- [ ] **Step 2: 정합 방향 결정 (택1)**
  - **(A) detach-first 유지**: `psmux-info.mjs`의 `PSMUX_RECOMMENDED_VERSION`을 `3.4.x+`로 올리고 `detach-client`를 `PSMUX_REQUIRED_COMMANDS`로 승격 → **`tfx-mirror-policy.md`에 따라 packages/{core,triflux,remote} 미러 동반 필수.**
  - **(B) optional 흡수**: RULE 5에 "detach 미지원 시 `exit`→sleep→kill fallback" 명시(SSOT가 optional을 계약으로 흡수). 코드 변경 없음.
- [ ] **Step 3: `docs/codex-conventions.md` psmux 섹션을 SSOT 포인터로 축약** — 본문 규칙 삭제 후 `> psmux 세션 관리는 SSOT [.claude/rules/tfx-psmux.md](../.claude/rules/tfx-psmux.md) RULE 5 를 따른다`. Windows 전용·mac 무관 주석 유지. 중복 `## 4.` 헤딩 수정.
- [ ] **Step 4: (A안이면) 미러 검증** — `node scripts/pack.mjs all` 또는 `npm run release:check-mirror`로 psmux-info.mjs 미러 정합 확인.
- [ ] **Step 5: 커밋** — 코드+미러+문서를 한 커밋. `git commit -m "docs+psmux: reconcile psmux policy across SSOT, code contract, and codex-conventions"`

> **범위 주의:** Windows 전용 psmux 정책이라 mac 런타임엔 no-op. 코드(`psmux-info.mjs`)+미러를 건드리므로 다른 Phase 3 문서 태스크와 **분리 커밋**하거나 별도 plan으로 떼어내도 된다.

### Task 3.2: `CODEX.md` / `GEMINI.md` 재동기화

**Files:**
- Modify: `CODEX.md`, `GEMINI.md`

- [ ] **Step 1: deprecated 스킬 참조 grep** — Run: `grep -nE 'tfx-codex\b|tfx-gemini\b|tfx-autopilot\b|tfx-remote-spawn\b' CODEX.md GEMINI.md`
- [ ] **Step 2: 현행 스킬로 교체** — `tfx-remote-spawn`→`tfx-remote`, `tfx-codex`/`tfx-gemini`→`tfx-auto --cli codex|antigravity`, `tfx-autopilot`→현행 라우팅(`.claude/rules/tfx-routing.md` 대조). Codex는 `@import` 미지원이라 이 파일들이 load-bearing임을 유의.
- [ ] **Step 3: 커밋** — `git add CODEX.md GEMINI.md && git commit -m "docs: resync CODEX/GEMINI agent guides to current skills"`

### Task 3.3: `ROADMAP.md`/`TODOS.md` 갱신 + `docs/decisions.md` 처리

**Files:**
- Modify: `ROADMAP.md`, `TODOS.md`
- Create(옵션): `docs/decisions.md`

- [ ] **Step 1: ROADMAP/TODOS dangling 링크 스캔·갱신 또는 상단에 "last-updated + 정본은 docs/adr/README.md" 배너 추가.** 대량 재작성 대신 stale 표기 + 포인터가 저위험.
- [ ] **Step 2: `docs/decisions.md` 계약 해소** — 외부 스킬/툴이 이 경로를 참조할 수 있으므로, `docs/decisions.md`를 `docs/adr/README.md`로 리다이렉트하는 얇은 포인터 파일로 생성(정본 중복 금지). 참조처가 확인 안 되면 생략 가능.
- [ ] **Step 3: 커밋** — `git add ROADMAP.md TODOS.md docs/decisions.md 2>/dev/null; git commit -m "docs: mark stale roadmap/todos and point to ADR board"`

### Task 3.4: `docs/prd/_template.md` Codex 실행 제약 정합화 (Codex 리뷰 P2)

**Files:**
- Modify: `docs/prd/_template.md`

- [ ] **Step 1: 현행 SSOT 대조** — 템플릿의 "codex exec는 `--profile` 미지원" 등 실행 제약이 현행과 맞는지 검증. **주의: `--profile` 지원 여부는 codex 버전별로 바뀜(메모리상 `exec --profile` 정상 실측 사례 있음)** — 실측(`codex exec --profile <x> -h`) 또는 `CODEX.md`/`tfx-escalation-chain.md` 대조 후에만 수정. 틀린 주장만 교정, 맞는 제약은 유지.
- [ ] **Step 2: 실행 제약을 SSOT 포인터로 축약** — PRD 템플릿은 제품 요구에 집중, Codex/swarm 실행 규칙은 `.claude/rules/`·`hub/team/build-worker-prompt.mjs` 포인터로 축소. (자동주입 섹션 "저자 편집 금지" 주석 유지.)
- [ ] **Step 3: 커밋** — `git add docs/prd/_template.md && git commit -m "docs(prd): reconcile template codex-exec constraints with SSOT"`

---

## Phase 4 (roadmap) — 과거 결정 backfill ADR

**성격:** 저위험·고회수(high-recall)지만 분량이 커서 별도 배치. 이미 확정된 횡단 결정을 소급 ADR로 기록하고, 해당 `.claude/rules/` 절에 `ADR-00NN` 링크(rules=SSOT 유지, ADR=why 이력).

backfill 후보(각 1 ADR): Codex 기본 CLI(`tfx-routing`), packages 3-layer mirror(`tfx-mirror-policy`), escalation chain codex→claude opus(`tfx-escalation-chain`), hub 기본 포트 27888, native-bridge UI default, stack 공존 3-layer(`tfx-stack-coexistence`). 각 ADR은 status `accepted` + 관련 PR 링크. 상세 태스크는 이 Phase 착수 시 별도 plan으로 분해.

## Phase 5 (roadmap) — 자동화 게이트 (threshold-gated, 고위험)

**진입 조건:** `.document-harness.toml`의 `automation_trigger`(ADR>25 또는 drift 2회) 충족 시에만. 조기 자동화 금지(P4).

포함(옵션): loose `mdschema`(ADR 헤딩 계약)·link-check(lychee)를 `npm test`/CI 편입, `docs/adr/README.md` 상태보드 generated-block 자동생성(`<!-- docs:start/end -->` 사이만), PATCHLOG(ADR↔commit) 도입, changesets per-package CHANGELOG, `.github/CODEOWNERS`로 `.github/workflows/` 보호 + Actions SHA-pin. **`scripts/`에 doc-lint 추가 시 `tfx-mirror-policy.md` 미러 의무 발생** — 별도 plan에서 packages 미러 동반.

---

## Self-Review

- **Spec 커버리지:** 사용자 요구 4개 매핑 — (1) "문서 기반+개발 플로우 확립"→Phase 0~3 전체. (2) "ADR gh 공개?"→"공개/비공개 결정" 섹션 + Task 0.4(커밋 가능화). (3) "omc 수준 공개/비공개"(브랜드 비노출)→분류표(참조 프로젝트 3-tier 보정, 이름 미언급). (4) "mnk-callbot·유명 OSS 차용"→ADR 포맷·상태보드·CONVENTIONS·`.document-harness.toml`·CONTRIBUTING/ARCHITECTURE. (5) "codex 다중 병렬"→이원 트랙(Claude workflow + Codex)으로 이미 리서치/설계 수행, 실행은 execution handoff에서 swarm 옵션.
- **Placeholder 스캔:** ADR-0002 본문(Task 0.2 Step 1)은 플랜의 "설계 근거"·"공개/비공개 결정" 섹션을 정본으로 삼아 채운다 — 실행 시 해당 섹션 복사. CONTRIBUTING/ARCHITECTURE 본문은 지정 소스(README 인라인, tfx-routing)에서 추출하는 구체 지시가 있음.
- **타입/이름 일관성:** ADR 필수 헤딩 `## 결정`·`## 검토한 대안`이 CONVENTIONS(0.1)·템플릿·구조 테스트(0.5)·ADR-0001/0002 전체에서 동일 문자열. `.document-harness.toml` `[paths]`가 실제 생성 경로와 일치.
- **위험:** Task 0.4 `.gitignore` 편집이 최고 임팩트 — Step 1/4/5 검증으로 과소·과다 공개 양방 가드. Task 3.1은 버전 제약 확인 전 단순 삭제 금지 명시.
- **교차리뷰(Codex, 판정 APPROVE-WITH-FIXES) 반영 완료:** P1×4 = ① `docs/superpowers/specs` 2단계 allowlist(부모 재포함) ② tracked `plans/` 파일 LOCAL 전환 Task(Step 3b) ③ `.claude/rules/` 스코프 명시(Global Constraints) ④ psmux 3-way 코드계약(`psmux-info.mjs`) 정합(Task 3.1 재작성). P2×2 = ⑤ `git check-ignore --no-index`/untracked probe(false negative 제거) ⑥ PRD 템플릿 codex-exec 정합(Task 3.4 신설). Codex CONFIRMED: 1단계 allowlist 방식·MADR 일관성·감사 클레임·미러 판단.

## Execution Handoff

**계획 저장 위치:** `.triflux/plans/2026-07-01-docs-adr-foundation.md` (triflux tracked plan home; writing-plans 기본값 `docs/superpowers/plans/`는 현재 git-ignore라 부적합).

두 가지 실행 옵션:
1. **Subagent-Driven (권장)** — 태스크당 fresh 서브에이전트 + 태스크 간 리뷰. 문서 작업이라 Codex worker로 병렬 가능(교차리뷰: Claude 작성→Codex 검토). Phase 0은 순차(gitignore 의존성), Phase 1은 병렬 가능.
2. **Inline Execution** — 이 세션에서 executing-plans로 배치 실행 + 체크포인트.

Phase 0→1→2→3 순서 권장(0.4 gitignore가 나머지의 커밋 가능성을 좌우하므로 Phase 0 먼저 완결). Phase 4~5는 별도 plan.
