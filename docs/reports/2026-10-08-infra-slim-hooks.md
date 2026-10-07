# command hook 제거 및 설치 이주 결과

작업 디렉터리는 `/Users/tellang/Projects/tools/triflux/.worktrees/infra-slim`, 브랜치는 `chore/infra-slim-hooks`다. 원 지시서 `brief-bundle1-A.md`를 전부 읽고, 이전 세션이 남긴 tracked 변경 174개와 untracked 경로 15개를 이어서 완성했다. ADR 커밋 `4ab4fb30`과 ADR-0021 frontmatter, README 상태보드는 보존했다.

## 항목별 판정

초기 판정은 구현 상태이며, 최종 판정은 아래 검증까지 반영했다.

| 항목 | 초기 | 최종 | 근거 |
| --- | --- | --- | --- |
| 1. command hook 제거와 책임 이관 | 부분 | 완료 | 핸들러와 registry 제거. Codex/AGY presence 함수 이관. route의 preflight 갱신, doctor의 stale 정리 연결. README와 세 셸 자동완성의 남은 명령 제거 |
| 2. 설치 이주 | 부분 | 완료 | 정확한 대상 경로로 hook 객체만 제거. 백업과 atomic rename, 손상 JSON 보존, 멱등성 검증. 다른 사용자 gate 경로 오탐 수정. 실제 발행 패키지의 빠진 postinstall 연결 |
| 3. update | 완료, 검증 전 | 완료 | 새 `bin/triflux.mjs setup --from-update` 자식 프로세스 실행. 캐시 및 설정 동기화는 새 코드에서 수행. hook 파일 무결성 목록 및 manager apply 제거 |
| 4. doctor | 완료, 검증 전 | 완료 | Hook Coverage, PLUGIN_ROOT 보완 및 중복 제거를 `legacy-claude-hooks` 점검으로 교체. check는 읽기 전용, fix는 정리 함수와 stale 정리 실행 |
| 5. commit-msg 및 prepare | 완료, 검증 전 | 완료 | attribution 거부. checkout 루트만 설치. 기존 local/global hooksPath 보존. npm 발행 패키지에는 prepare 없음 |
| 6. 문서 | 부분 | 완료 | rules, CLAUDE, AGENTS, setup 스킬의 폐기된 안내 정리. ADR-0021 대체 표기. 한국어 변경 문장에 엠대시 및 엔대시 없음 |
| 7. 미러 | 부분 | 완료 | 초기 불일치 5건 해결. triflux/core는 같은 바이트, remote helper 두 개는 개별 패치. 삭제 108개 경로와 개별 diff 41쌍 확인 |

## 삭제한 파일

루트 실행 코드 및 설정 28개, 루트 테스트 24개를 삭제했다. 미러 포함 삭제 경로는 108개다.

| 위치 | 삭제 파일 |
| --- | --- |
| `hooks/` | `agent-route-guard.mjs`, `cross-review-tracker.mjs`, `cto-north-star-brief.mjs`, `error-context.mjs`, `hook-adaptive-collector.mjs`, `hook-manager.mjs`, `hook-registry.json`, `hooks.json`, `keyword-rules.json`, `mcp-config-watcher.mjs`, `permission-safe-allow.mjs`, `pipeline-stop.mjs`, `post-tool-tips.mjs`, `pre-compact-snapshot.mjs`, `safety-guard.mjs`, `session-end-cleanup.mjs`, `session-start-fast.mjs`, `session-start-lake.mjs`, `subagent-tracker.mjs`, `subagent-verifier.mjs` |
| `scripts/` | `cross-review-gate.mjs`, `cross-review-tracker.mjs`, `keyword-detector.mjs`, `keyword-rules-expander.mjs`, `tfx-gate-activate.mjs` |
| `scripts/lib/` | `cross-review-utils.mjs`, `hook-utils.mjs`, `keyword-rules.mjs` |
| `scripts/__tests__/` | `keyword-detector.test.mjs`, `session-start-fast.test.mjs` |
| `tests/regression/` | `session-start-fast.test.mjs` |
| `tests/unit/` | `claude-cwd-projection-refresh.test.mjs`, `cross-review.test.mjs`, `cto-north-star-brief.test.mjs`, `hook-adaptive-collector.test.mjs`, `hook-manifest-command.test.mjs`, `hook-orchestrator.test.mjs`, `keyword-hook-audit.test.mjs`, `keyword-routing-verbs.test.mjs`, `keyword-rules-skill-targets.test.mjs`, `permission-safe-allow.test.mjs`, `pipeline-stop.test.mjs`, `post-tool-tips.test.mjs`, `pre-compact-snapshot.test.mjs`, `routing-qa.test.mjs`, `safety-guard-main-guard.test.mjs`, `safety-guard-psmux.test.mjs`, `safety-guard-wt.test.mjs`, `session-end-cleanup.test.mjs`, `session-start-cli-policy.test.mjs`, `session-start-lake.test.mjs`, `subagent-tracker.test.mjs` |

