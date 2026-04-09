# Debug Blackbox + Startup Performance Fix

> Design doc: ~/.gstack/projects/tellang-triflux/tellang-main-design-20260409-093911.md
> Eng review: CLEARED (2026-04-09, 7 issues resolved, Codex outside voice 반영)

## Problem

triflux 설치 시 Claude Code 시작이 극심하게 느림 (SessionStart 훅 6개가 각각 별도 node 프로세스 spawn, 7+ 콜드스타트).
작업관리자에서 터미널/탭 ~1000개 + CPU/RAM 100%.

## Shard: hook-refactor
- agent: codex
- files: packages/triflux/scripts/setup.mjs, packages/triflux/scripts/mcp-safety-guard.mjs, packages/triflux/scripts/hub-ensure.mjs, packages/triflux/scripts/mcp-gateway-ensure.mjs, packages/triflux/scripts/preflight-cache.mjs
- prompt: |
  각 훅 스크립트의 핵심 로직을 export async function run(stdinData) 형태로 분리하라.
  프로세스 모드(직접 실행)일 때만 process.exit() 호출. in-process 모드에서 import해서 쓸 수 있어야 한다.
  setup.mjs는 특별: 1361줄이므로 필수 초기화(env probe, 버전 체크, PLUGIN_ROOT 설정)만 export function runCritical(stdinData)로 추출.
  나머지 무거운 작업(CLAUDE.md 싱크, skill 싱크, HUD 워밍업, memory doctor)은 export function runDeferred(stdinData)로 분리.
  process.exit(0) 호출은 if (import.meta.url === ...) 가드 안에 두어서 직접 실행 시에만 동작.
  기존 동작을 깨뜨리면 안 됨 — 각 스크립트를 node로 직접 실행해도 동일하게 동작해야 한다.

## Shard: session-start-fast
- agent: codex
- files: packages/triflux/hooks/session-start-fast.mjs, packages/triflux/hooks/hook-orchestrator.mjs
- depends: hook-refactor
- prompt: |
  hooks/session-start-fast.mjs를 신규 생성하라.
  6개 SessionStart 훅을 in-process로 실행하는 fast-path 모듈이다.

  훅 분류:
  - BLOCKING (직렬, 프롬프트 전 완료 필수): setup.runCritical(), mcp-safety-guard.run()
  - DEFERRED (병렬, Promise 기반, 실패해도 안 죽음): hub-ensure.run(), mcp-gateway-ensure.run(), setup.runDeferred()
  - BACKGROUND (fire-and-forget): preflight-cache.run(), session-vault은 external이므로 기존 execFile 유지

  각 훅 실행 시간을 pino(scripts/lib/logger.mjs)로 기록.
  DEFERRED 훅의 결과(resolve/reject)를 hub/team/event-log.mjs 패턴의 JSONL blackbox에 기록.

  hook-orchestrator.mjs를 수정:
  - main() 함수에서 eventName === 'SessionStart'이고 process.env.TRIFLUX_HOOK_FAST_PATH !== 'false'이면
    session-start-fast.mjs를 dynamic import하여 실행.
  - 다른 이벤트(PreToolUse, PostToolUse 등)는 기존 방식 그대로 유지.
  - source가 'session-vault' 등 external인 훅은 여전히 execFile로 실행.

