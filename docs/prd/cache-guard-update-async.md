# PRD: 캐시 가드 + update async — 런타임 캐시 검증 및 업데이트 비동기 전환

## 목표
1. `validateRuntimeCachePaths()` 함수를 추가하여 런타임에 캐시 경로가 유효한지 검증한다.
2. `checkNetworkAvailability()` 함수를 추가하여 네트워크 가용성을 사전 확인한다.
3. `cmdUpdate()` (bin/triflux.mjs:2449)를 async로 전환하여 네트워크 작업을 non-blocking으로 처리한다.

## 파일
- `bin/triflux.mjs` (수정, cmdUpdate 함수 async 전환 + 캐시 가드 통합, ~50줄 변경)
- `hub/lib/cache-guard.mjs` (신규, ~80줄) — validateRuntimeCachePaths, checkNetworkAvailability
- `tests/unit/cache-guard.test.mjs` (신규, ~80줄)

## 인터페이스
```javascript
// hub/lib/cache-guard.mjs
export function validateRuntimeCachePaths(cacheDir) {
  // ~/.claude/cache/ 하위 파일들의 유효성 검증
  // JSON 파싱 가능 여부, 권한 확인
  // returns: { ok: boolean, issues: Array<{file, error}> }
}

export async function checkNetworkAvailability(urls) {
  // npm registry, git remote 등 네트워크 도달 가능 여부 확인
  // returns: { online: boolean, reachable: string[], unreachable: string[] }
}

// bin/triflux.mjs
async function cmdUpdate() {
  // 기존 동기 cmdUpdate를 async로 전환
  // 네트워크 확인 → 캐시 검증 → 업데이트 실행
}
```

## 제약
- cmdUpdate() 호출부(bin/triflux.mjs:3691)도 await로 변경 필요
- checkNetworkAvailability는 타임아웃 3초 (긴 대기 방지)
- validateRuntimeCachePaths는 동기 함수 유지 (파일 I/O만)
- 기존 cmdUpdate의 동작(설치 감지 → 업데이트 → setup 재실행) 보존

## 의존성
- `node:https` 또는 `node:net` (네트워크 체크)
- `node:fs` (캐시 파일 검증)

## 테스트 명령
```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/cache-guard.test.mjs --no-cache
triflux update --dry-run 2>/dev/null || triflux update
```

## 완료 조건 (필수)
작업이 끝나면 반드시:
1. 변경 파일 검토 완료
2. `git add bin/triflux.mjs hub/lib/cache-guard.mjs tests/unit/cache-guard.test.mjs && git commit -m "feat: cache guard + cmdUpdate async 전환 — 런타임 캐시 검증 및 네트워크 사전 확인"` 수행
3. 테스트 명령 실행 및 통과 결과 확인