`hooks/*` 삭제는 triflux/core 미러, `scripts/*` 삭제는 triflux 미러에도 적용했다. 공용 helper 세 개는 core/remote에서도 제거했다. 루트 `tests/`는 미러하지 않았다.

## 소비자와 함수 처리

| 이전 제공 파일 또는 소비자 | 처리 |
| --- | --- |
| `hooks/session-start-fast.mjs` | `emitParticipantSessionStarted`, `registerInteractiveSession`, `heartbeatInteractiveSession` 및 필요한 내부 helper를 `scripts/lib/session-presence.mjs`로 이관 |
| `hooks/codex-session-hook.mjs`, `hooks/agy-session-hook.mjs` | 위 새 helper를 import하도록 수정. Codex 파일의 관련 주석도 갱신. 등록과 heartbeat 동작은 기존 테스트로 검증 |
| `scripts/run.cjs`, `hooks/lib/resolve-root.mjs` | 패키지 경로의 표식을 전환 stub에서 보존 대상 `codex-session-hook.mjs`로 변경. stub 없는 설치 fixture로 검증 |
| `scripts/setup.mjs` | critical/deferred의 hook 등록, fallback, 중복 제거, registry helper 및 gate 복사 항목 제거. 각 진입점은 legacy 정리를 먼저 실행 |
| `bin/triflux.mjs` | hooks schema/help/dispatch, update apply, doctor coverage 제거. cleanup 실패 시 기존 설정 오류 종료 코드 5 유지 |
| `scripts/completions/tfx.{bash,zsh,fish}` | hooks 최상위 및 하위 자동완성 제거 |
| `scripts/config-audit.mjs` | 삭제한 registry 감사 경로 제거 |
| 삭제한 cross-review, keyword, hook helper | 비 hook 실행 소비자가 남지 않음을 검색한 뒤 함께 제거 |
| 남는 테스트 | 삭제된 기능 테스트 제거, shared presence import 변경, setup의 삭제된 gate 기대값 수정 |

`scripts/ensure-codex-hooks.mjs`, `scripts/ensure-agy-hooks.mjs`, gateway 본체, synapse, hub 서버, 스킬 파일은 삭제하지 않았다. 두 ensure 스크립트에는 변경이 없다.

## SessionStart 책임의 결정

| 기존 일 | 현재 처리 |
| --- | --- |
| setup critical/deferred | 설치 postinstall, 명시적 `tfx setup`, update에서 실행. 세션 시작 자동 실행 제거 |
| preflight cache | `tfx-route.sh`가 읽기 전에 `preflight-cache.mjs --if-stale` 실행. 없거나 손상되거나 1시간 만료된 캐시만 갱신. update는 새 setup에서 갱신 |
| hub-ensure | route의 기존 실행 경로와 Codex/AGY 세션 경로 유지. Claude command hook 연결만 제거 |
| session-stale-cleanup | `tfx doctor --fix`에서 실행. 읽기 전용 doctor는 실행하지 않음 |
| MCP safety 및 gateway ensure | command hook 연결만 제거. 본체와 명시적 호출 표면 보존. 새 자동 시작 경로를 추가하지 않음 |
| Claude 로그인 변경 감지 | 세션 시작 자동 호출 제거. `scripts/claude-login-detect.mjs`는 보존 |
| CLI policy 및 CTO lake/brief 문맥 주입 | Claude hook 자동 주입 제거. route의 정책 소비와 CTO CLI는 보존 |
| presence/CTO 참가 기록 | Claude hook의 자동 관측 제거. Codex/AGY에 필요한 함수만 공용 helper로 보존 |
| gstack/session-vault/사용자 hook | settings에서 해당 객체를 보존. 새 등록이나 광역 삭제를 하지 않음 |

