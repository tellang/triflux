# packages/ mirror 정책 — 3-layer single source

## 멘탈 모델

> 근거(why): [ADR-0005 — packages/ 3-layer single-source 미러](../../docs/adr/0005-packages-three-layer-mirror.md). 이 문서가 SSOT(어떻게), ADR은 결정 이력(왜).

triflux 는 root 와 `packages/{core,remote,triflux}/` 3개 published 레이어를 동시에 유지한다. root 가 source of truth 다. mirror 작업은 drift 가 생기지 않도록 레이어별 룰을 다르게 적용한다.

| 레이어 | 역할 | mirror 룰 |
|--------|------|----------|
| `packages/core` (`@triflux/core`) | 공용 라이브러리 (hub primitives, scripts/lib helper) | root 와 byte-identical cp |
| `packages/remote` (`@triflux/remote`) | 원격 entry / store / pipe / server / scripts helper | root subset + `@triflux/core/...` import path 변환 |
| `packages/triflux` (`triflux` npm) | 사용자 facing CLI / runtime / skills | npm publish files 기준 byte-identical mirror |

## 레이어별 정책

### `packages/core` — byte-identical cp

`packages/core/hub/lib/`, `packages/core/scripts/lib/` 같은 helper 묶음은 root 와 같은 내용이다. import 변환 없음. 단순 cp.

| 행위 | 처리 |
|------|------|
| root `hub/lib/foo.mjs` 신규 | `cp hub/lib/foo.mjs packages/core/hub/lib/` |
| root `hub/lib/foo.mjs` 수정 | 같은 cp 또는 두 곳 동시 Edit |
| 검증 | `diff -q hub/lib/foo.mjs packages/core/hub/lib/foo.mjs` exit 0 |

#### `packages/core/hub/team` — minimal individual mirror

`hub/team/*` 전체는 `packages/triflux/hub/team/` 와 `packages/remote/hub/team/` mirror 대상이다. `packages/core` 는 `hub/team/*` 전체를 mirror 하지 않는다. 다만 `packages/core/hub/bridge.mjs` 가 `./team/*` 를 self-import 하는 개별 파일은 `packages/core/hub/team/` 에 byte-identical cp 한다.

현재 minimal mirror 예시는 PR #314 의 `packages/core/hub/team/retry-state-machine.mjs` 다. 신규 파일을 추가할 때는 먼저 `grep -n './team/' packages/core/hub/bridge.mjs` 로 `bridge.mjs` 의 `./team/*` 의존 파일을 식별하고, 필요한 파일만 `packages/core/hub/team/` 으로 cp 한 뒤 root 파일과 `diff -q` 로 확인한다.

### `packages/remote` — import path 변환

`packages/remote/` 는 `packages/core` 를 외부 dep 로 import 한다. 그래서 root 의 상대 경로 import 를 그대로 cp 하면 깨진다.

| 위치 | import 형태 |
|------|------------|
| `hub/team/conductor.mjs` | `import { broker } from "../account-broker.mjs"` |
| `packages/triflux/hub/team/conductor.mjs` | `import { broker } from "../account-broker.mjs"` (root 와 동일) |
| `packages/remote/hub/team/conductor.mjs` | `import { broker } from "@triflux/core/hub/account-broker.mjs"` |

mirror 변경은 **`Edit` 도구로 개별 수정**한다. `cp` 사용 금지 (덮어쓰면 import path 가 revert 됨).

| 행위 | 처리 |
|------|------|
| root 새 파일 | dep 없으면 `cp`, 내부 dep 있으면 `Edit` 3 곳 (root / packages/triflux / packages/remote 각각) |
| root 수정 | `Edit` 으로 3 곳 동시 수정. import path 만 packages/remote 에서 다름 |
| 검증 | `git diff` 로 `@triflux/core/...` 경로가 살아있는지 확인. cp 후 import 경로 revert 여부 점검 |

### `packages/triflux` — npm files 기준 byte-identical

