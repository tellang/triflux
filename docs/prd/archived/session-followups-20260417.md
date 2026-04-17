# PRD: 2026-04-17 세션 follow-up 5건 (pack 동기화 + 3 fix + #100 조사)

## 목표

2026-04-17 세션에서 PR #86/#107 merge 후 남은 follow-up 5건을 병렬 shard로 처리한다. 독립 파일 스코프를 유지해 merge 충돌을 최소화한다.

## 제약 (공통)

- Codex 작성 코드 → 최종 통합 단계에서 Claude 교차 리뷰
- `codex exec` 직접 호출 금지 (headless-guard 경유)
- `packages/*` 미러는 `scripts/pack.mjs` 로만 생성 — 수동 수정 금지 (shard 1 제외)
- main 기준 worktree

## Shard: pack-mirror-sync
- agent: codex
- files: packages/core/**, packages/remote/**, packages/triflux/**, scripts/pack.mjs
- prompt: |
    scripts/pack.mjs 를 실행해 packages/core, packages/remote, packages/triflux 세 미러를 원본 hub/ 와 완전 동기화한다. PR #86 merge 로 추가된 다음 파일들이 packages/* 미러에 반영되어야 한다.
    - hub/workers/codex-app-server-worker.mjs
    - hub/workers/lib/jsonrpc-stdio.mjs
    - hub/workers/factory.mjs 변경분
    - hub/workers/interface.mjs 변경분
    - tests/fixtures/fake-codex-app-server.mjs
    - tests/integration/codex-app-server-streaming.test.mjs
    - tests/unit/{codex-app-server-worker,jsonrpc-stdio,packages-sync,worker-factory}.test.mjs

    실행 순서:
    1) `node scripts/pack.mjs` 실행. stdout/stderr 확인.
    2) `git status --short` 로 어떤 파일이 변경되었는지 확인.
    3) `node --test tests/unit/packages-sync.test.mjs` 로 미러 대칭성 PASS 확인. (이전에는 skip 상태였을 수 있음 — 이제 pass 되어야 한다.)
    4) 변경된 packages/* 파일들을 단일 커밋으로 스테이징.
       커밋 메시지: `chore(packages): pack.mjs 재실행으로 PR #86 신규 파일 packages/* 미러 동기화`
    5) push 는 최종 통합 단계에서 수행 — 이 shard 에서는 커밋까지만.

## Shard: windows-prefix-collision-fix
- agent: codex
- depends: pack-mirror-sync
- files: hub/team/psmux.mjs, tests/unit/psmux.test.mjs
- prompt: |
    Codex cross-review 에서 지적된 Windows `killOrphanPipeHelpers`/`killOrphanMcpProcesses` 의 prefix-collision 가능성을 해소한다.

    현재 Windows 패턴은 `tfx-headless[/\\\\]${safeSession}` 로 세션명 뒤 trailing boundary 가 없어서 `session2-worker-1.txt` 같은 sibling 세션도 매칭 가능.

    조치:
    1) hub/team/psmux.mjs 의 두 함수 Windows 경로에서 `tfx-headless[/\\\\]${safeSession}[-./\\\\]` 로 boundary 추가.
    2) safeSession 을 `escapeRegex` (이번 세션 추가된 helper) 로 감싸 메타문자 이스케이프. 기존 macOS 경로가 이미 사용 중이므로 패턴 일관 유지.
    3) `tests/unit/psmux.test.mjs` 의 기존 `"killPsmuxSession은 ..."` 테스트 부근에 Windows 전용 회귀 테스트 1 건 추가 (`process.platform !== "win32"` skip). 패턴에 escape 와 trailing boundary 가 모두 존재하는지 assertion.
    4) node --check + 관련 unit test PASS 확인 후 커밋.
       메시지: `fix(psmux): Windows killOrphan* 패턴에 trailing boundary + regex-escape 추가`

    packages/* 미러는 pack.mjs 가 별도 shard 에서 처리하므로 건드리지 않는다.

## Shard: tfx-swarm-base-option
- agent: codex
- depends: pack-mirror-sync
- files: hub/team/swarm-cli.mjs, tests/unit/swarm-cli.test.mjs
- prompt: |
    tfx swarm CLI 에 `--base <branch>` 옵션을 추가한다. 기본값은 `main`. 값은 `createSwarmHypervisor({ baseBranch })` 로 전달되어 worktree 가 main 이 아닌 지정 브랜치 위에서 생성될 수 있게 한다.

    조치:
    1) hub/team/swarm-cli.mjs 의 인자 파서에 `--base` 플래그 추가. 값 검증: 비어 있지 않아야 하고 공백 포함 금지.
    2) hypervisor 생성 시 baseBranch 전달.
    3) CLI usage 메시지 갱신 (`tfx swarm <prd-path> [--dry-run|--json|--filter <shard>|--base <branch>]`).
    4) tests/unit/swarm-cli.test.mjs 신규 작성. 최소 3 건:
       - `--base feat/foo` 파싱 성공
       - `--base` 값 누락 시 명시적 에러
       - `--base` 미지정 시 baseBranch === 'main' 기본값
    5) node --check + 신규 test PASS 확인 후 커밋.
       메시지: `feat(swarm-cli): --base 옵션으로 PR 브랜치 기반 swarm 지원`

## Shard: headless-cwd-propagation-fix
- agent: codex
- files: tests/integration/headless-cwd-propagation.test.mjs, hub/team/headless.mjs, hub/team/backend.mjs
- prompt: |
    tests/integration/headless-cwd-propagation.test.mjs 가 현재 main 에서 실패. 원인은 commit `1c5e5d1` 의 `codex exec --cwd` 제거 — cwd 전파가 Set-Location 프리픽스 경로로 대체됐는데 테스트 assertion 이 `--cwd` flag 존재를 여전히 검증.

    조치:
    1) 실패 테스트 assertion 을 현재 아키텍처에 맞춰 갱신: Set-Location prefix 경로가 worktree cwd 를 명시적으로 정의하는지 검증 (`Set-Location -LiteralPath '<worktree>'` 프래그먼트 포함 여부).
    2) 백엔드/headless 쪽에서 cwd 가 실제 command 문자열 앞에 주입되는지 확인. 주입 로직이 결함이라면 수정.
    3) node --test tests/integration/headless-cwd-propagation.test.mjs PASS 확인.
    4) 커밋 메시지: `fix(headless): cwd propagation 회귀 해소 — Set-Location 프리픽스 기반으로 테스트 갱신`

## Shard: issue-100-codex-spawn-stall
- agent: codex
- files: scripts/tfx-route.sh
- prompt: |
    Issue #100 [Critical] — `scripts/tfx-route.sh` 경유 codex spawn 이 prompt 수신 전 stall (exit 0 with 122B stdout). codex exec 직접 호출은 정상 작동.

    재현:
    ```bash
    bash ~/.claude/scripts/tfx-route.sh codex 'long prompt 1500+ chars' implement
    ```

    관찰:
    - stdout: `[tfx-route] Codex 버전: 0.121.0` 한 줄 후 종료
    - result.log 미갱신 (result write 단계 진입 전 fail)

    조치:
    1) scripts/tfx-route.sh 를 처음부터 끝까지 읽고 codex 호출 경로에서 어떤 단계가 stall 유발하는지 파악. 특히 긴 prompt (1500+ chars) 전달 방식 — stdin pipe? argv? heredoc? 임시 파일?
    2) 재현 스크립트 작성 후 verbose mode 또는 set -x 로 어느 line 에서 중단되는지 확인.
    3) 원인 규명 후 fix (예: stdin redirect 이슈, buffer overflow, env var 충돌). Issue #100 body 가 힌트 제공.
    4) fix 후 재현 시나리오 정상 동작 확인. `tfx-route.sh codex 'echo hi' implement` 포함 최소 2 회 검증.
    5) 커밋 메시지: `fix(tfx-route): codex spawn stall 해소 (#100) — <근본 원인 한 줄 요약>`
    6) scripts/tfx-route.sh 수정만 하고 packages/triflux/scripts/tfx-route.sh 미러는 pack shard 가 별도 처리.

    복잡도가 높으면 조사 결과를 Issue #100 에 comment 로 남기고 fix 는 별도 PR 로 분리해도 무방 (그 경우 커밋 없이 Issue comment 만 추가).

## 테스트 명령

```bash
node --test tests/unit/packages-sync.test.mjs
node --test tests/unit/psmux.test.mjs
node --test tests/unit/swarm-cli.test.mjs
node --test tests/integration/headless-cwd-propagation.test.mjs
```

## Codex 실행 제약 (자동 삽입됨)
<!-- codex-swarm 스킬이 이 섹션을 자동으로 프롬프트에 주입합니다. -->
- stdin redirect 금지: `codex < file` → "stdin is not a terminal" 에러
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec` 는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox 와 충돌)
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능 — 순차 실행 권장

## 완료 조건 (필수)

1. 각 shard 별 독립 커밋 (총 5 개 커밋 예상, #100 은 조사만으로 끝날 수 있음)
2. 각 shard 의 테스트 PASS 확인
3. swarm 의 자동 merge 가 main 에 5 개 shard 를 순서대로 통합
4. 통합 후 최종 `node --test tests/unit/` 전체 smoke check
5. `git push origin main` 은 **swarm 완료 후 별도 수동 단계** — 자동 push 금지