## 설치 이주 및 전환 stub

정리 함수는 `scripts/lib/legacy-hook-cleanup.mjs`다. 파일명과 패키지 경로를 함께 확인하고, 기존 plugin 변수 및 복사된 gate의 알려진 형식을 처리한다. `includes("triflux")` 같은 광역 판정은 쓰지 않는다. 다른 사용자의 `.claude/scripts/` 경로를 같은 설치로 보던 오탐은 회귀 테스트 후 수정했다. 패키지 출처를 확인할 수 없는 일반 `${PLUGIN_ROOT}/scripts/setup.mjs` 및 `/hooks/...` 형태는 자동 삭제하지 않는다.

혼합 entry에서는 triflux hook 객체만 제거하고, 그 결과 비게 된 entry와 event를 제거한다. 쓰기 전 `settings.json.tfx-bak-<timestamp>`를 만들고 실제 대상 파일과 같은 디렉터리의 임시 파일을 rename한다. symlink는 링크를 보존하며, 끊어진 링크와 깨진 JSON은 쓰지 않고 실패를 반환한다. 두 번째 실행은 변경과 추가 백업이 없다.

다음 두 파일은 한 릴리스 동안 남는다. stdin을 읽고 정리 함수를 한 번 호출하며, 성공과 실패 모두 stdout/stderr 없이 종료 코드 0으로 끝난다. 머리에 ADR-0023과 다음 릴리스 삭제 주석을 넣었다.

- `hooks/hook-orchestrator.mjs`
- `hooks/claude-cwd-projection-refresh.mjs`

실제 npm publish 경로는 `packages/triflux`다. 이 manifest에는 기존 postinstall이 없어 추가했고, lockfile에는 `hasInstallScript`만 반영했다. 기존 lockfile의 workspace 버전 등 이번 작업과 무관한 값은 바꾸지 않았다. 저장소용 prepare는 루트에만 두었다.

## 검증

최종 실행은 다음과 같다. 전체 `npm test`는 실행하지 않았다.

```sh
TFX_DISABLE_CODEX=0 TFX_DISABLE_ANTIGRAVITY=0 node --test \
  tests/unit/legacy-hook-cleanup.test.mjs \
  tests/unit/commit-msg-hook.test.mjs \
  tests/unit/update-fresh-setup.test.mjs \
  tests/unit/setup-legacy-hook-migration.test.mjs \
  tests/unit/tfx-route-preflight-refresh.test.mjs \
  tests/unit/preflight-cache-antigravity.test.mjs \
  tests/unit/codex-session-hook.test.mjs \
  tests/unit/agy-session-hook.test.mjs \
  tests/unit/session-start-synapse.test.mjs \
  tests/unit/synapse-stale-expire.test.mjs \
  tests/unit/doctor-macos-hooks.test.mjs \
  tests/unit/critical-fixes.test.mjs \
  tests/unit/lane2-d-routing-contract.test.mjs \
  tests/unit/mcp-cleanup-hook.test.mjs \
  tests/unit/setup-sync.test.mjs \
  tests/unit/setup-stable-node-command.test.mjs \
  tests/unit/resolve-root.test.mjs \
  tests/unit/resolve-plugin-root.test.mjs \
  tests/unit/async-pid-track-owner.test.mjs \
  tests/unit/tfx-route-preflight-all-dead.test.mjs \
  tests/integration/triflux-cli.test.mjs \
  scripts/__tests__/smoke.test.mjs \
  scripts/__tests__/skill-surface.test.mjs
```

