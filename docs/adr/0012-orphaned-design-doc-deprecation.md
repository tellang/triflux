---
id: 0012
title: 제거된 구현의 설계 문서 폐기 표시
status: accepted
date: 2026-09-15
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: 510
---

# ADR-0012: 제거된 구현의 설계 문서 폐기 표시

## 컨텍스트와 문제 (Context)

구현이 제거돼도 그 구현을 지시하던 PRD 와 recovery 문서는 `docs/` 에 그대로
남는다. `docs/README.md` 색인에 없으면 "존재 부정"으로 간주하는 규칙이 있지만,
파일은 남아 있어 검색과 grep 에는 계속 걸린다.

2026-09-15 에 실제 오인이 발생했다. `hub/team/git-preflight.mjs` 배선을 제거한
뒤에도 두 문서가 그 배선을 살아 있는 설계로 기술하고 있었다.

- `docs/prd/synapse-v1-remaining.md`: `createGitPreflight` 배선을 샤드 지시문으로 담음
- `docs/recovery/sessions.md:47`: 같은 배선을 "의도"로 기술
- 둘 다 `docs/README.md` 미등재

## 결정 (Decision)

PRD 와 recovery 문서는 대상 구현이 제거되면 폐기 표시를 붙이고
`docs/_archive/` 로 옮긴다. 삭제하지 않는다. ADR MUST 2 가 supersede 된 ADR 에
적용하는 처리를 PRD 와 recovery 문서로 확장한다.

폐기 표시는 파일 맨 앞 한 줄이며 제거 커밋 해시와 근거 ADR 번호를 담는다.

## 검토한 대안 (Considered Options)

- **삭제**: 검색 오염이 사라진다. 대신 무엇이 왜 없어졌는지 추적할 수 없다.
- **방치**: 비용이 0이다. 대신 이번과 같은 오인이 반복된다.
- **원위치 표시만**: 기존 링크가 살아남는다. 대신 `docs/` 본문에 죽은 문서가 쌓인다.
- **표시 후 아카이브(채택)**: 추적성과 검색 위생을 모두 얻는다. 대신 링크 갱신 비용이 든다.

## 결과 (Consequences)

- `.claude/rules/tfx-doc-governance.md` 에 PRD·recovery 폐기 규칙을 한 줄 더한다.
- 이 ADR 이 accepted 되면 위 두 문서가 첫 적용 대상이다.
- 아카이브한 구현이 되살아나면 파일을 원위치로 옮기고 표시를 지운다.
- 링크 깨짐은 `docs/README.md` 가 색인 정본이므로 미등재 문서에서는 영향이 작다.
