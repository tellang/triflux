# DECISIONS — 경량 결정 로그

`docs/adr/`보다 가벼운, 아직 ADR로 승격하지 않은 결정을 역연대순으로 남긴다.
반복되거나 영향이 커지면 ADR로 승격하고(`docs/adr/CONVENTIONS.md` 절차),
여기 항목은 그대로 두되 승격 사실만 追記한다. 이 파일은 ADR 상태머신을
대체하지 않는다 — 근거(왜)가 아키텍처/정책 수준이면 ADR로, 운영 절차 수준이면
여기로.

## 2026-07-07 — docs/req/ raw↔refined 링크 강제 수준 = should

- **결정**: `.document-harness.toml`의 `raw_refined_link`를 `must`가 아닌
  `should`로 설정.
- **근거**: 부트스트랩 파일럿([req/0001](req/0001-hosts-json-user-state-raw.md))
  1건뿐이라 lint fail로 강제하기엔 이르다. 쌍이 여러 개 쌓이면 `must`로 승격.
- **관련**: [req/README.md](req/README.md)

## 2026-06-26 — triflux 릴리즈는 `tellang` 계정으로 전환 후 수행

- **결정**: 로컬 `gh`가 기본 활성 계정(`taeeon-tpcg`)인 상태로 triflux를
  릴리즈하면 머지·푸시·`release.yml` dispatch가 전부 403. 릴리즈 직전
  `gh auth switch --user tellang`, 끝나면 `taeeon-tpcg`로 원복.
- **근거**: 머신에 2개 `gh` 계정이 등록돼 있고 `tellang/triflux` 쓰기 권한은
  `tellang` 계정에만 있음(v10.40.0 릴리즈에서 실측 확인).
- **관련**: ADR 승격 대상 아님 — 계정 운영 절차.

## (이전 결정 backfill 대기)

이 로그는 2026-07-07 신설. 그 이전 결정은 커밋 메시지·PR 설명·
`.claude/rules/*.md` 본문에 흩어져 있다. 회고나 문서 정리 중 발견되면 이
로그로 역채움(backfill)한다 — 예: `tfx-psmux.md`의 gpt55 프로파일 기본값
채택, `tfx-update-logic.md`의 OMC 3-컴포넌트 동시 갱신 규칙 등.
