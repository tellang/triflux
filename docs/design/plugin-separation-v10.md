# Design: 플러그인 분리 — @triflux/core + @triflux/remote

Lake 2 설계 문서. v10 로드맵 P3-11.

## 문제

triflux는 단일 패키지(23K LOC)로, CLI 라우팅만 필요한 사용자도 팀 모드·원격 실행·psmux 전체를 설치한다.
better-sqlite3 네이티브 빌드가 설치 실패의 80%를 차지하고, 이건 store.mjs (팀 상태 저장)에서만 필요하다.

## 목표

1. `npm install -g triflux` — 핵심 CLI 라우팅만. 네이티브 의존성 0.
2. `npm install -g @triflux/remote` — 팀 모드, psmux, 원격 실행. core를 peerDep으로.
3. 기존 `triflux` 패키지는 meta-package로 양쪽 다 설치 (하위 호환).

## 현재 의존성 그래프

```
hub/ root (8,829 LOC)
├── standalone (core 후보): 16 모듈
│   paths, platform, state, intent, token-mode,
│   store, store-adapter, reflexion, research,
│   router, hitl, assign-callbacks, tray,
│   fullcycle, bridge, session-fingerprint
│
├── core↔team 브릿지: 4 모듈
│   pipe.mjs      → team/nativeProxy.mjs
│   tools.mjs     → team/nativeProxy.mjs
│   codex-adapter → team/codex-compat.mjs
│   codex-preflight → team/codex-compat.mjs
│
├── team/ (9,159 LOC) — 팀 모드 전체
│   team/ → platform.mjs, codex-adapter.mjs (역참조)
│
└── workers/ (5,182 LOC) — CLI 워커
    workers/ → hub root 참조 없음 (독립)
```

## 패키지 경계

### @triflux/core

CLI 라우팅 + 파이프라인 + 품질 게이트. 네이티브 의존성 없음.

```
@triflux/core/
├── bin/triflux.mjs
├── hub/
│   ├── paths.mjs
│   ├── platform.mjs
│   ├── state.mjs
│   ├── intent.mjs
│   ├── token-mode.mjs
│   ├── router.mjs
│   ├── hitl.mjs
│   ├── assign-callbacks.mjs
│   ├── fullcycle.mjs
│   ├── bridge.mjs
│   ├── reflexion.mjs
│   ├── research.mjs
│   ├── session-fingerprint.mjs
│   ├── cli-adapter-base.mjs
│   ├── codex-adapter.mjs      ← codex-compat 추출 후
│   ├── codex-preflight.mjs
│   ├── gemini-adapter.mjs
│   ├── pipeline/
│   ├── routing/
│   ├── quality/
│   ├── delegator/
│   ├── lib/
│   └── middleware/
├── skills/                     ← Layer 1 스킬만
├── hooks/
└── hud/
```

**deps:** zod, pino, pino-pretty
**devDeps:** @biomejs/biome

### @triflux/remote

팀 모드 + psmux + 원격 실행 + MCP 워커. better-sqlite3 여기로.

```
@triflux/remote/
├── hub/
│   ├── server.mjs              ← HTTP 서버 (팀 API)
│   ├── store.mjs               ← SQLite (better-sqlite3)
│   ├── store-adapter.mjs
│   ├── pipe.mjs
│   ├── tools.mjs
│   ├── tray.mjs
│   ├── team/                   ← 전체
│   └── workers/                ← 전체
├── skills/                     ← Layer 2-3 스킬
│   ├── tfx-multi/
│   ├── tfx-codex-swarm/
│   └── tfx-remote-spawn/
└── bin/tfx-team.mjs            ← team CLI 진입점
```

**deps:** better-sqlite3, @modelcontextprotocol/sdk, systray2
**peerDeps:** @triflux/core

## 커플링 해소 — 4개 브릿지 포인트

### B1: pipe.mjs → team/nativeProxy.mjs

**현재:** pipe.mjs가 nativeProxy를 직접 import해서 팀 상태 조회.
**해소:** `team-bridge` 인터페이스 도입. core는 인터페이스만 알고, remote가 구현을 주입.

```javascript
// @triflux/core — hub/team-bridge.mjs
let _bridge = null;
export function registerTeamBridge(impl) { _bridge = impl; }
export function getTeamBridge() { return _bridge; }

// @triflux/remote — 부트스트랩에서
import { registerTeamBridge } from '@triflux/core';
import { nativeProxy } from './team/nativeProxy.mjs';
registerTeamBridge(nativeProxy);
```