`packages/triflux/` 는 사용자가 `npm install -g triflux` 로 받는 패키지다. root `package.json` 의 `files` 필드와 `packages/triflux/package.json` 의 `files` 필드 교집합에 들어가는 것은 byte-identical 로 mirror 한다.

| 행위 | 처리 |
|------|------|
| root `bin/triflux.mjs` 수정 | `packages/triflux/bin/triflux.mjs` 도 동일 변경 |
| root `scripts/__tests__/release-governance.test.mjs` 수정 | mirror 대상 (PR #222 패턴) |
| root `tests/unit/foo.test.mjs` 수정 | **mirror 제외** (npm files 미포함) |
| 검증 | `diff -rq` 로 packages/triflux 와 root 의 published 경로 비교 |

## mirror 범위 (in / out)

**mirror 대상** (root → packages 동기 필수):
- `hub/lib/*` → `packages/core/hub/lib/`, `packages/triflux/hub/lib/`
- `hub/team/*`, `hub/*.mjs` (entry/runtime) → `packages/triflux/hub/`, `packages/remote/hub/` (해당 모듈만; `packages/core/hub/team/` 는 self-import 대상만 minimal mirror, 예: `retry-state-machine.mjs`)
- `mesh/*` → `packages/core/mesh/`, `packages/triflux/mesh/` (PR #320 — root subset)
- `scripts/lib/*` → `packages/core/scripts/lib/`, `packages/triflux/scripts/lib/`, `packages/remote/scripts/lib/` (PR #314 catch-up — remote 는 root subset, root-relative 의존 시 `@triflux/core/...` 로 import 변환)
- `scripts/release/*`, `scripts/__tests__/*` → `packages/triflux/scripts/` (publish 포함)
- `bin/*` → `packages/triflux/bin/`
- `hooks/*`, `hud/*` → `packages/triflux/{hooks,hud}/` + `packages/core/{hooks,hud}/` (core 도 `package.json` files 에 `hooks`, `hud` 포함 → byte-identical cp 2곳. PR #376 에서 hooks/pipeline-stop.mjs·hud/context-monitor.mjs 가 core 에도 미러됨을 실측 확인)
- `config/*` → `packages/triflux/config/` (core·remote 는 config 미러 안 함)

**mirror 제외**:
- `tests/` (root + `packages/{core,remote}/tests/`) — npm files 에 없음. 만약 packages 쪽에 untracked tests 디렉토리가 만들어졌으면 그건 잘못된 mirror 시도다.
- `references/codex-snapshots/`, `references/gemini-snapshots/` — packages/triflux files 부정 패턴 (`!references/codex-snapshots`) 으로 명시 제외.
- `.tfx/`, `.omc/`, `.claude/`, `.gemini/`, `.codex/` — runtime / config 디렉토리.
- `skills/tfx-workspace` — 사용자별 workspace, packages/triflux files 부정 패턴 (`!skills/tfx-workspace`).
- `failure-reports/` (any depth) — 진단 산출물.

## 신규 binary 산출물 추가 시

shard 가 `references/{codex,gemini}-snapshots/` 같은 경로에 100MB+ binary 를 쓰는 흐름을 추가하면, `.gitignore` 만으로 부족하다. `packages/triflux/package.json` 의 `files` 필드에 부정 패턴을 동반해야 한다. 안 그러면 npm pack tarball 이 300MB+ 로 폭증해 publish 가 거부된다.

| 추가 위치 | files 부정 패턴 |
|----------|---------------|
| `references/<new>-snapshots/` | `"!references/<new>-snapshots"` |
| `skills/<new>-workspace` | `"!skills/<new>-workspace"` |
| `**/failure-reports/` | `"!**/failure-reports"` |

검증: ship 전 `cd packages/triflux && npm pack --dry-run` 결과 size 가 ~1MB (아닌 경우 binary 새 path 누수 의심).

## 검증 체크리스트 (PR 단위)

새 PR 이 packages mirror 를 건드리면 머지 전 아래를 통과한다.

| 단계 | 명령 | 기대 결과 |
|------|------|----------|
| 1 | `git diff --name-only origin/main..HEAD \| grep -E '^(hub/|scripts/lib/|scripts/__tests__/|scripts/release/|bin/|hooks/|hud/|mesh/|config/)'` | mirror 가 필요한 root 변경 목록 |
| 2 | 위 목록의 각 파일이 packages/triflux 에 byte-identical 로 존재하는지 `diff -q` | exit 0 |
| 3 | hub/lib, scripts/lib, mesh, hooks, hud 변경분이 packages/core 에 cp 됐는지 `diff -q` | exit 0 |
| 4 | packages/remote/hub/team/ 가 변경됐다면 `grep "@triflux/core/" packages/remote/hub/team/*.mjs` | import 경로 살아있음 |
| 5 | tests/ 변경이 packages/{core,remote}/tests/ 에 untracked 로 추가됐는지 | **금지 — staging 회수** |
| 6 | npm publish 영향 시 `cd packages/triflux && npm pack --dry-run` size | ~1MB |
| 7 | mirror 동기화 PR 이라면 PR body 에 IDENTICAL/DIFFERENT 카운트 (PR #219 패턴 — 13 modified + 3 new = 16 files, 9 IDENTICAL + 4 DIFFERENT) | 명시 |

## 안티패턴

| 패턴 | 문제 | 대체 |
|------|------|------|
| `cp hub/team/foo.mjs packages/remote/hub/team/` | import path 가 `../account-broker.mjs` 로 덮어써져 remote 패키지가 자기 모듈을 못 찾음 | `Edit` 으로 packages/remote 만 `@triflux/core/...` 유지 |
| `cp -r tests/ packages/core/tests/` | npm files 미포함이라 publish 에 안 들어감, untracked 디렉토리만 늘어남 | tests 는 mirror 제외 — 시도 자체 금지 |
| 신규 binary path 추가 시 `.gitignore` 만 추가 | `packages/triflux/package.json` files 가 root 와 다르므로 npm pack 이 binary 포함, tarball 폭증 → publish 실패 | files 부정 패턴 동반 추가 + `npm pack --dry-run` 검증 |
| root 만 수정하고 packages 누락한 채 ship | v10.x.x 릴리즈 후 chore PR 로 늦게 sync (PR #219 패턴) | 코드 변경 PR 안에서 동시에 mirror — sync chore PR 은 backfill 용일 때만 |
| packages/remote 변경 후 import path 검증 생략 | 머지 후 `npm install @triflux/remote` 한 사용자가 `Cannot find module` 으로 깨짐 | `git diff` 로 `@triflux/core/...` 경로 1회 grep 확인 |

## 관련 메모리

- `feedback_packages_mirror_two_layer.md` — 2-layer 룰 (core 단순 cp / remote import 변환)
- `feedback_packages_mirror_scope_tests_excluded.md` — tests/ 제외 사유 (npm files 미포함)
- `feedback_remote_package_mirror.md` — packages/remote 는 cp 금지 (import path revert 사고)
- `feedback_npm_pack_binary_exclusion.md` — files 부정 패턴 (binary 폭증 회피)
- `feedback_indexof_open_prefix_pattern.md` — assertion boundary marker 패턴 (PR #218)

## 관련 PR

| PR | 사유 |
|----|------|
| #219 | packages/{core,remote} mirror sync v10.18.0 hub state — 13 modified + 3 new = 16 files |
| #222 | packages/triflux/scripts/__tests__/release-governance.test.mjs byte-identical mirror sync (lint optional chain fix 동시 적용) |
| v10.16.0 ship 1차 publish fail | binary path `references/codex-snapshots/` 추가 후 files 부정 패턴 누락 → 317.5MB → 1MB fix (commit 74a9f2d) |

## 메모

- 이 문서는 정책 추출본이다. 실제 mirror 자동화 (있다면 `scripts/pack.mjs`) 의 구현 세부는 코드 주석 참조.
- packages 구조가 변경되면 (예: `packages/cli` 신설) 이 문서를 가장 먼저 업데이트한 뒤 코드 작업한다.
