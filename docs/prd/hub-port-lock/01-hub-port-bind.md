# PRD: Hub 포트 27888 고정 바인딩 + stale pid 정리

## 목표
tfx-hub가 **반드시 포트 27888**에서 실행되도록 보장한다. 현재 `hub/server.mjs`는 27888을 기본값으로 쓰지만 바인딩 실패 시 실제로 어떤 포트에 떨어지는지 확인되지 않은 상태로 stale `hub.pid` + 클라이언트(Gemini/Claude settings.json)의 stale `tfx-hub.url`을 유발해 MCP 도구 로딩 실패를 일으키고 있다. 27888이 이미 사용 중이면 `hub.pid`의 PID를 확인하여 **죽은 프로세스면 stale 정리 후 재바인딩**, **살아있으면 reuse 판정 후 정상 종료**, **다른 프로세스가 점유 중이면 명확한 에러로 실패**시킨다.

## Shard: hub-port-lock
- agent: codex
- files: hub/server.mjs, hub/bridge.mjs, tests/unit/hub-port-bind.test.mjs
- prompt: |
    hub/server.mjs를 수정해 Hub가 포트 27888에 고정 바인딩되도록 한다.

    ## 현재 동작 (확인 후 수정)
    - `hub/server.mjs:466, 1544, 2019`에서 `port = parseInt(process.env.TFX_HUB_PORT || "27888", 10)` 사용
    - `httpServer.listen(port, host, callback)` 호출 (L1544)
    - 27888이 이미 점유된 경우 `EADDRINUSE` 에러 발생 시 현재 fallback 동작 불분명 — 실제로는 동적 포트(예: 29198)에 떨어진 상태가 확인됨 (`~/.claude/cache/tfx-hub/hub.pid` 참조)

    ## 요구사항
    1. **27888 고정 바인딩**: Hub 시작 시 반드시 27888에 listen 시도. `listen(0)` 또는 `listen(undefined)` 같은 암묵적 동적 할당 경로가 있다면 제거.
    2. **EADDRINUSE 처리**:
       - `~/.claude/cache/tfx-hub/hub.pid` 읽기
       - pid가 존재하고 프로세스 살아있으면 (Node.js: `process.kill(pid, 0)` throw 없으면 alive):
         - 같은 버전/같은 Hub면 "이미 실행 중입니다" 메시지와 함께 graceful exit(0)
         - 다른 버전/프로세스면 사용자에게 명시적 에러: "포트 27888이 다른 Hub(pid=X, version=Y)에 의해 점유됨. `tfx hub stop` 후 재시도"
       - pid 없거나 죽었으면 stale로 간주, `hub.pid` 삭제 후 바인딩 재시도 (최대 1회)
       - 재시도 후에도 실패하면 명확한 에러 메시지 + exit 1
    3. **동적 포트 금지**: 환경변수 `TFX_HUB_PORT` 미지정 시 27888로 강제. 숫자 파싱 실패해도 27888 fallback.
    4. **hub/bridge.mjs 정합성**: bridge.mjs L59의 `process.env.TFX_HUB_PORT || "27888"`는 유지하되, bridge.mjs는 **hub.pid의 port를 우선 읽고**, 없으면 27888 fallback으로 동작하도록 정비 (이미 L53 근처에 유사 로직 있으면 유지).
    5. **테스트**: `tests/unit/hub-port-bind.test.mjs` 신규 작성.
       - case 1: TFX_HUB_PORT 미지정 → port === 27888
       - case 2: stale hub.pid (pid=999999 같은 죽은 pid) → 자동 정리 후 27888 바인딩
       - case 3: 이미 실행 중인 Hub 감지 → graceful exit 경로 확인 (프로세스 kill signal 테스트)
       - 실제 네트워크 바인딩 없이 단위 테스트 가능한 형태로 로직을 함수로 분리 (예: `resolveHubPort()`, `cleanStaleHubPid()`, `detectLivePeer()`).
    6. **안전망 연결 (B PRD 모듈 호출)**: Hub가 listen 성공한 직후, **optional dynamic import**로 `scripts/sync-hub-mcp-settings.mjs`의 `syncHubMcpSettings({ hubUrl })`를 호출한다. 모듈이 아직 없을 수도 있으니 try/catch로 감싸고 실패 시 warning log만 남기고 Hub 실행을 계속한다. 시그니처 협의:
       ```js
       try {
         const mod = await import(new URL('../scripts/sync-hub-mcp-settings.mjs', import.meta.url));
         await mod.syncHubMcpSettings({ hubUrl: `http://${host}:${port}/mcp` });
       } catch (err) {
         if (err.code !== 'ERR_MODULE_NOT_FOUND') console.warn('[hub] mcp-sync skipped:', err.message);
       }
       ```

    ## 제약
    - 기존 `process.env.TFX_HUB_PORT` override는 **유지** (디버그/테스트용)
    - `hub.pid` 파일 포맷 변경 금지 (현행: `{"pid","port","version","sessionId","startedAt","host","auth_mode","url","pipe_path",...}`)
    - packages/triflux/hub/server.mjs, packages/remote/hub/server.mjs가 있어도 이번 scope는 **`hub/server.mjs`만** (sync는 별도 커밋)
    - 테스트 파일은 Vitest 또는 Node's native test runner (기존 `tests/unit/*.test.mjs` 패턴 따름)

    ## 완료 조건
    - `hub/server.mjs`, `hub/bridge.mjs`, `tests/unit/hub-port-bind.test.mjs` 수정/신규 완료
    - 신규 테스트 실행 통과
    - 기존 `tests/unit/*.test.mjs` 영향 없음 (영향 있다면 이유 명시)
    - 변경 전 27888 fallback 동작과 변경 후 27888 강제 바인딩 동작 차이를 커밋 메시지에 설명

## 인터페이스
```javascript
// hub/server.mjs 내부 헬퍼 (테스트 가능하도록 export)
export function resolveHubPort(env = process.env)
// returns: 27888 (TFX_HUB_PORT override 없는 한)

export function cleanStaleHubPid(pidFilePath = HUB_PID_FILE)
// returns: { cleaned: boolean, reason: string }

export function detectLivePeer(pidFilePath = HUB_PID_FILE)
// returns: { alive: boolean, pid?: number, port?: number, version?: string }
```

## 제약
- 27888 외 포트 바인딩 금지 (디버그 env override 제외)
- hub.pid 파일 포맷 보존
- B의 sync 모듈 없어도 Hub는 정상 시작 (optional 호출)

## 의존성
- 없음 (B는 안전망, 없어도 A 단독 동작)

## 테스트 명령
```bash
node --test tests/unit/hub-port-bind.test.mjs
```

## 완료 조건 (필수)
1. 변경 파일 검토
2. 테스트 통과 확인
3. 커밋:
   ```bash
   git add hub/server.mjs hub/bridge.mjs tests/unit/hub-port-bind.test.mjs
   git commit -m "fix(hub): pin port to 27888 with stale pid cleanup"
   ```
