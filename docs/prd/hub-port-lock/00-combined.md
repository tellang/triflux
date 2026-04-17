# PRD: tfx-hub 포트 고정 + Gemini/Claude settings MCP URL 동기화

## 목표
tfx-hub가 반드시 27888 포트에서 실행되게 하고(PRD-A), 동시에 클라이언트 설정 파일(`~/.gemini/settings.json`, `~/.claude/settings.json`)의 `mcpServers.tfx-hub.url`이 현재 Hub URL과 자동 동기화되는 안전망 유틸리티(PRD-B)를 추가한다. 두 shard는 파일 겹침이 없어 병렬 실행 가능하며, PRD-B 모듈이 없어도 PRD-A는 optional dynamic import로 safe degrade한다.

## Shard: hub-port-lock
- agent: codex
- files: hub/server.mjs, hub/bridge.mjs, tests/unit/hub-port-bind.test.mjs
- prompt: |
    `hub/server.mjs`를 수정해 Hub가 **반드시 포트 27888**에 고정 바인딩되도록 한다. 상세 스펙은 `docs/prd/hub-port-lock/01-hub-port-bind.md`를 반드시 먼저 전부 읽고 그대로 따른다.

    핵심 요구:
    1. TFX_HUB_PORT env override 없을 시 27888 강제. 동적 포트 경로 제거.
    2. EADDRINUSE 시 `~/.claude/cache/tfx-hub/hub.pid` 확인 → stale이면 자동 정리 후 재시도, 살아있으면 graceful exit(같은 Hub) 또는 명확한 에러(다른 Hub).
    3. listen 성공 직후 `scripts/sync-hub-mcp-settings.mjs`의 `syncHubMcpSettings({ hubUrl })`를 **optional dynamic import**로 호출. 모듈 부재/실패 시 warning log만 남기고 Hub 실행 계속.
    4. 테스트 가능하도록 `resolveHubPort()`, `cleanStaleHubPid()`, `detectLivePeer()` 헬퍼 함수 분리 + export.
    5. `hub/bridge.mjs`는 `hub.pid`의 port 우선, 없으면 27888 fallback.
    6. `tests/unit/hub-port-bind.test.mjs` 신규: TFX_HUB_PORT 미지정/stale pid/live peer 3 케이스.

    제약: hub.pid 파일 포맷 보존, packages/** 건드리지 않음, 외부 의존성 추가 금지.

    실행/검증:
    ```bash
    node --test tests/unit/hub-port-bind.test.mjs
    ```

    완료 후 커밋:
    ```bash
    git add hub/server.mjs hub/bridge.mjs tests/unit/hub-port-bind.test.mjs
    git commit -m "fix(hub): pin port to 27888 with stale pid cleanup"
    ```

## Shard: settings-mcp-sync
- agent: codex
- files: scripts/sync-hub-mcp-settings.mjs, tests/unit/sync-hub-mcp-settings.test.mjs
- prompt: |
    `scripts/sync-hub-mcp-settings.mjs`를 신규 작성하고 전용 테스트를 추가한다. 상세 스펙은 `docs/prd/hub-port-lock/02-settings-mcp-sync.md`를 반드시 먼저 전부 읽고 그대로 따른다.

    시그니처 (변경 금지 — PRD-A가 이 형태로 호출):
    ```js
    export async function syncHubMcpSettings({ hubUrl, dryRun = false, logger = console })
    // returns: { updated: string[], skipped: string[], errors: { path, reason }[] }
    ```

    대상 파일: `~/.gemini/settings.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`.

    핵심 규칙:
    1. 파일 없음 or `mcpServers` 없음 or `tfx-hub` 엔트리 없음 → 생성 금지, skip (사용자 의도 존중).
    2. `tfx-hub.url`이 hubUrl과 일치 → skip, 다르면 url만 교체(다른 필드 보존).
    3. JSON parse 실패 → errors 배열에 기록, 원본 파일 보존.
    4. atomic write (tmp → rename). Windows rename overwrite 주의.
    5. dryRun=true면 updated에는 들어가지만 실제 write 안 함.
    6. process.exit 금지, throw 대신 errors에 누적.

    테스트: tmp 디렉터리 + HOME env override로 8 케이스.

    제약: node:fs, node:os, node:path만 사용. 외부 npm 의존성 금지. 2-space indent + trailing newline 유지.

    실행/검증:
    ```bash
    node --test tests/unit/sync-hub-mcp-settings.test.mjs
    ```

    완료 후 커밋:
    ```bash
    git add scripts/sync-hub-mcp-settings.mjs tests/unit/sync-hub-mcp-settings.test.mjs
    git commit -m "feat(scripts): sync Gemini/Claude settings.json tfx-hub URL"
    ```

## Codex 실행 제약 (자동 삽입됨)
- stdin redirect 금지: `codex < file` → "stdin is not a terminal"
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec`는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox와 충돌)
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능 — 순차 실행 권장

## 완료 조건 (필수)
각 shard는 자기 파일만 수정, 테스트 통과 후 개별 커밋. 두 shard 모두 성공해야 merge 단계 진입.
