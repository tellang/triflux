# S2 CTO 조회 축소 결과

현재 worktree에만 변경을 남겼다. 커밋, push, PR 생성은 하지 않았다. `bin/tfx-live.mjs`, `cto/hygiene-notify.mjs`, cto-pull, conductor, HUD, log-retention, route는 변경하지 않았다.

## 1. 지운 파일과 고친 파일

삭제:

- `cto/dashboard.mjs`
- `cto/hygiene-actions.mjs`
- `cto/steward.mjs`
- `packages/remote/cto/hygiene-actions.mjs`
- `packages/triflux/cto/dashboard.mjs`
- `packages/triflux/cto/hygiene-actions.mjs`
- `packages/triflux/cto/steward.mjs`
- `tests/cto/dashboard.test.mjs`
- `tests/cto/hygiene-actions.test.mjs`
- `tests/cto/steward.test.mjs`

수정:

- `.claude/rules/tfx-cto-hub-boundary.md`
- `README.ko.md`
- `README.md`
- `bin/triflux.mjs`
- `cto/collect.mjs`
- `cto/current.schema.json`
- `cto/events.mjs`
- `cto/hygiene.mjs`
- `cto/index.mjs`
- `cto/lake-root.mjs`
- `cto/status.mjs`
- `docs/README.md`
- `docs/adr/README.md`
- `docs/architecture.reading.md`
- `docs/design/cto-audit-verdict.md`
- `docs/design/cto-console-plan.md`
- `hub/lib/cto-env.mjs`
- `packages/core/hub/lib/cto-env.mjs`
- `packages/remote/cto/collect.mjs`
- `packages/remote/cto/current.schema.json`
- `packages/remote/cto/events.mjs`
- `packages/remote/cto/hygiene.mjs`
- `packages/remote/cto/lake-root.mjs`
- `packages/remote/cto/status.mjs`
- `packages/triflux/README.ko.md`
- `packages/triflux/README.md`
- `packages/triflux/bin/triflux.mjs`
- `packages/triflux/cto/collect.mjs`
- `packages/triflux/cto/current.schema.json`
- `packages/triflux/cto/events.mjs`
- `packages/triflux/cto/hygiene.mjs`
- `packages/triflux/cto/index.mjs`
- `packages/triflux/cto/lake-root.mjs`
- `packages/triflux/cto/status.mjs`
- `packages/triflux/hub/lib/cto-env.mjs`
- `packages/triflux/scripts/pack.mjs`
- `scripts/pack.mjs`
- `tests/cto/collect.test.mjs`
- `tests/cto/hygiene.test.mjs`
- `tests/cto/router.test.mjs`
- `tests/cto/status.test.mjs`
- `tests/integration/triflux-cli.test.mjs`
- `tests/unit/cto-env.test.mjs`
- `tests/unit/pack-remote.test.mjs`

추가:

- `docs/adr/0024-cto-explicit-queries-only.md`: accepted ADR, 필수 헤딩 및 상태보드 등록.
- `.triflux/plans/slop-s2-cto-cleanup.md`: 수정 전 계획 및 대체 경로 분류.
- `.triflux/plans/slop-s2-cto-result.md`: 이 결과와 최종 git 출력.

steward, event CLI, hygiene apply, dashboard와 사용하지 않는 수집원 3개를 제거했다. `collect`는 `appendCtoEvent`의 기존 잠금을 사용하며 기존 collect ref를 보존한다. 시간, 해시, 경로 라벨, JSONL, atomic write, persisted synapse reader 및 live session 정규화를 `lake-root.mjs`에 모았다. `cto/*`의 `hub/team/*` import를 제거하고 저장된 active/idle 상태만 읽는다. TTL/상태 전이 판정은 추가하지 않았다. 사람용 status는 생성 시각과 경과 시간을 한 줄로 표시한다.

## 2. 보류와 이유

항목표의 제거 대상 중 보류 없음. 직접 소비자 검색에서 지정되지 않은 실행 소비자를 발견하지 못했다. 저장소 밖의 직접 import나 동적 경로까지 보장하는 검증은 아니다.

main checkout의 기존 lake는 읽기만 했다. 2026-09-24 생성 snapshot의 sources 11개는 그대로 유지된다. 다음 명시적 collect부터 새 8개 계약으로 쓰인다. 이 작업에서는 main lake를 갱신하지 않았다.

Claude CLI 교차 검토는 홈에 세션/설정을 쓸 수 있어 사용자 홈 쓰기 금지에 따라 SKIP했다. 별도 native critic이 계획과 최종 diff를 읽기 전용으로 검토했다. 이를 Claude 교차 검토 승인으로 주장하지 않는다.

## 3. 테스트 명령과 결과

각 명령에는 `TFX_DISABLE_CODEX=0 TFX_DISABLE_ANTIGRAVITY=0`을 적용했다.

