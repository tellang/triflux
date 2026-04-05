# tfx-swarm — 통합 스웜 오케스트레이션

> **Canonical swarm entrypoint.** tfx-codex-swarm + tfx-remote-spawn을 일반화 통합.
> PRD → swarm-planner → swarm-hypervisor 파이프라인을 단일 스킬 호출�� 실행한다.

## 트리거

- `swarm`, `스웜`, `병렬 실행`, `다중 워커`, `PRD 실행`, `swarm launch`
- `codex-swarm` (backward compat → 이 스킬로 라우팅)

## 전제조건

- psmux ≥ 3.3.0
- Hub 실행 중 (`curl -sf http://127.0.0.1:27888/status`)
- Codex CLI (`codex --version`)
- 프로젝트에 `docs/prd/` 디렉토리 존재

## 실행 흐름

### Step 1: PRD 탐색

```bash
find docs/prd -name '*.md' -not -name '_template.md' -not -path '*/archived/*' | sort
```

AskUserQuestion으로 실행할 PRD 선택. 복수 선택 시 각각 독립 shard.

### Step 2: 계획 생성

```javascript
import { plan } from '../../hub/team/swarm-planner.mjs';

const swarmPlan = plan({
  prdText: selectedPrdContent,
  baseBranch: 'main',
  provider: 'codex', // 기본값, AskUserQuestion으로 변경 가능
});
```

계획을 사용자에게 보여주고 승인 요청:
- shard 수, 파일 배분, lease 맵, merge 순서
- critical shard 표시 (redundant execution 대상)

### Step 3: Hypervisor 실행

```javascript
import { createSwarmHypervisor } from '../../hub/team/swarm-hypervisor.mjs';

const hyper = createSwarmHypervisor({
  rootDir: process.cwd(),
  maxConcurrency: 4,
});

const run = await hyper.launch(swarmPlan);
```

실행 중 상태 모니터링:
- `hyper.on('shardLaunched', ...)` → 진행 표시
- `hyper.on('shardDone', ...)` → 완료/실패 표시
- `hyper.on('zombieDetected', ...)` → 경고

### Step 4: 결과 검증 + 통합

```javascript
// 각 shard 결과 검증
for (const shard of swarmPlan.shards) {
  const v = hyper.validateResult(run.runId, shard.id);
  if (!v.accepted) console.log(`${shard.id}: ${v.reason}`);
}

// merge order에 따라 integration branch로 통합
const integration = await hyper.integrateResults(run.runId);
```

통합 결과를 사용자에게 보고:
- 성공: merged shard 목록
- 실패: 충돌/실패 shard 목록 + 수동 해결 안내

### Step 5: 정리

```javascript
await hyper.cleanup(run.runId, { keepFailedWorktrees: true });
```

### Step 6: pack.mjs 동기화

새 모듈이 hub/team/에 추가되었으므로:

```bash
npm run pack
```

REMOTE_INDEX에 새 export가 필요하면 scripts/pack.mjs 수정 후 재실행.

## 제약

- `codex exec` / `gemini -p` 직접 호출 금지 (headless-guard)
- MAX_CONCURRENCY 기본 4 (WT 프리징 방지)
- WT 조작 간 sleep 2s (race-guard)
- config.toml과 CLI 플래그 중복 지정 금지

## Redundant Execution

critical shard (hard lease 또는 고위험 파일)에 대해:

```javascript
import { shouldRunRedundant, reconcile } from '../../hub/team/swarm-reconciler.mjs';

if (shouldRunRedundant(shard)) {
  // primary + verifier 이중 실행
  const decision = await reconcile(primaryResult, verifierResult);
  // decision.selected: 'primary' | 'verifier' | 'hitl'
}
```

HITL fallback 시 AskUserQuestion으로 사용자에게 선택 요청.

## Remote Shard 지원 (Lake 3)

PRD에 `- host: <ssh-host>` 필드를 추가하면 해당 shard가 원격 머신에서 실행된다.

```markdown
## Shard: heavy-analysis
- agent: codex
- host: ultra4
- files: src/analysis/engine.mjs
- prompt: 대규모 분석 엔진 구��
```

동작 원리:
1. swarm-planner가 `host` 필드를 파싱하여 shard에 포함
2. swarm-hypervisor의 `launchShard()`가 `probeRemoteEnv(host)`로 원격 환경 감지
3. conductor의 `spawnSession({ remote: true, host, ... })`로 원격 세션 실행
4. worktree-lifecycle이 `remoteGit()`으로 SSH 경유 worktree 생성

전제조건:
- SSH 키 인증 설정 완료 (`ssh ultra4` 패스워드 없이 접속 가능)
- 원격 머신에 Claude Code 설치됨 (`probeRemoteEnv`가 자동 확인)
- hosts.json 등록 권장 (`/tfx-remote-setup`으로 설정)

host 미지정 shard는 기존대로 로컬 실행. 로컬/원격 혼합 가능.

## 기존 tfx-codex-swarm과의 관계

- tfx-codex-swarm은 이 스킬의 **backward compat alias**
- 기존 워크플로우(PRD 스캔 → worktree 생성 → Codex 실행)는 동일
- 차이: 프로그래밍 API 기반, file lease, redundant exec, 자동 merge

## tfx-remote-spawn과의 관계

- tfx-remote-spawn의 핵심 함수가 `hub/team/remote-session.mjs`로 모듈화됨
- swarm-hypervisor가 이 모듈을 사용하여 원격 세션을 관리
- tfx-remote-spawn 스킬은 **단독 원격 세션 관리**용으로 유지 (list, attach, send)
- swarm은 **다중 shard 병렬 관리** (로컬+원격 혼합)
