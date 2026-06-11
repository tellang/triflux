# HOTFIX PRD — hub/server.mjs 고아 프로세스 누수 (+ tray 생성 경로)

> 작성: Claude (조사+설계). 구현: Codex. 구현 후 교차검증: Claude 별도 패스 (self-approve 금지).
> 런타임 누수 인스턴스(48개/1.4GB)는 이미 수동 종료 완료. 본 PRD는 **재발 방지 코드 수정**만 다룬다.
> 주의: 워킹트리는 이미 dirty(진행 끝난 tray-lifecycle 작업 위). 이 위에 stack 한다.

## 1. 확정된 근본 원인 (실측 기반)

`lsof`+`sample` 해부로 확정:
- 고아들은 멈춘 게 아니라 **각자 고유 비표준 포트(28800~29200)에서 정상 LISTEN 중인 완전 기동 hub** (state.db·pipe 소켓·TCP listener 보유, 이벤트루프 idle).
- 각 고아 env에 **서로 다른 `TFX_HUB_PORT`** 가 박혀 있음(예: 29009, 28802, 29132). 출처: triflux worker worktree(codex-register-hook / tfx-skill-inject / agent-a7608…).
- primary(27888) 1개만 정상. **정상 hub도 detached라 ppid==1** → "ppid==1이면 종료" 규칙은 절대 금지(정상 hub를 죽임).

### 결함 A — 생성: 워커별 hub 난립 (2개 spawn 경로)
- `scripts/hub-ensure.mjs` `resolveHubTarget()`(L596-623)가 `envPort ?? 27888` 로 워커 env의 비표준 `TFX_HUB_PORT` 를 그대로 채택 → `startHubDetached()`(L631-648)가 워커마다 전용 hub spawn.
- **두 번째 경로**: `hub/tray-lifecycle.mjs` `ensureHubForTray()`(L54-, detached+unref L79/83)도 hub 를 spawn. 이 경로도 비표준 포트를 받으면 동일 누수.
- PR #158/#197 이 막은 "비표준 포트 영속화"가 pidfile 이 아닌 **env 채널**로 재발.

### 결함 B — 회수: 고아 hub 불멸 (키스톤)
- `hub/server.mjs:117` `HUB_IDLE_TIMEOUT_DEFAULT_MS = 0` → idle 자동종료 비활성.
- 부모사망(ppid==1) 감지 없음; detached+unref → 부모 SIGTERM 도달 불가.
- 유일한 고아청소 `cleanupOrphanNodeProcesses()` 가 shutdown 핸들러(L2880-2917) 안에만 존재 → 고아는 shutdown 을 안 하니 영원히 미실행. 자기 자신도 못 치움.
- reaper/retire 가 공유 pidfile 의 **단일 27888 pid 만** 추적 → 비표준 포트 hub 는 불가시·불멸.

## 2. 접근 방침 — 기존 tray 패턴과 일관

방금 끝낸 tray 작업이 `hub/tray.mjs:47 reapExistingMacTrayProcesses` (ps 열거→scriptPath 매칭→self 제외→SIGTERM, tray 기동 시 L417 호출) **startup-reaper** 패턴을 도입했다. hub 누수도 **같은 패턴**으로 고친다(즉시 청소 + 비가시 비표준포트 hub 까지 enumerate). idle-timeout 은 보조 안전망으로만.

## 3. 구현할 패치

### Patch H0 (1순위, tray reaper 미러) — `reapExistingHubProcesses()`
`reapExistingMacTrayProcesses` 를 그대로 미러링한 hub 버전을 추가한다(가능하면 `hub/tray-lifecycle.mjs` 또는 신규 `hub/hub-lifecycle.mjs`, 아니면 `hub/server.mjs`).
- `ps -axo pid,ppid,command` 열거 → command 가 `hub/server.mjs` (정규식: 기존 `isHubServerCommand` 재사용, scripts/hub-ensure.mjs:145 에 export 있음) 인 프로세스 수집.
- **제외 대상(보존)**: (a) self(process.pid), (b) **canonical primary = pidfile(`~/.claude/cache/tfx-hub/hub.pid`)의 pid**, (c) 27888(HUB_DEFAULT_PORT)에 LISTEN 중인 pid. 즉 "정상 싱글턴"만 살린다.
- 나머지(비표준 포트 고아 hub)에 SIGTERM(필요시 SIGKILL 에스컬레이션 — 기존 `retireHubProcess` 패턴 참고).
- **호출 위치**: canonical hub 가 startup 에 성공했을 때만 — `hub/server.mjs` bootstrap 의 listen 성공 경로에서 `port === HUB_DEFAULT_PORT && !reused` 일 때 1회 호출. (tray reaper 가 tray 기동 시 호출되는 것과 대칭.) reused/exit 경로에서는 호출 금지.
- dependency injection 가능하게 작성(execFileSyncFn/killFn/currentPid 주입) — 기존 reaper·test 스타일과 동일하게.