| 명령 | 통과 | 실패 |
|---|---:|---:|
| `node --test tests/cto/*.test.mjs tests/unit/cto-*.test.mjs tests/unit/pack-remote.test.mjs` | 78 | 0 |
| `node --test tests/unit/session-start-synapse.test.mjs` | 14 | 0 |
| `node --test --test-name-pattern='schema는 CLI' tests/integration/triflux-cli.test.mjs` | 1 | 0 |
| `node --test tests/unit/docs-adr-structure.test.mjs` | 3 | 0 |
| 합계 | 96 | 0 |

`rg -l "cto/" tests scripts/__tests__`가 찾은 현재 테스트 파일 전부를 첫 명령에 포함했다. session-presence가 기록 API를 사용하는 경로도 별도로 검증했다. `npm test`는 실행하지 않았다. 수정 전 CTO 기준 테스트는 114 통과, 0 실패였다.

CLI/import smoke:

- `node cto/index.mjs status --json`: exit 0, 기존 lake의 `cto-lake.v1` JSON 출력.
- `node cto/index.mjs collect --help`: exit 0, 도움말 출력. lake 쓰기 없이 조기 반환.
- `node -e "import('./cto/hygiene.mjs').then(m=>console.log(typeof m.runHygiene, typeof m.projectCtoHygiene))"`: `function function`.
- direct CLI 회귀 테스트: lake 없는 경로의 status JSON 안내와 collect help가 파일을 만들지 않음.
- persisted active/idle 및 Windows/POSIX 경로 가림, 손상 snapshot의 빈 overlay, 전체 ledger dry-run 무변경, 생성 시각/경과 시간, collect ref/잠금 계약 검증.

## 4. lint, mirror, check-sync

- `npx biome check cto tests/cto`: PASS, 15 files.
- 변경 root 코드와 테스트를 포함한 Biome 검사: PASS. 변경 전체 코드 목록으로도 검사했으며 packages는 기존 Biome 설정에서 제외된다.
- 변경 surviving `.mjs` 31개 `node --check`: PASS. 별도 typecheck 스크립트 없음.
- `node scripts/release/check-packages-mirror.mjs`: PASS. root/triflux/core 바이트 미러와 remote import/asset 검사 통과.
- `node scripts/release/check-sync.mjs`: PASS, 10.49.0.
- `git diff --check`: PASS.
- 추가한 문서/주석의 엠대시와 엔대시 0건. 스킬 변경 없음, `lint:skills`는 해당 없음.

## 5. 항목표와 다르게 처리한 것

- 원래 `cto/index.mjs`는 직접 실행 시 아무 작업도 하지 않았다. 요청한 CLI smoke가 실제 실행되도록 direct-entry guard를 추가하고 `collect --help`는 모든 쓰기 전에 반환하게 했다.
- remote에 steward/dashboard 사본은 원래 없었으므로 실제 존재한 hygiene-actions 사본만 삭제했다. core에는 CTO 디렉터리가 원래 없었다. 배럴에는 삭제 기능 export가 없어 변경할 필요가 없었다. remote core proxy는 그대로 보존하고 CTO 변경은 hunk로 반영했다.
- 기존 accepted ADR-0010/0011/0018/0022는 결정 이력이므로 본문을 유지했다. 현 안내는 ADR-0024를 참조한다.
- 단일 소비자인 `deriveRepoRootFromCwd`는 status에 두고 기존 export를 유지했다. log-retention의 유사 함수는 보호 범위라 변경하지 않았다.

변경 설명에 포함할 계약: `current.json.sources` 및 `sources.json`에서 `session_vault`, `agy`, `gbrain`이 빠져 11개에서 8개가 된다. 기존 저장 snapshot은 status로 계속 읽을 수 있다.

## 최종 git 출력

`git diff --stat`는 untracked ADR/계획/보고서를 포함하지 않는다.

### git status --short

