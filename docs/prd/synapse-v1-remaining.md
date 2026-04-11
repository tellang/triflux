# Synapse v1 — Hub Integration Remaining Shards

> Source: deep-plan 92% consensus (2026-04-11)
> Previous shards (packages-sync, claude-md-codex-config, gemini-wrapper-diag) completed.

## Shard: hub-synapse-wiring (T1)
- agent: codex
- files: hub/server.mjs
- depends: none
- prompt: |
    hub/server.mjs에 Synapse 레이어 3개 모듈을 배선한다.

    1. import 추가 (line 43 이후):
       - import { createSynapseRegistry } from "./team/synapse-registry.mjs"
       - import { createGitPreflight } from "./team/git-preflight.mjs"
       - import { createSwarmLocks } from "./team/swarm-locks.mjs"

    2. 인스턴스 생성 (line 575, delegatorService 이후 / hitl 이전):
       - const synapseRegistry = createSynapseRegistry({ persistPath: join(CACHE_DIR, "tfx-hub", "synapse-sessions.json"), emitter: router.deliveryEmitter })
       - const swarmLocks = createSwarmLocks({ repoRoot: PROJECT_ROOT, persistPath: join(CACHE_DIR, "tfx-hub", "swarm-locks.json") })
       - const gitPreflight = createGitPreflight({ registry: synapseRegistry, locks: swarmLocks })

    3. 기존 코드 변경 없음. import + 인스턴스 추가만.

## Shard: synapse-registry-events (T2)
- agent: codex
- files: hub/team/synapse-registry.mjs
- depends: hub-synapse-wiring
- prompt: |
    synapse-registry.mjs에 이벤트 emission을 구현한다.

    1. createSynapseRegistry(opts)에 emitter 파라미터 추가:
       - opts에서 emitter 구조분해 (기본값 null)

    2. 4개 TODO를 emit 호출로 교체:
       - L104: emitter?.emit("synapse.session.stale", { sessionId, session })
       - L115: emitter?.emit("synapse.session.removed", { sessionId, session })
       - L171: emitter?.emit("synapse.session.started", { sessionId, session })
       - L219: emitter?.emit("synapse.session.heartbeat", { sessionId, partial })

    3. 기존 staleCallbacks/removedCallbacks는 유지 (하위 호환).

## Completed Shards (archived)
- packages-sync: 5c921e4, c51fd62
- claude-md-codex-config: 5c921e4
- gemini-wrapper-diag: 01faffa (stderr 보존 추가)
