# 문서 거버넌스 — rules ↔ docs 경계

정책은 어디, 결정 근거는 어디. 실행 규칙과 결정 이력이 섞이지 않도록 경계를 고정한다.

## 경계표

| 위치 | 답하는 것 | 성격 | 가변성 |
|------|-----------|------|--------|
| `.claude/rules/` | 에이전트가 **항상 지킬 실행 정책** | auto-load SSOT | 가변 |
| `docs/adr/` | 아키텍처·정책·횡단 결정의 **"왜"** | 결정 근거 이력 | accepted 후 불변 |
| `docs/prd/` | 사용자/제품 관점 **무엇을 만드나** | 제품 요구 | 갱신 유지 |
| `docs/design/` | 지어진 것이 **어떻게 생겼나** | 설계 서사 | 갱신 유지 |
| `.triflux/plans/` | **어떻게·어떤 순서로** 짓나 | 실행 분해 | 폐기성 |

## 규칙

- 새 아키텍처/정책/횡단 결정은 `docs/adr/`에 ADR로 `proposed`부터 시작한다. 규약은 `docs/adr/CONVENTIONS.md`. 필수 헤딩 `## 결정`·`## 검토한 대안`은 반드시 포함한다.
- `.claude/rules/`의 정책이 "왜" 그런지는 관련 ADR로 링크한다. **rules = 실행 SSOT(가변), ADR = 근거 이력(불변).** rules를 `docs/`로 흡수하지 않는다 — auto-load 경로를 보존한다.
- 정책을 바꾸면 `.claude/rules/`를 고치고, 결정 자체가 바뀌면 새 번호 ADR을 만들어 옛 것을 `superseded`로 둔다(ADR은 사후 수정하지 않는다).
- 문서 배치·공개 여부는 `docs/README.md` 인덱스가 정본이다(미등재 = 존재 부정). 정책 캘리브레이션(자동화 트리거 등)은 `.document-harness.toml`이 정본이다.

## 관련

| 대상 | 포인터 |
|------|--------|
| ADR 규약·템플릿·상태머신 | `docs/adr/CONVENTIONS.md` |
| ADR 상태보드 | `docs/adr/README.md` |
| 문서 인덱스(배치/공개 정본) | `docs/README.md` |
| 거버넌스 캘리브레이션 | `.document-harness.toml` |