## Shard: spawn-trace
- agent: codex
- files: packages/triflux/hub/lib/spawn-trace.mjs, packages/triflux/hub/team/wt-manager.mjs, packages/triflux/hub/team/conductor.mjs
- prompt: |
  hub/lib/spawn-trace.mjs를 신규 생성하라.
  child_process의 spawn, execFile, execFileSync과 동일한 시그니처의 드롭인 대체 함수를 export한다.

  각 함수는:
  1. hub/team/event-log.mjs의 createEventLog 패턴으로 JSONL 트레이스 기록
     (session_id, trace_id, parent_pid, command, args, cwd, reason)
  2. rate limit 체크: MAX_SPAWN_PER_SEC=10, MAX_TOTAL_DESCENDANTS=50
  3. WT 탭 상한: MAX_WT_TABS=8 (wt-manager의 DEFAULT_MAX_TABS 통합, 단일 상수)
  4. opt-in dedupe: opts.dedupe 키가 있을 때만 5초 윈도우 내 중복 skip
  5. 실제 child_process 함수 호출
  6. exit/close 이벤트에서 종료 기록

  JSONL 로그: ~/.triflux/logs/ 하위에 spawn-trace-{date}.jsonl로 저장.
  보존: 24시간 또는 50MB cap.

  wt-manager.mjs와 conductor.mjs에서 import를 node:child_process에서 ../lib/spawn-trace.mjs로 변경.
  wt-manager.mjs의 DEFAULT_MAX_TABS 상수를 spawn-trace.mjs의 MAX_WT_TABS로 통합.

## Shard: doctor-diagnose
- agent: codex
- files: packages/triflux/bin/tfx-doctor.mjs, packages/triflux/bin/tfx-doctor-tui.mjs
- depends: spawn-trace
- prompt: |
  기존 tfx doctor에 --diagnose 플래그를 추가하라 (신규 명령 아님, 기존 확장).

  --diagnose 실행 시:
  1. ~/.triflux/logs/에서 최근 1시간의 spawn-trace JSONL 수집
  2. Node.js process.report.writeReport()로 프로세스 리포트 생성
  3. SessionStart 훅별 실행 시간 수집 (hook-timing)
  4. spawn 통계 계산 (총 횟수, peak rate/sec, max concurrent descendants)
  5. 시스템 정보 수집 (OS, Node 버전, CPU/RAM, WT 버전)
  6. 사람이 읽을 수 있는 summary.txt 생성
  7. 전체를 ~/.triflux/diagnostics/diag-{timestamp}.zip으로 패킹 (Windows 네이티브 zip)

  PowerShell의 Compress-Archive를 사용하거나, Node.js의 archiver/yazl 라이브러리 없이
  기본 zlib + 직접 zip 구현 또는 child_process로 PowerShell 호출.

## Shard: tests
- agent: codex
- files: packages/triflux/scripts/__tests__/session-start-fast.test.mjs, packages/triflux/scripts/__tests__/spawn-trace.test.mjs, packages/triflux/scripts/__tests__/tfx-doctor-diagnose.test.mjs
- depends: session-start-fast, spawn-trace, doctor-diagnose
- critical: true
- prompt: |
  24개 code path에 대한 전수 테스트를 작성하라. Node.js native test runner 사용.

  session-start-fast.test.mjs:
  - BLOCKING path: setup.runCritical() 성공/실패, mcp-safety-guard.run() 성공/실패
  - DEFERRED path: hub-ensure + mcp-gateway 병렬 실행, 실패 시 blackbox 기록
  - BACKGROUND path: preflight-cache fire-and-forget
  - Rollback: TRIFLUX_HOOK_FAST_PATH=false로 기존 방식 복원
  - stdout 머지: 6개 훅 출력을 orchestrator 형식으로 결합

  spawn-trace.test.mjs:
  - spawnWithTrace: 정상 spawn, rate limit 초과, MAX_WT_TABS 초과, opt-in dedupe
  - execFileWithTrace: 정상, 타임아웃/에러
  - execFileSyncWithTrace: 정상, 에러 throw 후 rethrow
  - JSONL 로그 기록 검증

  tfx-doctor-diagnose.test.mjs:
  - 진단 번들 생성 (zip)
  - blackbox.jsonl 없을 때 처리
  - system-info.json 수집

  모든 테스트는 실제 프로세스 spawn 없이 DI/mock으로 격리.
  기존 테스트 패턴 참조: scripts/__tests__/smoke.test.mjs