### Patch H1 (보조 안전망) — idle 자동종료 기본값
`hub/server.mjs:117`:
```js
// before: const HUB_IDLE_TIMEOUT_DEFAULT_MS = 0;
// after: 비-canonical 포트(워커 hub)만 idle 후 self-shutdown; 27888 primary 는 영구(0).
```
선언 시점 순서 문제로 상수에서 직접 못 쓰면, `startHub` 내부에서 `port` 결정 후 `hubIdleTimeoutMs` 기본값을 `port === HUB_DEFAULT_PORT ? 0 : 30*60*1000` 으로 계산. 기존 idle 인프라(L2447-2467) 재사용. env `TFX_HUB_IDLE_TIMEOUT_MS` override 보존.

### Patch H2 (정확성) — pidfile 소유권 가드
`hub/server.mjs` stopFn 의 `unlinkSync(PID_FILE)`(L2426-2428) 및 uncaughtException/unhandledRejection 의 `cleanupPidFile()`(L2844-2848):
```js
try {
  const own = JSON.parse(readFileSync(PID_FILE, "utf8"));
  if (Number(own?.pid) === process.pid) unlinkSync(PID_FILE);
} catch {}
```
비-primary hub 의 종료가 primary pidfile 을 지우지 않게. `readFileSync` import 확인. (TOKEN_FILE 도 동일 고려 — 단 토큰은 공유 단일 파일이므로 primary 만 관리하도록.)

### Patch H3 (생성 차단) — 두 spawn 경로 모두
**먼저 env 발원지 추적**: 비표준 `TFX_HUB_URL`/`TFX_HUB_PORT` 가 worker worktree env 로 들어가는 곳. 후보: `scripts/lib/env-probe.mjs:242`(statusUrl.port → TFX_HUB_PORT 전파), `scripts/tfx-route.sh:780-786`(TFX_HUB_URL→포트), `hub/team/*` worker/swarm spawn env, conductor/headless. 워커 격리가 의도인지 stale 오염인지 판정.
- **오염이면**(유력): hub spawn 결정 지점(`hub-ensure.mjs resolveHubTarget` **그리고** `tray-lifecycle.mjs ensureHubForTray`)이 worktree/ephemeral 컨텍스트(cwd 가 `.claude/worktrees/`/`.worktrees/` 하위, 또는 ephemeral 마커 env)에서는 **비표준 TFX_HUB_PORT 를 무시하고 27888 강제**. 그 컨텍스트에선 아예 hub 를 새로 안 띄우고 27888 primary 재사용/대기.
- **의도된 격리면**: 워커 hub 에 워커 생명주기 바인딩(워커 종료 시 동반 종료) 추가. 이 경우에도 H0/H1 유지.
- 판정 근거와 채택 접근을 PR 설명에 명시.

### Patch T (tray) — 사용자 지시: "트레이도 수정 필요"
- `tray-lifecycle.mjs ensureHubForTray`(L54)가 hub 를 spawn 하는 경로도 H3 의 canonical-port 강제 대상에 포함(위에 반영).
- tray 자체(detached+unref, self-종료 없음)는 현재 startup-reaper 로 청소되나, hub 가 사라지면 tray 도 정리되도록 일관성 점검. 과하게 키우지 말 것 — 사용자 확인된 범위는 "hub 누수 수정이 tray spawn 경로를 건드리는 것"까지. 추가 tray 리팩토링은 별도 TODO 로 남긴다.

