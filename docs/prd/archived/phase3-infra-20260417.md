# Phase 3 Infra Batch — swarm dispatch

스코프: Issue #78, #80, #87, #89 병렬 구현. 각 shard는 worktree 격리로 실행되며
완료 후 `mergeOrder`대로 통합된다.

**공통 가드**:
- main 브랜치에서 직접 커밋 금지 (swarm은 shard branch에서만 작업). `TRIFLUX_GIT_BRANCH_GUARD=1` env 존재 시 main에서 exit.
- 각 shard는 `files` 필드의 파일만 수정 (file-lease 강제).
- 완료 기준: 수락 기준(Acceptance) 충족 + 관련 단위 테스트 추가/유지.
- shard 내부에서 `git checkout main` / `git reset --hard origin/main` 사용 금지.
- 커밋은 shard 전용 브랜치(swarm-hypervisor가 생성)에서만 수행.

## Shard: broker-auth-sync
- agent: codex
- files: hub/account-broker.mjs, hub/server.mjs, scripts/sync-codex-auth.mjs
- prompt: |
    Issue #78 구현 — Hub 캐시 ↔ ~/.codex/auth.json 양방향 동기화.

    목표:
    `~/.codex/auth.json`이 외부(codex login 등)로 갱신돼도 hub 캐시
    `~/.claude/cache/tfx-hub/codex-auth-<account>.json`과 자동 동기화되도록 한다.
    현재는 stale 캐시로 `refresh_token_reused` 401 에러 발생.

    구현 지시:
    1. `hub/account-broker.mjs`에 다음 추가:
       - `syncAuthFromSource(accountId)` — source mtime > cache면 cache로 copy
       - `syncAuthToSource(accountId)` — broker rotate 후 원본에도 반영 (선택)
       - 파일 잠금(fs.promises.open with O_WRONLY|O_CREAT|O_EXCL 패턴) 중복 방지
       - lease() 직전 `syncAuthFromSource` 자동 호출 (옵션 `autoSync=true` 기본)
    2. `hub/server.mjs` startup에서 등록된 각 account에 대해 syncAuthFromSource 호출
    3. `scripts/sync-codex-auth.mjs` 수동 실행용 헬퍼:
       - `node scripts/sync-codex-auth.mjs --account pte1024 --direction from-source`
       - `--direction from-source|to-source|both`

    Acceptance:
    - lease 시 stale auth 자동 감지 → 최신 파일 사용
    - 단위 테스트 3종: mtime 기반 sync 판정, 양방향 복사, 동시 lease 시 잠금
    - 기존 broker 공개 API (lease/release/reload/snapshot) 깨지지 않음

    주의:
    - 절대경로만 사용. `homedir()` + `join()`
    - account.json 없는 계정은 skip (graceful)
    - Windows/POSIX 모두 지원 (platform.mjs 유틸 참고)

## Shard: swarm-failed-cleanup
- agent: codex
- files: hub/team/swarm-hypervisor.mjs, hub/team/worktree-lifecycle.mjs
- prompt: |
    Issue #80 구현 — 실패 shard worktree 자동 정리.

    목표:
    shard가 F1_crash/F2_ratelimit/F3_stall 등으로 실패하면
    `.codex-swarm/wt-<shard>/` 디렉토리와 관련 브랜치를 자동 제거.
    성공 shard는 유지(merge 경로). keepFailedWorktrees 옵션으로 보존 가능.

    구현 지시:
    1. `worktree-lifecycle.mjs`에 `cleanupWorktree({ worktreePath, branchName, rootDir, force=false })` 추가 (없으면):
       - `git -C rootDir worktree remove --force worktreePath`
       - `git -C rootDir branch -D branchName` (exists when possible)
       - path prefix 안전 검증: `.codex-swarm/wt-` 또는 `.triflux/` 하위만 허용
       - 메인 working tree(`rootDir` 자체) 삭제 차단 (절대 안전장치)
    2. `swarm-hypervisor.mjs` shutdown 또는 cleanup 훅에서:
       - `failures.has(shardName)` && !opts.keepFailedWorktrees 인 shard에 대해 cleanupWorktree 호출
       - 이벤트 로그: `worktree_auto_cleanup` { shard, worktreePath, reason }
    3. createSwarmHypervisor opts에 `keepFailedWorktrees?: boolean` (기본 false) 추가

    Acceptance:
    - 실패 shard 종료 시 .codex-swarm/wt-<shard>/ 제거 + branch delete
    - keepFailedWorktrees=true면 보존 (디버깅용)
    - 단위 테스트 3종: 실패 자동 cleanup, keepFailed 보존, main 경로 차단
    - 성공 shard는 영향 없음 (기존 merge 경로 유지)

    주의:
    - 원격 shard (shard.host 지정)는 이 범위 밖 (별도 Issue)
    - 기존 #94 버그 수정(shard.worktreePath) 가정 깨지지 않게 유지
    - 쇼트닝 필요하면 기존 `.codex-swarm` 경로 글롭으로 stale 검사 옵션 추가