### B2: tools.mjs → team/nativeProxy.mjs

B1과 동일 패턴. `getTeamBridge()`로 대체.

### B3: codex-adapter.mjs → team/codex-compat.mjs

**현재:** `buildExecCommand`, `getCodexVersion`을 codex-compat에서 import.
**해소:** `codex-compat.mjs`에서 CLI 빌더 로직을 `cli-adapter-base.mjs`로 이동. 팀 전용 로직만 codex-compat에 남김.

```javascript
// 이동할 함수:
//   buildExecCommand(prompt, resultFile, opts) → cli-adapter-base.mjs
//   getCodexVersion() → codex-preflight.mjs
// codex-compat에 남길 함수:
//   팀 세션 내 Codex 인터랙티브 명령 생성
```

### B4: codex-preflight.mjs → team/codex-compat.mjs

B3과 함께 해소. `getCodexVersion()`을 preflight 자체에 내장.

## 마이그레이션 순서

```
Phase 1: 커플링 해소 (Lake 1.5 마무리)
  ├─ B3: buildExecCommand → cli-adapter-base.mjs 이동
  ├─ B4: getCodexVersion → codex-preflight.mjs 내장
  ├─ B1+B2: team-bridge 인터페이스 도입
  └─ 검증: npm test 통과, 기존 동작 무변경

Phase 2: 패키지 분리 (Lake 2)
  ├─ monorepo 전환 (npm workspaces)
  │   ├─ packages/core/
  │   ├─ packages/remote/
  │   └─ packages/triflux/ (meta)
  ├─ 파일 이동 + import 경로 업데이트
  ├─ 각 패키지 package.json 작성
  └─ 검증: npm test (각 패키지 독립), npm test (통합)

Phase 3: 배포 (Lake 2)
  ├─ @triflux/core npm publish
  ├─ @triflux/remote npm publish
  ├─ triflux meta-package 업데이트
  └─ stable/canary 채널 분리
```

## Phase 1 작업 목록

| # | 작업 | 영향 파일 | 리스크 |
|---|------|----------|--------|
| 1 | `buildExecCommand` → cli-adapter-base.mjs 이동 | codex-adapter, codex-compat, backend, pane, native-control | LOW — 순수 함수 이동 |
| 2 | `getCodexVersion` → codex-preflight.mjs 내장 | codex-preflight, codex-compat | LOW — 버전 파싱만 |
| 3 | team-bridge 인터페이스 생성 | 새 파일 1개 | LOW — 추가만 |
| 4 | pipe.mjs nativeProxy → team-bridge | pipe.mjs | MEDIUM — 핵심 파이프라인 |
| 5 | tools.mjs nativeProxy → team-bridge | tools.mjs | MEDIUM — 핵심 도구 |
| 6 | remote 부트스트랩에서 bridge 등록 | server.mjs | LOW |

## 리스크

| 리스크 | 완화 |
|--------|------|
| monorepo 전환 시 스킬 경로 깨짐 | skills/는 상대 경로 사용, bin 심볼릭 링크로 호환 유지 |
| better-sqlite3 분리 시 store 미설치 케이스 | core에 in-memory fallback store 추가 (Map 기반) |
| 팀 모드 없이 pipe.mjs 호출 시 | team-bridge null 체크 → graceful no-op |
| CI에서 두 패키지 테스트 매트릭스 | npm workspaces test로 한 번에 실행 |

## 비용 추정

| Phase | 예상 | CC+gstack |
|-------|------|-----------|
| Phase 1 (커플링 해소) | 4시간 | 30분 |
| Phase 2 (패키지 분리) | 2일 | 2시간 |
| Phase 3 (배포 파이프라인) | 1일 | 1시간 |

## 결정 사항

- **store 분리:** better-sqlite3를 remote로 이동. core는 Map 기반 in-memory store로 fallback.
- **스킬 분리 기준:** Layer 1 (Light) → core, Layer 2-3 (Deep/Remote) → remote.
- **하위 호환:** `triflux` 패키지는 core+remote를 bundledDeps로 유지.
- **Phase 1부터 시작:** 커플링 해소가 끝나면 패키지 분리는 기계적 작업.
