# PRD: tfx multi 시작 속도 개선 — 인프라 체크 캐싱

**Date**: 2026-04-02
**Status**: In Progress
**Issue**: 사용자가 tfx multi를 반복 실행할 때 매번 인프라 체크(Hub fetch, wt.exe 탐색, CLI 존재 확인)가 반복되어 ~30초+ 오버헤드 발생

## Problem

`tfx multi` 실행 시:
1. `checkHubRunning()` — Hub status fetch (2s timeout), preflight 캐시 무시
2. `where wt.exe` — headless.mjs에서 매번 execSync 호출 (0.5s×2)
3. preflight 캐시 TTL 30초 — 짧아서 대부분 miss
4. SessionStart 훅 hub-ensure(8s) + preflight(5s) 순차 실행

## Solution

### 1. checkHubRunning() 캐시 퍼스트
- `~/.claude/cache/tfx-preflight.json` 먼저 읽기
- TTL 내 + hub=true → fetch 스킵
- miss일 때만 기존 fetch fallback

### 2. where wt.exe 모듈 캐시
- `headless.mjs`에 `let _wtAvailable = null` 모듈 변수
- 첫 호출 시 execSync, 이후 캐시 반환

### 3. preflight TTL 확장
- 30s → 300s (5분, warmup과 동일)
- auth fingerprint 변경 시 즉시 무효화는 유지

### 4. SessionStart 훅 병렬화
- hub-ensure(priority 2)와 preflight-cache(priority 3)를 같은 priority 그룹으로
- hook-orchestrator에서 같은 priority는 Promise.all 병렬 실행

## Acceptance Criteria
- AC1: Hub 캐시 히트 시 fetch 스킵
- AC2: where wt.exe 세션당 1회
- AC3: preflight TTL 300s
- AC4: hub-ensure + preflight 병렬
- AC5: npm test 전체 통과
