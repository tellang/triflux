# PRD: MCP 싱글톤 데몬 (Lake 3a)

## 목적

tfx-hub MCP 서버를 싱글톤으로 운영하여 중복 인스턴스를 방지하고,
기존 서버가 살아있으면 재사용함으로써 포트 충돌과 리소스 낭비를 제거한다.

## 핵심 컴포넌트

| 모듈 | 역할 |
|------|------|
| `hub/state.mjs` | PID 파일 기반 상태 관리 (writeState, readState, acquireLock, releaseLock, isServerHealthy) |
| `hub/server.mjs` `getOrCreateServer()` | 싱글톤 팩토리 — 기존 서버 재사용 or 새 인스턴스 부팅 |
| `hub/server.mjs` `startHub()` | 실제 HTTP 서버 생성 + MCP 트랜스포트 바인딩 |
| `hub/server.mjs` `getHubInfo()` | PID 파일에서 접속 정보 읽기 |

## 싱글톤 플로우

```
getOrCreateServer()
  ├─ readState() → 기존 상태 파일 확인
  │   ├─ pid + port 존재?
  │   │   ├─ process.kill(pid, 0) → PID 생존 확인
  │   │   │   ├─ 생존 + /health OK → { reused: true, port, pid, url }
  │   │   │   └─ 생존 + /health FAIL → startHub() → { reused: false, ... }
  │   │   └─ PID 사망 → startHub() → { reused: false, ... }
  │   └─ pid/port 없음 → startHub() → { reused: false, ... }
  └─ startHub()
      ├─ acquireLock() — 파일 락으로 경합 방지
      ├─ HTTP 서버 + MCP 트랜스포트 바인딩
      ├─ writeState({ pid, port, version, sessionId, startedAt })
      └─ releaseLock()
```

## 의존성 주입 (`_deps`)

`getOrCreateServer`는 테스트 용이성을 위해 `_deps` 옵션으로 모든 외부 의존을 교체할 수 있다.

| 키 | 기본값 | 설명 |
|----|--------|------|
| `isHealthy` | `isServerHealthy` | 포트 기반 /health 체크 |
| `getInfo` | `getHubInfo` | PID 파일에서 url 등 읽기 |
| `readState` | `readState` (state.mjs) | 상태 파일 읽기 |
| `startHub` | `startHub` (server.mjs) | 새 서버 부팅 |

## 테스트 케이스

1. 기존 서버 없음 → `startHub` 호출, `reused: false`
2. 기존 서버 healthy → 재사용, `reused: true`
3. PID 생존 + health 실패 → `startHub` 호출, `reused: false`
4. state에 pid/port 불완전 → `startHub` 호출, `reused: false`
5. `getInfo`가 url 미반환 → 기본 url 폴백

## 제약

- 파일 800줄 이하, 함수 50줄 이하
- immutable 패턴 (상태 파일은 atomic replace)
- 기존 API 호환 유지 (`_deps` 미지정 시 기존 동작 동일)
