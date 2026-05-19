# Issue #281 — auto router 자동 swarm dispatch (swarm CLI 전용)

> swarm-planner format. 상세 reference 는 동일 디렉토리의 4개 PRD 참조.
> Source: https://github.com/tellang/triflux/issues/281
> Closes: #87, #281

## Shard: A-staged-file-detect
- agent: codex
- files: hub/lib/staged-file-detect.mjs, packages/core/hub/lib/staged-file-detect.mjs, packages/triflux/hub/lib/staged-file-detect.mjs, tests/unit/staged-file-detect.test.mjs
- mcp: implement
- depends:
- critical: true
- prompt: |
    Issue #281 Shard A — staged-file-detect helper (Codex worker).

    상세 PRD 필독: .triflux/plans/issue-281-shard-a-staged-file-detect.md

    구현 핵심:
    - 신규 hub/lib/staged-file-detect.mjs: detectChangedFiles({cwd, includeStaged, includeUnstaged, includeUntracked}) + hasCodeChange() 두 함수 export
    - git diff --cached --name-only + git diff --name-only + git ls-files --others --exclude-standard 결과를 Set 중복제거 후 {stagedCount, unstagedCount, untrackedCount, totalChanged, files[]} 반환
    - non-git cwd 에서 graceful (try/catch + 빈 배열, throw 없음)
    - execFileSync(args[]) 형식 (execSync(string) 금지 — shell injection 방지)
    - stdio: ['ignore', 'pipe', 'ignore']
    - 신규 tests/unit/staged-file-detect.test.mjs: 6 case (empty clean / staged 1개 / unstaged+untracked 혼합 / non-git cwd / includeStaged false / 중복 파일)
    - 각 case 는 mkdtempSync + git init + git config + 격리
    - 4-layer mirror: hub/lib/staged-file-detect.mjs 를 packages/core/hub/lib/ + packages/triflux/hub/lib/ 에 byte-identical cp (packages/remote 무영향, tests/ mirror 제외)
    - 검증: diff -q exit 0, npm run lint clean, npm test -- staged-file-detect 통과
    - AI trailer / Co-Authored-By 금지

## Shard: B-router-escalate
- agent: codex
- files: hub/lib/tfx-route-args.mjs, packages/core/hub/lib/tfx-route-args.mjs, packages/triflux/hub/lib/tfx-route-args.mjs, bin/triflux.mjs, packages/triflux/bin/triflux.mjs, scripts/tfx-route.sh, packages/triflux/scripts/tfx-route.sh, tests/unit/tfx-route-args.test.mjs
- mcp: implement
- depends: A-staged-file-detect
- critical: true
- prompt: |
    Issue #281 Shard B — router auto-escalate 로직 (Codex worker).

    상세 PRD 필독: .triflux/plans/issue-281-shard-b-router-escalate.md
    의존: Shard A 의 hub/lib/staged-file-detect.mjs (hasCodeChange import)

    진입 첫 행위 — 기존 구조 grep:
      grep -n "parallel\|isolation\|tasks" hub/lib/tfx-route-args.mjs | head -30
      grep -n "tfx-auto\|--parallel\|dispatch" bin/triflux.mjs | head -30
      grep -n "auto_reroute\|auto)" scripts/tfx-route.sh | head -20

    구현 핵심:
    - hub/lib/tfx-route-args.mjs 에 decideDispatchMode(args, opts={cwd, detector}) 추가
      - import { hasCodeChange } from './staged-file-detect.mjs'
      - detector injectable (test seam)
      - 분기: user-explicit-swarm / case 3 (parallel N + code change → warning+multi) / case 2 (2+ tasks + code change → swarm escalate) / case 1 (2+ tasks 무변경 → multi) / single
      - return {mode, escalated, warning, reason}
    - bin/triflux.mjs tfx-auto dispatch 분기에 decision 호출 추가
      - decision.warning → process.stderr.write
      - decision.escalated → .omc/state/auto-escalation.log JSON line append (dir 없으면 graceful skip)
    - scripts/tfx-route.sh auto) 분기 docstring 갱신 (Issue #281: JS layer가 single source of truth, shell layer transparent passthrough)
    - tests/unit/tfx-route-args.test.mjs 에 decideDispatchMode 5 case (single / case 1 / case 2 / case 3 / user-explicit swarm) — detector mock 으로 git 의존 격리
    - 4-layer mirror: hub/lib/tfx-route-args.mjs → packages/core + packages/triflux 동시 cp / bin/triflux.mjs → packages/triflux/bin 동시 cp / scripts/tfx-route.sh → packages/triflux/scripts 동시 cp
    - 검증: diff -q exit 0, npm test 통과, npm run lint clean
    - AI trailer / Co-Authored-By 금지

## Shard: C-integration-ssot-mirror
- agent: codex
- files: tests/integration/tfx-auto-routing.test.mjs, .claude/rules/tfx-execution-skill-map.md, .claude/rules/tfx-routing.md
- mcp: implement
- depends: A-staged-file-detect, B-router-escalate
- critical: true
- prompt: |
    Issue #281 Shard C — integration test + SSOT docs (Codex worker).

    상세 PRD 필독: .triflux/plans/issue-281-shard-c-integration-ssot-mirror.md
    의존: Shard A + B 머지 후 (또는 branch rebase) 진입

    구현 핵심:
    - 신규 tests/integration/tfx-auto-routing.test.mjs: Issue #281 회귀 가드 3 case (실제 git repo + decideDispatchMode 통합)
      - case 1: setupRepo(dirty: false) + 2+ tasks → mode==='multi', escalated===false, warning===null
      - case 2: setupRepo(dirty: true) + 2+ tasks → mode==='swarm', escalated===true, warning match /자동 escalate/ + /Issue #281/
      - case 3: setupRepo(dirty: true) + --parallel 3 → mode==='multi', escalated===false, warning match /WARNING: 코드 변경/ + /사용자 명시.*존중/
      - afterEach rmSync cwd

    - .claude/rules/tfx-execution-skill-map.md 정식화 톤 갱신
      - L44 (안티패턴): "tfx-auto --parallel N 명시 + 코드 변경 → warning 후 사용자 결정 존중 (Issue #281 closed)"
      - L48-49 (핵심 룰): "tfx-auto 는 2+ 태스크 + 코드 변경 자동 감지 시 swarm escalate (Issue #281 closed). 사용자 명시 --parallel N override 시 warning 후 사용자 결정 존중."
      - L57-59 (알려진 한계): 섹션 자체 삭제 또는 "해결됨" 으로 변경 후 Issue #87/#281 close 링크

    - .claude/rules/tfx-routing.md "충돌 해소" 섹션에 1줄 추가: "tfx-auto 자동 swarm escalate: 2+ 태스크 + 코드 변경 ≥ 1건 시 자동. 명시 --parallel N override 가능 (warning)."

    - 4-layer mirror 통합 검증 스크립트 실행 (Shard A+B 산출물 검증):
      - diff -q hub/lib/staged-file-detect.mjs packages/core/hub/lib/staged-file-detect.mjs
      - diff -q hub/lib/tfx-route-args.mjs packages/core/hub/lib/tfx-route-args.mjs
      - 각 파일 packages/triflux mirror diff -q
      - packages/remote 영향 없음 git diff 확인
      - tests/ mirror 시도 없음 (packages/{core,triflux}/tests 미존재 확인)
      - npm pack --dry-run size ~1MB

    - 검증: npm test -- tfx-auto-routing 통과, 4-layer mirror 검증 출력 모두 OK, npm pack size ~1MB
    - AI trailer / Co-Authored-By 금지
