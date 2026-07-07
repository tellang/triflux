---
id: 0005
title: packages/를 3-layer single-source로 미러링한다
status: accepted
date: 2026-04-30
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: null
---

# ADR-0005: packages/를 3-layer single-source로 미러링한다

## 컨텍스트와 문제 (Context)
triflux는 npm에 세 패키지를 발행한다: `triflux`(사용자 CLI), `@triflux/core`(공용 라이브러리), `@triflux/remote`(원격 entry/store/pipe/server). 소스는 repo root에 있고 `packages/{core,remote,triflux}/`가 published 레이어다. root와 packages가 갈라지면(drift) 발행본이 조용히 깨진다 — 특히 `@triflux/remote`는 root의 상대경로 import를 그대로 복사하면 자기 모듈을 못 찾는다. 미러 규칙이 레이어마다 달라야 하는데 그 규칙이 명문화돼 있지 않았다.

## 결정 (Decision)
우리는 **root를 single source of truth**로 두고 3개 published 레이어를 레이어별 다른 규칙으로 미러링한다.

- **`packages/core`(`@triflux/core`)** — root와 **byte-identical `cp`**. import 변환 없음. `hub/lib/*`, `scripts/lib/*`, `mesh/*`, `hooks/*`, `hud/*` 등. `hub/team/*`는 전체 미러하지 않고 `bridge.mjs`가 self-import하는 파일만 minimal cp.
- **`packages/remote`(`@triflux/remote`)** — root subset을 **`Edit`로 개별 수정**하며 상대경로 import를 `@triflux/core/...`로 변환. **`cp` 금지**(덮어쓰면 import path가 revert됨).
- **`packages/triflux`(`triflux` npm)** — root `package.json`의 `files` 교집합을 **byte-identical mirror**. `tests/`는 npm files 미포함이라 **미러 제외**. binary 산출물(`references/*-snapshots/` 등) 추가 시 `files` 부정 패턴 동반(npm pack tarball 폭증 방지).

## 검토한 대안 (Considered Options)
- **A안: 3-layer 명시 미러 + 레이어별 규칙 (채택)** — 장점: 각 패키지의 발행 요건(byte-identical vs import 변환 vs npm files)을 정확히 반영, 기존 구조 유지. 단점: 수동 미러라 drift 위험 → `release:check-mirror` + `scripts/pack.mjs`로 가드.
- **B안: 단일 패키지 발행** — 장점: 미러 부담 0. 단점: core/remote를 별도 dep로 쓰는 소비자가 전체 CLI를 받아야 함, 발행 유연성 상실.
- **C안: monorepo 빌드 툴(turbo/tsup 등)로 자동 생성** — 장점: drift 원천 차단. 단점: 신규 빌드 인프라·학습곡선이 현재 규모에 과잉(explicit-over-clever 위반), `.mjs` 무번들 런타임 특성과 불일치.

## 결과 (Consequences)
긍정: 3패키지가 발행 시 일관성을 유지하고, 레이어별 미러 규칙이 문서화돼 신규 기여자가 `cp`/`Edit` 오용(remote import revert)을 피한다. 부정/리스크: 수동 미러라 root 변경 시 packages 누락 가능 → PR 단위 `diff -q` 체크리스트 + `release:check-mirror` + `npm pack --dry-run` size(~1MB) 검증. 관련 PR: #219(v10.18.0 mirror sync)·#314(v10.25.0 catch-up)·#320(remote mesh gap)·#222(lint baseline). SSOT는 `.claude/rules/tfx-mirror-policy.md`.
