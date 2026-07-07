# req — 원문↔정제 요구사항 추적성

`docs/prd/`가 "무엇을 만드나"(구현 계획)를 소유한다면, 여기는 그 앞 단계
"원래 무엇을 요구했나(raw) → 무엇으로 확정했나(refined)"를 양방향으로
추적한다. `kind: raw` 문서는 `refined_by`로, `kind: refined` 문서는
`source`로 서로를 가리킨다 — 한쪽만 있으면 lint 실패.

## 상태보드

| ID | 제목 | Raw | Refined | 관련 PRD |
|---|---|---|---|---|
| 0001 | hosts.json user-state 경로 이전 | [raw](0001-hosts-json-user-state-raw.md) | [refined](0001-hosts-json-user-state-refined.md) | [prd/178-hosts-user-state.md](../prd/178-hosts-user-state.md) |

## 규칙

- 파일명: `NNNN-english-kebab-raw.md` / `NNNN-english-kebab-refined.md`(같은 ID, `-raw`/`-refined` 접미사만 다름).
- Refined는 "확정된 요구사항"까지만 소유한다. Shard 분해·프롬프트·완료조건 같은 실행 세부는 `docs/prd/`로 위임.
- 이 레이어는 현재 부트스트랩 파일럿(0001 1건)이다. 신규 PRD를 쓸 때 원문 ask가 뚜렷하면(GitHub 이슈, raw 요청 등) 이 패턴을 따라 raw/refined 쌍을 먼저 만들고 PRD에서 참조한다.