## 4. triflux 규약 (필수)
- **mirror**(.claude/rules/tfx-mirror-policy.md): `hub/server.mjs`·`hub/tray.mjs`·`hub/tray-lifecycle.mjs`·신규 `hub/*.mjs` → `packages/triflux/hub/` (+ `packages/remote/hub/` import 경로 변환, 해당 시 `packages/core/hub/`). `scripts/hub-ensure.mjs`·`scripts/lib/*` → `packages/triflux/scripts/` (+remote/core 해당분). 변경 후 `diff -q` 검증, mirror 체크리스트 7단계 통과. 워킹트리에 이미 packages/* 미러 변경이 있으니 그 위에 일관되게.
- **테스트**: H0 reaper(보존 대상 제외 로직 — self/pidfile-pid/27888 살리고 나머지 SIGTERM), H1 idle 포트조건부, H2 pidfile 소유권, H3 env sanitization. 기존 인접 테스트: `tests/unit/hub-server-port.test.mjs`, `tests/unit/state.test.mjs`, `tests/unit/hub-ensure-port-cascade.test.mjs`, `tests/unit/hub-ensure-version-drift.test.mjs`, tray reaper 테스트가 있으면 미러. `npm test` 그린.
- 커밋/PR **AI attribution footer/trailer 금지**(tfx-ship 규약).

## 5. 수용 기준
- canonical hub 기동 시 비표준 포트 고아 hub 전부 reap (H0). primary(27888) 보존.
- 워커 hub 는 idle 후 self-shutdown (H1 보조망).
- 비-primary hub 종료가 primary pidfile/token 미파괴 (H2).
- 워커/tray 가 worktree/ephemeral 에서 비표준 포트 hub 를 새로 안 띄움 (H3).
- packages mirror 동기화 + 신규 테스트 그린 + `npm test` 그린.
- 회귀 금지: PR #158/#197 의 codex config.toml 포트 안정화(27888 고정) 깨지 않을 것.

---

## FIX-UP 라운드 (교차검증 발견 — Claude review → Codex 구현)

1차 구현(H0~H3) 교차검증에서 확정된 결함. 1차는 머지하지 말고 이 fix-up까지 포함해 완성한다.

### FU1 (HIGH, 확정) — H3 커버리지 갭: server 바운더리에서 막아라
H3 가드(resolveHubPortForContext)가 hub-ensure·tray-lifecycle 두 경로에만 들어가, **나머지 2개 spawn 경로가 비표준 포트 hub를 그대로 띄운다**:
- `scripts/lib/env-probe.mjs` `checkHub()`(L214-247, restart=true 기본)가 **매 SessionStart**(preflight-cache.mjs:156 → session-start-fast.mjs:317-321)마다 `TFX_HUB_PORT=new URL(statusUrl).port`로 `hub/server.mjs`를 spawn. statusUrl은 resolveDefaultStatusUrl(L40-45)이 env의 TFX_HUB_PORT를 가드 없이 읽음. → 워커 worktree(TFX_HUB_PORT=29009)에서 매 세션 비표준 hub 생성.
- `scripts/tfx-route.sh:780-786` hub 자동재시작도 TFX_HUB_URL에서 포트 뽑아 가드 없이 spawn.

**키스톤 수정 (단일 지점 방어)**: `hub/server.mjs` 부트스트랩의 포트 결정을 가드 통과시켜라. 현재 `resolveHubPort(process.env)`(L269-273, 부트스트랩 ~L2877)가 TFX_HUB_PORT를 그대로 읽는다 → **`resolveHubPortForContext({ env: process.env, cwd: process.cwd() })`로 교체**. 그러면 어떤 spawner(env-probe/tfx-route/hub-ensure/tray/미래)가 띄워도, 서버 자신이 worktree/ephemeral cwd·env에서 27888로 바인딩 → tryReuseExistingHub가 27888 primary를 reuse하고 exit → 고아 미생성. 일반(비-worktree) 커스텀 포트는 그대로 honor (회귀 없음).
- 추가 방어(권장): env-probe.mjs resolveDefaultStatusUrl/checkHub도 resolveHubPortForContext 적용. tfx-route.sh는 cwd가 worktree/ephemeral이면 hub_port=27888 강제(shell 인라인 체크).
- 회귀 가드: 비-worktree에서 TFX_HUB_PORT 커스텀 honor되는지 테스트 유지. PR #158/#197 27888 안정화 불변.

### FU2 (MEDIUM, 확정) — H2 미완: TOKEN_FILE 소유권 가드
PRD H2가 "TOKEN_FILE도 primary만 관리"를 명시했으나 PID만 가드됨. `~/.claude/.tfx-hub-token`(server.mjs:248)은 포트 없는 단일 공유 파일이라, 비-primary hub가 TFX_HUB_TOKEN 없이 뜨면 startup(L998-1000)에서 primary 토큰을 unlink, shutdown(L2466-2469)·cleanupStartupFailure(L2281)에서도 무조건 삭제. → token auth 사용 시 워커가 primary 인증을 지움.
- 수정: `cleanupOwnedTokenFile()` 도입(파일 내용이 자기 소유일 때만 삭제) 또는 **port===HUB_DEFAULT_PORT일 때만 TOKEN_FILE 관리**. 3개 지점 모두 적용.

### FU3 (LOW, 선택)
- `isWorktreeOrEphemeralHubContext` cwd 검사에 triflux 스웜 레이아웃 `/.codex-swarm/wt-`(또는 `/wt-`) 추가 (현재 env-key fallback으로 잡히나 cwd-only 케이스 누락). hub-lifecycle.mjs:43-48.
- reaper 관측성: SIGKILL 실패 시 silent swallow(hub-lifecycle.mjs:212) → failed 목록/로그.
- `parsePort`로 pid 검증(hub-lifecycle.mjs:182)을 `parsePositiveInt`로 명명 정리.

### 비차단 메모 (사용자 판단)
- native-bridge auth 변경(experiments/claude-native-worker-*, claude-daemon-control 연동)은 정당한 수정이나 **핫픽스와 무관 → 별도 커밋 분리 권장** (scope-creep 리뷰: tampering 아님 확인).
- 루트 스크래치 `test-popover.swift`/`test-webview.swift` 정리 검토.
- check-packages-mirror가 packages/remote를 검증 안 함(거짓 안심) — 별도 개선 TODO.

### 수용 기준 (fix-up)
- 워커/ephemeral 컨텍스트에서 env-probe·tfx-route 경로로도 비표준 포트 hub가 **생성되지 않음**(server 바운더리 가드). 라이브: 워커 env로 SessionStart 시 새 hub 0개.
- 비-primary hub가 primary TOKEN_FILE 미파괴.
- npm test 그린 + mirror 동기화 + 신규 회귀 테스트(server-level 포트 가드, token 소유권).
