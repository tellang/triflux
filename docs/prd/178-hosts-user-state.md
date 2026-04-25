# PRD: hosts.json 을 user-state 경로로 이전 — issue #178

## Problem

원격 호스트 설정 파일 `hosts.json` 이 skill `references/` 폴더에 위치한다 (`skills/tfx-remote-spawn/references/hosts.json`, `packages/triflux/skills/tfx-remote-spawn/references/hosts.json`, 글로벌 `~/.claude/skills/tfx-remote-spawn/references/hosts.json`).

문제:
1. 역할 혼동 — `references/` 는 skill 정의의 일부 (예제, 스키마). hosts.json 은 user/machine-specific state.
2. 덮어쓰기 리스크 — `tfx setup` 실행 시 source → global 방향으로 설치되면서 user 가 글로벌에서 수정한 hosts.json 을 덮어씀.
3. 동기화 부담 — user 가 설정을 바꿀 때마다 세 위치 (source/packages/global) 를 수동 동기화. 임시 패치 (SKILL.md fan-out 단계) 는 근본 해결이 아님.

## Goal

`hosts.json` 을 user-state 전용 경로 (`~/.config/triflux/hosts.json` on macOS/Linux, `%APPDATA%\triflux\hosts.json` on Windows) 로 이전한다. 첫 read 시 source-tree → user-state 로 lazy auto-migration. source-tree fallback 은 CI/test fixture 호환을 위해 유지. `tfx setup` 이 user-state 파일을 덮어쓰지 않도록 install 대상에서 제외.

