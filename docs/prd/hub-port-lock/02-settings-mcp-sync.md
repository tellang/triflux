# PRD: Gemini/Claude settings.json MCP URL 자동 동기화 모듈

## 목표
Hub가 실행 중인 실제 URL을 `~/.gemini/settings.json`과 `~/.claude/settings.json`(및 `settings.local.json`)의 `mcpServers.tfx-hub.url`에 **덮어쓰는 유틸리티 모듈**을 신규 작성한다. Hub 시작 훅(PRD-A)에서 이 모듈을 호출하면 settings의 stale URL이 현재 Hub URL로 자동 맞춰지는 **안전망**이 된다. PRD-A가 27888 고정에 성공하면 이 동기화는 no-op(이미 일치)이고, 혹시 다른 포트에 떨어져도 클라이언트가 따라오게 만들어 MCP 연결 끊김을 방지한다.

## Shard: settings-mcp-sync
- agent: codex
- files: scripts/sync-hub-mcp-settings.mjs, tests/unit/sync-hub-mcp-settings.test.mjs
- prompt: |
    `scripts/sync-hub-mcp-settings.mjs`를 신규 작성하고 전용 테스트를 추가한다.

    ## 요구 시그니처 (A가 이 형태로 호출함. 변경 금지)
    ```js
    export async function syncHubMcpSettings({ hubUrl, dryRun = false, logger = console }) {
      // hubUrl: "http://127.0.0.1:27888/mcp" 형식
      // returns: {
      //   updated: string[],   // 실제로 URL이 변경된 파일 경로
      //   skipped: string[],   // 이미 일치하여 skip된 파일 경로
      //   errors: { path: string, reason: string }[],  // 읽기/쓰기 실패
      // }
    }
    ```

    ## 대상 파일
    1. `~/.gemini/settings.json` — `mcpServers.tfx-hub.url`
    2. `~/.claude/settings.json` — `mcpServers.tfx-hub.url` (단, 없을 수도 있음)
    3. `~/.claude/settings.local.json` — 동일 (존재 시에만)

    경로는 `homedir()` 기반. Windows/POSIX 동일.

    ## 동작 규칙
    1. 파일이 없으면: **생성하지 않고 skip** (기존 구조 보존이 우선). errors 배열에 기록하지 않음 — 그냥 skip.
    2. 파일 있지만 JSON 파싱 실패: errors에 `{ path, reason: "invalid json" }` 기록하고 그 파일은 수정 금지. 나머지 파일은 계속 처리.
    3. `mcpServers` 키 없으면: 새로 생성하지 않고 skip (스킬 사용자가 tfx-hub를 의도적으로 제거한 경우 존중). 이 경우도 errors에 기록하지 않음.
    4. `mcpServers.tfx-hub` 있으면:
       - `url` 필드가 hubUrl과 정확히 일치 → skip
       - 다르면 url만 교체 (다른 필드: `enabled`, `timeout`, `trust` 등은 **보존**)
       - `dryRun: true`면 변경 계획만 보고하고 실제 write 금지. 결과는 `updated`에 포함하되 `reason: "dry-run"` 메타로 구분할 필요는 없음(dryRun 플래그로 호출자가 판단).
    5. 쓰기 방식:
       - JSON 포맷 2-space indent 보존, trailing newline 유지
       - atomic write: 임시 파일(`{path}.tmp-{pid}`) → rename (Windows에서 rename은 대상 존재 시 실패하므로 먼저 unlink 후 rename, 또는 `fs.renameSync` with overwrite)
       - 실패 시 errors에 기록하고 다음 파일 처리 계속
    6. 동시성: 같은 파일에 대한 동시 호출 방지를 위해 **process 내 in-memory lock**만 필요 (SharedArrayBuffer나 파일 lock 불필요). 다른 프로세스와의 race는 Hub 시작 시점 1회 호출이므로 무시.

    ## 로깅
    - 각 파일에 대해 `logger.info('[mcp-sync] updated: {path}')` 또는 `skipped`, `error`
    - 자세한 변경 전/후 값은 debug 수준(logger.debug)

    ## 테스트 (`tests/unit/sync-hub-mcp-settings.test.mjs`)
    - tmp 디렉터리에 가짜 `~/.gemini/settings.json`, `~/.claude/settings.json`을 만들어 `HOME` env override로 테스트
    - case 1: settings.json 없음 → skip, updated=[]
    - case 2: tfx-hub.url이 이미 일치 → skipped에 포함
    - case 3: tfx-hub.url 다름 → updated에 포함, 파일 실제 내용 확인
    - case 4: 다른 MCP 서버 동시 존재 → tfx-hub만 수정, 다른 서버 보존
    - case 5: invalid JSON → errors에 포함, 파일 원본 보존
    - case 6: dryRun=true → updated에는 들어가지만 파일은 실제로 안 변함
    - case 7: mcpServers 키는 있지만 tfx-hub 엔트리 없음 → skip (생성 안 함)
    - case 8: `tfx-hub` 엔트리의 다른 필드(enabled, trust 등) 보존 확인

    Vitest 또는 Node native test runner 사용. 기존 `tests/unit/*.test.mjs` 스타일 따름.

    ## 제약
    - `mcpServers` 또는 `tfx-hub` 엔트리를 **없는 상태에서 생성하지 않는다** (사용자 의도 존중). 사용자가 처음 tfx 설치 시엔 `tfx setup`이 생성하는 것이 정책.
    - 다른 JSON 필드 보존 (정렬, 불필요 재포맷 금지. 가능하면 `JSON.parse` → 수정 → `JSON.stringify(obj, null, 2)`. 키 순서가 달라질 수 있음은 허용)
    - `process.exit` 호출 금지, 예외 throw 대신 errors 배열에 누적
    - 외부 의존성 추가 금지 (node:fs, node:os, node:path만 사용)

    ## 완료 조건
    - `scripts/sync-hub-mcp-settings.mjs` 작성
    - `tests/unit/sync-hub-mcp-settings.test.mjs` 작성, 전체 통과
    - 커밋:
      ```bash
      git add scripts/sync-hub-mcp-settings.mjs tests/unit/sync-hub-mcp-settings.test.mjs
      git commit -m "feat(scripts): sync Gemini/Claude settings.json tfx-hub URL"
      ```

## 인터페이스
```javascript
export async function syncHubMcpSettings({ hubUrl, dryRun = false, logger = console })
// returns: { updated: string[], skipped: string[], errors: { path, reason }[] }
```

## 제약
- 파일/키 없으면 생성하지 않음 (의도 존중)
- atomic write
- 외부 npm 의존성 추가 금지

## 의존성
- 없음 (A가 이 모듈을 optional import로 호출)

## 테스트 명령
```bash
node --test tests/unit/sync-hub-mcp-settings.test.mjs
```

## 완료 조건 (필수)
1. 변경 파일 검토
2. 테스트 통과 확인
3. 커밋:
   ```bash
   git add scripts/sync-hub-mcp-settings.mjs tests/unit/sync-hub-mcp-settings.test.mjs
   git commit -m "feat(scripts): sync Gemini/Claude settings.json tfx-hub URL"
   ```
