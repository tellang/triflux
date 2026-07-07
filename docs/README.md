# triflux 문서 진입점

> triflux 문서 진입점 — 목적별 정본(SSOT)을 먼저 가리킨다.
> 문서 정리 규칙은 [adr/0002-doc-and-devflow-architecture.md](adr/0002-doc-and-devflow-architecture.md) + [adr/CONVENTIONS.md](adr/CONVENTIONS.md).

## 🟢 처음이면 이 3개부터

1. **[../README.md](../README.md)** — 제품 개요. triflux가 무엇이고 무엇을 하는지.
2. **[../ARCHITECTURE.md](../ARCHITECTURE.md)** — 시스템 구조. 패키지 레이아웃(root + `packages/{core,remote,triflux}`), core/remote/cli 데이터 흐름, hub/mesh 역할.
3. **[adr/README.md](adr/README.md)** — 결정 상태보드. "왜 이렇게 정했나"는 전부 여기서 출발한다. 행이 없는 ADR은 존재로 인정하지 않는다.

## 🎯 목적별 진입점

| 알고 싶은 것 | 먼저 볼 문서 |
|---|---|
| **무엇을 만드나 / 요구사항** | [prd/](prd/) — 제품 요구(PRD) · 템플릿 [prd/_template.md](prd/_template.md) |
| **원문 요구 ↔ 확정 요구 (추적성)** | [req/](req/) — raw(원문 ask) ↔ refined(확정 요구사항) 양방향 링크. PRD보다 앞 단계 |
| **왜 이렇게 정했나 (결정 근거)** | [adr/](adr/) — 번호화된 불변 ADR · 상태보드 [adr/README.md](adr/README.md) · 운영 규약 [adr/CONVENTIONS.md](adr/CONVENTIONS.md) · 경량 결정로그 [DECISIONS.md](DECISIONS.md) |
| **항상 지킬 에이전트 규칙** | [../.claude/rules/](../.claude/rules/) — 정책 SSOT. 하네스가 auto-load한다. 문서는 이 규칙을 "가리키기만" 한다 |
| **시스템 구조** | [../ARCHITECTURE.md](../ARCHITECTURE.md) — 패키지·데이터 흐름·미러 관계 · 각주 리딩 노트 [architecture.reading.md](architecture.reading.md)(옵시디언, wiki-harness) |
| **개발 / 기여 프로세스** | [process/](process/) — 브랜치 정책·PR 리뷰 계약 · 진입점 [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| **설계 서사 (design)** | [design/](design/) — 설계 노트·office-hours·실행 모드 등 서술형 설계 자료 |
| **조사 / 근거 자료** | [research/](research/) — 리서치·감사·분석 리포트 |
| **운영 런북 (복구 / 트러블슈팅 / MCP)** | [recovery/](recovery/)(git·세션·메모리·이슈PR 복구) · [troubleshooting/](troubleshooting/)(알려진 이슈 해결) · [mcp/](mcp/)(MCP 시크릿 처리) |

## 🔓 공개 / 비공개 계약 (3 표면)

공개 표면 3개는 서로 다른 파일이 지배한다(혼동 주의).

| 표면 | 지배 파일 | 대상 |
|---|---|---|
| **GitHub (공개 커밋)** | `.gitignore` | `docs/{adr,prd,req,design,research,process,recovery,troubleshooting}/`, `docs/DECISIONS.md`, `docs/architecture.reading.md`, `docs/.obsidian/`, `docs/.wiki-harness/`, `../.claude/rules/`, 루트 `README`·`CONTRIBUTING`·`ARCHITECTURE`·`CHANGELOG`·`CLAUDE`·`AGENTS`·`CODEX`·`GEMINI`, `.document-harness.toml`, `.triflux/plans/` |
| **LOCAL (git-ignore, 커밋 안 함)** | `.gitignore` | `.omx/`·`.omc/`·`.tfx/` 런타임, `.triflux/{lake,reports,swarm-logs,subagents}/`, `docs/superpowers/plans/`, 토큰·시크릿·호스트 등 비공개 값 |
| **npm tarball** | `package.json`의 `files` | docs 중 `docs/assets`만 포함(나머지 docs 제외) |

> 규칙: ADR·문서에 토큰·계정명·개인 호스트·로컬 절대경로·비공개 고객 내용은 넣지 않는다. 그런 값은 LOCAL 문서에만 둔다.

## 🗄️ 안 봐도 되는 것

- **[_archive/](_archive/)** — Superseded/무효화된 문서 보존본(추적성 유지). 원위치엔 stub만 남는다.
- **`superpowers/plans/`** — LOCAL(git-ignore). 실행 중 산출물이라 공개 대상이 아니다.

## 메모

- **정본 우선(SSOT)**: 같은 주제에 문서가 여럿이면 위 표의 진입점이 정본이다. 모순 발견 시 정본 쪽으로 정렬하고 반대편은 위임/deprecate한다.
- **경계**: 정책은 `../.claude/rules/`(SSOT), 결정 근거는 `adr/`, 요구는 `prd/`, 실행은 `../.triflux/plans/`가 소유한다.