## Shard: auto-swarm-dispatch
- agent: codex
- files: packages/triflux/skills/tfx-auto/SKILL.md, skills/tfx-auto/SKILL.md
- prompt: |
    Issue #87 구현 — tfx-auto가 "2+ 태스크 + 코드 변경" 감지 시 tfx-swarm 자동 dispatch.

    목표 (문서 업데이트):
    tfx-auto SKILL 라우팅 테이블에서 2+ 태스크의 dispatch 엔진을
    "무조건 multi"에서 "코드 변경 감지 시 swarm, 읽기 전용이면 multi"로 분기.

    구현 지시:
    1. skills/tfx-auto/SKILL.md 라우팅 테이블 업데이트:
       | 입력 특성 | 엔진 |
       |-----------|------|
       | 1 태스크 S | 직접 실행 |
       | 1 태스크 M+ | pipeline |
       | 2+ 태스크 + 코드 변경 **없음** | tfx-multi |
       | 2+ 태스크 + **코드 변경 포함** | **tfx-swarm** (자동, 신규) |
       | 원격 + 코드 변경 | tfx-swarm (shard host:) |
    2. 판정 기준 섹션 추가:
       - shard.files 중 `src/`, `hub/`, `bin/`, `packages/`, `tests/` 매치 여부
       - agent 유형: executor/build-fixer/spark/debugger → 편집 계열 → swarm 강제
       - 명시 오버라이드: "multi"/"multi로" 키워드 있으면 multi 유지
    3. 예제 3개 추가:
       - swarm 선택 케이스: "A, B, C 각각 다른 모듈 수정해"
       - multi 유지 케이스: "파일 3개 read-only로 분석해"
       - 사용자 override: "multi로 병렬 리뷰"
    4. packages/triflux/skills/tfx-auto/SKILL.md에도 동일 반영 (미러).

    Acceptance:
    - 문서 수정만 (SKILL.md 두 파일)
    - 라우팅 테이블, 판정 기준, 예제 3개 반영
    - 기존 multi/pipeline 케이스 보존

    주의:
    - 코드 변경 X (SKILL.md만)
    - SKILL.md 두 파일이 diff 내용 동일해야 함 (drift 방지)

## Shard: psmux-safe-alternative
- agent: codex
- files: hub/team/psmux.mjs, hooks/safety-guard.mjs
- prompt: |
    Issue #89 구현 — psmux kill-session 차단 대안 API.

    목표:
    CLAUDE.md 원칙("차단과 대안은 항상 쌍") 준수. psmux kill-session 차단은
    유지하되 정식 wrapper API를 제공해 데드락 방지.

    구현 지시:
    1. `hub/team/psmux.mjs`에 공개 함수 추가 (기존 export 유지):
       - `listSessions({ filterTitle?, olderThanMs? })` — 활성 psmux 세션 목록
       - `killSessionByTitle(titlePattern)` — title prefix/regex 안전 kill
       - `pruneStale({ olderThanMs = 3600000, dryRun? })` — idle 세션 일괄 제거
       - 내부적으로 `psmux list-sessions -F` 파싱 + `psmux kill-session` 호출
    2. `hooks/safety-guard.mjs`:
       - 원시 `psmux kill-session` 명령은 계속 차단
       - `node hub/team/psmux.mjs --internal kill-by-title <pat>` 래퍼 호출은 허용
       - 차단 메시지에 대안 API 안내 추가

    Acceptance:
    - psmux.mjs에 세 함수 export + CLI flag `--internal` 인식
    - safety-guard: 원시 명령 차단 유지, 래퍼 허용
    - 단위 테스트 3종: listSessions 파싱, killSessionByTitle 역조회, pruneStale 필터
    - CLAUDE.md <psmux-wt> 섹션에 API 테이블 업데이트

    주의:
    - psmux 미설치 환경에서 graceful (에러 메시지만)
    - .claude/cleanup-bypass 하드코딩 우회는 **제거하지 않음**(별도 cleanup PR)
    - 비동기 child_process 에러 전파