| 검사 | 결과 |
| --- | --- |
| 최종 targeted tests | 23개 파일, 206 pass, 0 fail, 0 skip |
| 첫 targeted 실행 | 152개 중 150 pass, 2 fail. 삭제 gate 기대값과 설정 오류 종료 코드 회귀를 수정 |
| 새 회귀의 실패 확인 | 다른 사용자 gate 경로 보존, stub 없는 패키지 탐색, 발행 패키지 postinstall 누락, symlink 보존 및 emoji footer를 먼저 재현하고 수정 |
| `npm run lint` | PASS. Biome 799개 파일. 중간에 새 테스트 포맷 1건을 수정 |
| `npm run lint:skills` | PASS. 15개 스킬 |
| `npm run release:check-mirror` | PASS. triflux/core 바이트 및 remote import/asset 검사 |
| 변경 파일별 `diff -q` | PASS. triflux 31, core 8, remote 2, 총 41쌍 |
| 삭제 경로 존재 검사 | PASS. 108개 모두 부재 |
| `node --check` | PASS. 변경 JavaScript 36개 |
| 셸 구문 | route와 Bash completion의 `bash -n`, Zsh completion의 `zsh -n`, commit-msg의 `sh -n` PASS |
| commit-msg 실제 셸 실행 | sh, macOS Bash 3.2.57, Zsh에서 정상 메시지 허용 및 attribution/emoji trailer 거부, 9개 사례 PASS |
| Bash 자동완성 | hooks 후보 부재 PASS |
| Fish 구문 | SKIP. fish 실행 파일 없음 |
| `git diff --check` | PASS |
| `npm pack --workspace=packages/triflux --dry-run --ignore-scripts --json` | PASS. 449개 파일, 압축 3,306,903 bytes. setup, cleanup helper, 두 stub 포함 |
| 별도 typecheck/build | SKIP. package scripts에 해당 명령 없음. JavaScript 구문과 Biome으로 검사 |

npm lifecycle 문서는 Context7의 `/npm/cli`로 확인했다. prepare가 local/git install과 pack/publish에서도 실행될 수 있어 checkout 가드를 검토했다. 근거: https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/scripts.md

## 잔존 검색

삭제한 루트 실행 파일 28개의 basename은 중복 이름을 합치면 27개다. 해당 이름을 `rg -n --hidden -P`로 검색했다. `.git`, `tests`, `**/__tests__`, `docs/_archive`를 제외했다. 이 보고서를 만들기 전 결과는 40개 파일, 176행이며, 문자열 잔존을 0이라고 보고하지 않는다.

| 분류 | 행 수 | 판단 |
| --- | ---: | --- |
| legacy cleanup 목록과 matcher, 루트 및 미러 4개 | 92 | 설치 이주에 필요한 의도적 문자열 |
| ensure-codex/agy의 `hooks.json`, 루트 및 미러 | 8 | 삭제한 Claude plugin manifest와 다른 파일. 보존 대상 |
| codex-plugin-cc reference 문서의 `hooks.json` | 12 | 외부 플러그인 조사 기록 |
| `hub/promote-penalties.mjs`와 두 미러의 주석 | 3 | 이전 생산자 설명. 실행 import나 호출 없음 |
| CHANGELOG, ADR, 계획, PRD, 연구 기록 | 61 | 과거 기록. ADR-0023 및 ADR-0021 당시 판단을 포함하므로 보존 |

삭제한 모듈을 가리키는 JavaScript `import/from/require` 참조는 0건이다. 활성 CLI, completion, README, rules, setup 스킬에서 `tfx hooks` 및 `triflux hooks`는 0건이다. `ensureHooksInSettings`, `hook-manager apply`, `computeHookCoverage` 실행 잔존도 없다. 보고서 자체의 삭제 목록은 설명용 참조다.

원시 검색 결과는 `/tmp/infra-slim-deleted-rg.log`, 최종 테스트 출력은 `/tmp/infra-slim-tests-final.log`에 남겼다.

## 남은 한계