```text
 M .claude/rules/tfx-cto-hub-boundary.md
 M README.ko.md
 M README.md
 M bin/triflux.mjs
 M cto/collect.mjs
 M cto/current.schema.json
 D cto/dashboard.mjs
 M cto/events.mjs
 D cto/hygiene-actions.mjs
 M cto/hygiene.mjs
 M cto/index.mjs
 M cto/lake-root.mjs
 M cto/status.mjs
 D cto/steward.mjs
 M docs/README.md
 M docs/adr/README.md
 M docs/architecture.reading.md
 M docs/design/cto-audit-verdict.md
 M docs/design/cto-console-plan.md
 M hub/lib/cto-env.mjs
 M packages/core/hub/lib/cto-env.mjs
 M packages/remote/cto/collect.mjs
 M packages/remote/cto/current.schema.json
 M packages/remote/cto/events.mjs
 D packages/remote/cto/hygiene-actions.mjs
 M packages/remote/cto/hygiene.mjs
 M packages/remote/cto/lake-root.mjs
 M packages/remote/cto/status.mjs
 M packages/triflux/README.ko.md
 M packages/triflux/README.md
 M packages/triflux/bin/triflux.mjs
 M packages/triflux/cto/collect.mjs
 M packages/triflux/cto/current.schema.json
 D packages/triflux/cto/dashboard.mjs
 M packages/triflux/cto/events.mjs
 D packages/triflux/cto/hygiene-actions.mjs
 M packages/triflux/cto/hygiene.mjs
 M packages/triflux/cto/index.mjs
 M packages/triflux/cto/lake-root.mjs
 M packages/triflux/cto/status.mjs
 D packages/triflux/cto/steward.mjs
 M packages/triflux/hub/lib/cto-env.mjs
 M packages/triflux/scripts/pack.mjs
 M scripts/pack.mjs
 M tests/cto/collect.test.mjs
 D tests/cto/dashboard.test.mjs
 D tests/cto/hygiene-actions.test.mjs
 M tests/cto/hygiene.test.mjs
 M tests/cto/router.test.mjs
 M tests/cto/status.test.mjs
 D tests/cto/steward.test.mjs
 M tests/integration/triflux-cli.test.mjs
 M tests/unit/cto-env.test.mjs
 M tests/unit/pack-remote.test.mjs
?? .triflux/plans/slop-s2-cto-cleanup.md
?? .triflux/plans/slop-s2-cto-result.md
?? docs/adr/0024-cto-explicit-queries-only.md
```

### git diff --stat

```text
 .claude/rules/tfx-cto-hub-boundary.md    |  18 +-
 README.ko.md                             |  10 +-
 README.md                                |  10 +-
 bin/triflux.mjs                          |  55 +--
 cto/collect.mjs                          | 190 +--------
 cto/current.schema.json                  |  20 +-
 cto/dashboard.mjs                        | 474 ----------------------
 cto/events.mjs                           | 307 +--------------
 cto/hygiene-actions.mjs                  | 355 -----------------
 cto/hygiene.mjs                          | 372 ++----------------
 cto/index.mjs                            |  30 +-
 cto/lake-root.mjs                        | 130 +++++-
 cto/status.mjs                           | 109 ++----
 cto/steward.mjs                          | 362 -----------------
 docs/README.md                           |   1 +
 docs/adr/README.md                       |   1 +
 docs/architecture.reading.md             |   2 +-
 docs/design/cto-audit-verdict.md         |  10 +-
 docs/design/cto-console-plan.md          |  17 +-
 hub/lib/cto-env.mjs                      |   7 -
 packages/core/hub/lib/cto-env.mjs        |   7 -
 packages/remote/cto/collect.mjs          | 190 +--------
 packages/remote/cto/current.schema.json  |  20 +-
 packages/remote/cto/events.mjs           | 307 +--------------
 packages/remote/cto/hygiene-actions.mjs  | 355 -----------------
 packages/remote/cto/hygiene.mjs          | 372 ++----------------
 packages/remote/cto/lake-root.mjs        | 130 +++++-
 packages/remote/cto/status.mjs           | 109 ++----
 packages/triflux/README.ko.md            |  10 +-
 packages/triflux/README.md               |  10 +-
 packages/triflux/bin/triflux.mjs         |  55 +--
 packages/triflux/cto/collect.mjs         | 190 +--------
 packages/triflux/cto/current.schema.json |  20 +-
 packages/triflux/cto/dashboard.mjs       | 474 ----------------------
 packages/triflux/cto/events.mjs          | 307 +--------------
 packages/triflux/cto/hygiene-actions.mjs | 355 -----------------
 packages/triflux/cto/hygiene.mjs         | 372 ++----------------
 packages/triflux/cto/index.mjs           |  30 +-
 packages/triflux/cto/lake-root.mjs       | 130 +++++-
 packages/triflux/cto/status.mjs          | 109 ++----
 packages/triflux/cto/steward.mjs         | 362 -----------------
 packages/triflux/hub/lib/cto-env.mjs     |   7 -
 packages/triflux/scripts/pack.mjs        |   1 -
 scripts/pack.mjs                         |   1 -
 tests/cto/collect.test.mjs               |  15 +-
 tests/cto/dashboard.test.mjs             | 294 --------------
 tests/cto/hygiene-actions.test.mjs       | 564 --------------------------
 tests/cto/hygiene.test.mjs               | 146 ++-----
 tests/cto/router.test.mjs                | 169 ++------
 tests/cto/status.test.mjs                |  99 ++++-
 tests/cto/steward.test.mjs               | 653 -------------------------------
 tests/integration/triflux-cli.test.mjs   |  19 -
 tests/unit/cto-env.test.mjs              |  22 +-
 tests/unit/pack-remote.test.mjs          |   1 -
 54 files changed, 829 insertions(+), 7556 deletions(-)
```