## Shard: core-compat
- agent: codex
- files: hub/lib/hosts-compat.mjs, packages/core/hub/lib/hosts-compat.mjs, packages/triflux/hub/lib/hosts-compat.mjs, hub/team/tui-remote-adapter.mjs, packages/remote/hub/team/tui-remote-adapter.mjs, packages/triflux/hub/team/tui-remote-adapter.mjs
- prompt: |
  hosts-compat.mjs 3개 미러 파일에 동일하게 적용:

  1. `userStateHostsPath()` 추가 — `os.homedir()` + 플랫폼별 분기
     - Windows (`process.platform === 'win32'`): `%APPDATA%\triflux\hosts.json` (process.env.APPDATA 우선, 없으면 `path.join(os.homedir(), 'AppData', 'Roaming', 'triflux', 'hosts.json')`)
     - macOS/Linux: `path.join(os.homedir(), '.config', 'triflux', 'hosts.json')`

  2. `candidatePaths(repoRoot)` — user-state 경로를 source-tree 후보 앞에 prepend.
     기존 `HOSTS_LOCATIONS` (3개) 는 source-tree fallback 으로 유지.
     반환: `[userStateHostsPath(), ...repoRootCandidates]`

  3. `migrateLegacyHosts(repoRoot)` 함수 추가:
     - user-state path 가 이미 존재 → no-op (`{ migrated: false, reason: "already-exists" }`)
     - source-tree 후보 (HOSTS_LOCATIONS) 중 첫 발견 파일 → mkdir -p (parent dir) + copyFileSync
     - 실패 시 throw 금지 — `{ migrated: false, reason: "<error>" }` 반환
     - 원본은 보존 (.gitignore 차단으로 어차피 untracked)
     - 반환: `{ migrated: boolean, from: string|null, to: string|null, reason?: string }`

  4. `readHosts()` 내부에서 첫 호출 시 `migrateLegacyHosts(repoRoot)` 1회 호출 (idempotent — 모듈 레벨 `let migrated = false` 가드)

  5. 기존 `readHosts()` / `resolveHost()` / `readHost()` API 시그니처는 변경 금지

  6. node:os import 추가 (homedir, platform — 플랫폼은 process.platform 사용해도 무방)

  ---
  tui-remote-adapter.mjs 3개 미러 파일에 동일하게 적용:

  1. 하드코딩 `const HOSTS_JSON_REL = "../../references/hosts.json"` 제거
  2. `loadHostsJson(hostsJsonPath)` 함수 폐기 → `import { readHosts } from "../lib/hosts-compat.mjs"` (또는 packages 미러는 적절한 상대경로) 로 변경
  3. `readHosts()` 가 반환하는 객체 (`{ hosts, default_host, ... }`) 를 그대로 사용
  4. `resolveSshUser(hostsData, host)` 등 호출처는 그대로 유지 — input 형식이 동일하므로 호환

  변경 후 `node hub/lib/hosts-compat.mjs --self-test` 통과 확인.

  packages/* 미러 파일은 `cp` 금지, `Edit` 으로만 동기화 (rule: feedback_remote_package_mirror).

## Shard: docs-config
- agent: codex
- files: skills/tfx-remote/SKILL.md, skills/tfx-remote-spawn/SKILL.md, packages/triflux/skills/tfx-remote/SKILL.md, packages/triflux/skills/tfx-remote-spawn/SKILL.md, skills/tfx-setup/SKILL.md, packages/triflux/skills/tfx-setup/SKILL.md, .claude/rules/tfx-routing.md, .gitignore, scripts/setup.mjs
- prompt: |
  SKILL.md 6개 파일 동기화 변경:
  - `skills/tfx-remote/SKILL.md` (와 mirror, 그리고 legacy alias `skills/tfx-remote-spawn/SKILL.md` + mirror) 에서 hosts.json 쓰기 위치를 user-state 경로로 안내:
    - macOS/Linux: `~/.config/triflux/hosts.json`
    - Windows: `%APPDATA%\triflux\hosts.json`
  - 기존 임시 fan-out (Option A) 단계 (SKILL.md 의 2-7-b 또는 유사 섹션 — `references/hosts.json` 을 source/packages/global 3곳에 동기화) 는 제거. user-state 경로 한 곳만 쓰면 됨을 명시.
  - 첫 실행 시 lazy auto-migration 동작 안내 1줄 추가.

  `skills/tfx-setup/SKILL.md` (와 mirror) 변경:
  - `tfx setup` 이 user-state 파일 (`~/.config/triflux/hosts.json` 등) 을 덮어쓰지 않음을 명시
  - 기존 source-tree `references/hosts.json` 은 더 이상 사용하지 않음 (lazy migration 으로 자동 이동)

  `.claude/rules/tfx-routing.md` 변경:
  - tfx-remote-spawn 또는 tfx-remote 블록의 hosts.json 경로 참조를 user-state 경로로 갱신

  `.gitignore` 변경:
  - line 81 `**/hosts.json` 제거
  - line 82 `references/hosts.json` 제거
  - 두 줄 모두 제거 후 인접한 빈 줄 정리

  `scripts/setup.mjs` 변경:
  - hosts.json 을 install/copy 대상에서 제외하는 로직 추가
  - `SETUP_USER_STATE_FILES = ["hosts.json"]` 같은 블랙리스트 상수 도입
  - references/* 파일을 복사하는 루프가 있다면 SETUP_USER_STATE_FILES 에 포함된 파일은 skip
  - 정확한 위치는 setup.mjs 안에서 references/ 또는 skill 자산 복사 로직을 찾아 추가

  packages/* 미러 파일은 `cp` 금지, `Edit` 으로만 동기화.

## Shard: tests
- agent: codex
- files: tests/integration/tfx-remote-v1v2-matrix.test.mjs
- depends: core-compat
- prompt: |
  기존 test 에 다음 케이스 추가 (또는 별도 describe block):

  1. **Migration test**: 임시 디렉토리를 fake user-home 으로 두고 source-tree 에 hosts.json fixture 만 있는 상태에서 `migrateLegacyHosts(tmpRoot)` 호출 → user-state path 에 파일 생성 확인. 두 번째 호출 시 idempotent (`migrated: false, reason: "already-exists"`).

  2. **User-state priority**: user-state path 와 source-tree 양쪽에 다른 hosts.json fixture 존재 시 `readHosts()` 가 user-state 의 데이터를 반환하는지 검증.

  3. **Source-tree fallback**: user-state path 부재 시 source-tree 의 fixture 를 읽는지 검증 (CI 시나리오).

  4. **Migration failure non-fatal**: user-state directory 생성 권한 없음 시뮬레이션 → migrate 실패해도 readHosts() 는 source-tree 로 fallback (throw 금지).

  5. **Cross-platform path**: process.platform 모킹 — Windows 일 때 `%APPDATA%\triflux\hosts.json`, 그 외 `~/.config/triflux/hosts.json` 반환되는지 `userStateHostsPath()` 단위 검증.

  test 는 임시 디렉토리 (`os.tmpdir()` + random suffix) 에서 실행 후 cleanup 필수. 실제 user-home 침범 금지.

  HOME / APPDATA 환경변수 override 로 sandboxing — `process.env.HOME = tmpHome` (Linux/macOS), `process.env.APPDATA = tmpAppData` (Windows). 테스트 시작 시 원래 값 저장, 종료 시 복원.

## 제약

- 기존 `readHosts()` / `resolveHost()` / `readHost()` API 시그니처 변경 금지
- migration 비파괴 + idempotent
- packages/* 미러 동기화는 `cp` 금지, `Edit` 만
- `.gitignore` 두 줄 제거 후 stage state 검증 필요 (의도치 않은 source-tree hosts.json commit 방지)
- migration 실패 시 throw 금지, fallback 동작
- `scripts/setup.mjs` 의 references 복사 로직은 위치 파악 후 정확히 hosts.json 만 skip

## 의존성

- node:fs, node:path, node:os 외 외부 의존 없음

## 테스트 명령

```bash
node --test tests/integration/tfx-remote-v1v2-matrix.test.mjs
node hub/lib/hosts-compat.mjs --self-test
npm run lint
```

## 검증 시나리오

1. Fresh user (user-state 없음, source-tree 있음): readHosts() → migration → 다음 호출부터 user-state
2. Migrated user (양쪽 있음): migration skip, user-state 우선
3. CI 환경 (user-state 부재 + write 권한 없음): source-tree fallback, throw 없음
4. Windows path: `%APPDATA%` 정상 처리
5. `tfx setup` 재실행: 기존 user-state hosts.json 보존

## 완료 조건 (필수)

작업이 끝나면 반드시:
1. 변경 파일 검토 완료 (mirror 동기화 확인)
2. 테스트 명령 실행 및 통과 결과 확인
3. **반드시** 아래 형식으로 커밋 수행:
   ```bash
   git add -A
   git commit -m "fix(#178): hosts.json 을 user-state 경로로 이전 (lazy migration + source-tree fallback)"
   ```