- 실제 사용자 HOME에 setup 또는 doctor --fix를 적용하지 않았다. 설치 이주는 임시 HOME fixture, doctor 점검 모드는 임시 HOME의 CLI 실행으로 확인했다. doctor fix의 전체 시스템 정리는 실기기에서 실행하지 않았다.
- 실제 npm update, 원격 설치, Windows 런타임은 실행하지 않았다. 새 프로세스 setup은 임시 설치 파일로 실제 자식 프로세스를 실행해 검증했다.
- 정적 검색은 저장소 밖에서 삭제 모듈을 직접 호출하는 소비자까지 증명하지 못한다. 두 전환 stub이 이전 Claude 진입점의 이주를 담당한다.
- Fish 실행 검사는 환경에 바이너리가 없어 미확인이다.
- 과거 문서와 penalty 주석에는 삭제 파일명이 남아 있다. 활성 import/호출과 구분했다.
- 기존 Git hooksPath는 보존한다. 다른 hooksPath가 설정된 checkout에서는 prepare가 경고하고 이 저장소 hook을 자동 덮어쓰지 않는다.
- 설정 JSON이 손상됐거나 쓰기 권한이 없으면 설치 이주는 실패로 보고하며 postinstall도 실패한다. 깨진 설정을 덮어쓰거나 성공으로 감추지 않는 쪽을 유지했다. 전환 stub만 실패를 조용히 흡수한다.
- 패키지 출처를 확인하지 못한 일반 plugin 변수 및 붕괴한 `/hooks/...` 경로는 남길 수 있다. 다른 플러그인과 사용자 hook을 지우지 말라는 범위 제한 때문에 광역 삭제로 보완하지 않았다.
- gateway SessionStart 자동 실행은 제거했다. 별도 시작 수단이 없는 설치에서는 gateway를 명시적으로 시작해야 한다. hook으로만 연결된 진입점을 끊되 본체를 보존하라는 이번 지시의 범위다.

## 교차 리뷰

Claude Opus를 `--permission-mode plan`의 읽기 전용 호출로 실행했다. 결과는 `/tmp/infra-slim-claude-review.log`에 있다.

| 지적 | 처리 |
| --- | --- |
| settings symlink를 rename으로 덮어씀 | 실제 대상 파일을 교체하고 링크를 보존하도록 수정 및 회귀 검증 |
| emoji가 붙은 Claude footer 누락 | commit-msg의 생성 footer 판정을 보완하고 실제 형태로 회귀 검증 |
| gateway 자동 시작 경로 소멸 | 이번 지시서가 명시한 hook 진입점 제거로 유지. 영향은 위 한계에 기록 |
| 손상 JSON이 npm postinstall도 실패시킴 | JSON을 보존하고 실패를 보고하는 정책으로 유지. stub은 비차단 유지 |
| 출처가 불분명한 옛 변수 및 붕괴 경로 미제거 | 다른 사용자와 플러그인 hook 보존 요구를 우선. 자동 삭제 범위의 한계로 기록 |
| 기존 hooksPath가 있어 checkout hook 비활성 | 기존 hooksPath를 덮어쓰지 말라는 지시대로 유지. 커밋 메시지는 저장소 guard로 따로 검증 |

## 커밋 단위

설정 정리와 stub, 설치/update/doctor 연결, command hook 제거, commit-msg 가드, 문서 정리로 나눈다. 각 코드 변경의 미러는 해당 논리 단위에 함께 넣는다. 커밋 메시지는 한국어이며 AI trailer와 엠대시를 사용하지 않는다.

| 커밋 | 내용 |
| --- | --- |
| `7279e94d` | 이전 설정 정리와 전환 stub |
| `23674e90` | 새 setup 실행과 설치 이주, update/doctor 및 캐시 연결 |
| `0b62f0d2` | command hook과 키워드 라우팅 제거, presence 함수 보존 |
| `8935f03d` | AI trailer 차단 hook과 prepare 가드 |
| 이 보고서가 포함된 마지막 커밋 | 문서와 설치 이주 검증 기록 |
