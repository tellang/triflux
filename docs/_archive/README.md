# _archive — 보존 아카이브

Superseded / Deprecated / Rejected / Withdrawn 상태가 된 문서를 **삭제하지 않고** 여기로 옮긴다(추적성 보존).

## 규칙 (근거: [../adr/CONVENTIONS.md](../adr/CONVENTIONS.md) MUST #2)

- **"완료(done)"는 아카이빙 트리거가 아니다.** accepted ADR은 살아있는 정본으로 원위치에 남는다.
- 아카이빙은 **대체/무효화**일 때만: `superseded`(+`superseded_by`), `deprecated`, `rejected`, `withdrawn`.
- 절차(수동): ① 상태 flip → ② `docs/_archive/<원래경로>/`로 이동(또는 원위치에 1줄 stub `→ moved to _archive/…, superseded by NNNN`) → ③ 상태보드([../adr/README.md](../adr/README.md)) 행 갱신(역링크 유지).
- 자동화(archive 트랜잭션)는 `.document-harness.toml`의 `automation_trigger` 충족 시 도입.

예: `docs/_archive/adr/NNNN-*.md` (대체된 ADR).
