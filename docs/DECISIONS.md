# DECISIONS — 경량 결정 로그

`docs/adr/`보다 가벼운, 아직 ADR로 승격하지 않은 결정을 역연대순으로 남긴다.
반복되거나 영향이 커지면 ADR로 승격하고(`docs/adr/CONVENTIONS.md` 절차),
여기 항목은 그대로 두되 승격 사실만 追記한다. 이 파일은 ADR 상태머신을
대체하지 않는다 — 근거(왜)가 아키텍처/정책 수준이면 ADR로, 운영 절차 수준이면
여기로.

## 2026-09-21: agy 프롬프트는 `--print` 값으로 전달한다 (stdin 폐기)

- **결정**: agy 호출은 `agy --dangerously-skip-permissions --print "<프롬프트>"` 형태로 한다.
  아래 2026-07-26 항목의 "agy 레인만 stdin 파이프" 부분을 이 항목이 대체한다.
- **근거**: Antigravity CLI 공식 헤드리스 문서는 `-p`/`--print`/`--prompt` 가 프롬프트를 값으로
  받고, stdin 프롬프트는 `--input-format stream-json` 에서만 읽는다고 적는다. agy 1.2.7 실측에서
  stdin 방식은 `--print` 가 다음 플래그를 프롬프트로 삼켜 exit 2 로 끝났다. 외부 CLI 가 강제한
  계약 변경이라 ADR 이 아니라 여기에 남긴다.
- **남은 것**: `.claude/rules/tfx-psmux.md` 규칙 4-3 과 그 생성 미러 `AGENTS.md` 가 아직 agy 를
  표준 입력으로 적고 있다. 규칙 본문과 sync hash 를 함께 고쳐야 한다.
- **관련**: PR #501

## 2026-09-21: HUD 의 `sv` 절약 세그먼트를 뺀다

- **결정**: HUD 의 모든 tier 에서 `sv:` 구간과 그 계산부(accumulator 판독, 포맷터, 상수)를 제거한다.
- **근거**: 컨텍스트 용량 대비 누적 토큰 배수라 `5.7k%` 같은 값이 나오고, 읽는 사람이 뜻을
  알 수 없었다. 파이프라인 벤치마크 요약의 비용 절약 표기는 의미가 분명해 그대로 둔다.
- **관련**: PR #502

## 2026-07-26 — psmux 미러는 `.claude/rules/`가 작성 정본, AGENTS.md는 생성물

- **결정**: `tfx-psmux.md`에 `sync-role: source`를 두고 `AGENTS.md`는 단방향 생성
  미러로 고정. `sync-block-sha256` 산출 기준(경계 마커 두 줄 포함)을 헤더에 명시.
- **근거**: 두 파일이 서로를 `sync-source`로 지목하는 순환 선언이었고, 양쪽이
  주장하던 hash가 실제 블록과도 달라 어느 쪽도 정본이 아니었다. 유지보수자가 어느
  쪽을 고쳐도 다음 동기화가 역방향으로 덮어쓰는 상태. 계산 방식이 문서화된 적이
  없던 것이 hash가 stale해진 원인이라 검증 기준을 함께 남겼다.
  `.claude/rules/` = auto-load 실행 SSOT([tfx-doc-governance](../.claude/rules/tfx-doc-governance.md)).
- **관련**: commit `b6553482`, `a04777e2`

## 2026-07-26 — Codex 프롬프트 전달은 `--` 뒤 argv (문서를 실구현에 맞춤)

- **결정**: `RULE 4-3`의 "항상 stdin"을 폐기하고 argv + stdin 봉인으로 정정.
  `codex exec … -- "$prompt" < /dev/null`. agy 레인만 stdin 파이프.
- **근거**: `scripts/tfx-route.sh` 실측 결과 문서와 정반대였다. "프롬프트가 `--`로
  시작하면 플래그로 파싱된다"는 우려는 유효하나 해법은 stdin이 아니라 `--`
  end-of-options다. `codex exec`는 non-TTY subprocess라 `codex < prompt.md`가 실패한다.
  같은 파일 안에 반대 지시가 공존해 어느 쪽을 골라도 규칙 위반이 아닌 상태였다.
- **관련**: commit `b6553482`, `acd4f1d1`

## 2026-07-26 — Codex instruction 표면은 AGENTS.md 하나로 단일화

- **결정**: `CODEX.md`를 제거하고 고유 규칙을 `AGENTS.md`로 병합.
- **근거**: 같은 디렉터리에 `AGENTS.md`가 있으면 Codex 탐색 규칙
  (`AGENTS.override.md` → `AGENTS.md` → fallback)상 `CODEX.md`는 영구히 가려진다.
  `codex debug prompt-input`으로 미로드를 실증했고, headless-guard 규칙·커밋
  규약(AI trailer 금지)·effort 예외 레인이 Codex에 전혀 닿지 않고 있었다.
- **관련**: commit `a04777e2`

## 2026-07-26 — routing과 stack-coexistence는 충돌이 아니라 층위 차이

- **결정**: `tfx-routing.md` = 워크플로 단계 + 자연어 트리거, `tfx-stack-coexistence.md`
  책임 매트릭스 = 기능별 owner SSOT. 각 문서 상단에 관할을 명시하고, 같은 층위에서
  실제로 갈리던 한 건(`리뷰해` → `tfx-review` vs superpowers)만 정본에 맞췄다.
- **근거**: 두 문서가 plan/review owner를 두고 어긋난다는 지적이 있었으나,
  `writing-plans`는 ladder의 한 *단계*이고 Plan 기능의 *owner*는 triflux라 모순이
  아니었다. 통합했다면 검증된 워크플로 체인이 깨졌을 것이다.
- **관련**: commit `98ee2423` · [ADR-0009](adr/0009-stack-coexistence-three-layer.md)

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

## 2026-08-21 — AGENTS.md psmux 미러 폐지, 규칙은 tfx-psmux.md 단일 정본
- **결정**: AGENTS.md의 생성형 `TFX psmux Rules` 섹션을 제거하고 psmux 규칙은
  `.claude/rules/tfx-psmux.md`만 정본으로 유지한다. AGENTS.md는 Codex 환경 특화
  핵심 규칙만 남긴 슬림 가이드로 축소하고, README·tfx-remote·tfx-setup의
  AGENTS.md 참조를 rules 문서로 교체했다.
- **근거**: 2026-07-26 결정(단방향 생성)은 순환 선언은 해소했지만 생성물 미러의
  drift 비용이 남아 있었다. rules 파일은 Claude가 자동 로드하고 Codex 표면은
  CLAUDE.md 직접 참조로 충분하다.
