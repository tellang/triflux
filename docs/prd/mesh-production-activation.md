# PRD: Mesh 프로토콜 프로덕션 활성화

## 목표

구축 완료된 mesh/ 모듈과 conductor-mesh-bridge를 프로덕션 코드에 연결하여
Agent Mesh를 실제 런타임에서 활성화한다.

## Shard 1: conductor에 mesh bridge attach
- agent: codex
- files: hub/team/conductor.mjs, hub/team/conductor-mesh-bridge.mjs
- prompt: |
    hub/team/conductor.mjs에서 conductor 생성 시 mesh bridge를 자동으로 attach하도록 한다.

    현재 상태:
    - conductor-mesh-bridge.mjs에 `createConductorMeshBridge(conductor, registry)` 구현 완료
    - 테스트도 통과 (tests/unit/conductor-mesh-bridge.test.mjs)
    - 하지만 프로덕션 코드에서 한 번도 호출되지 않음

    변경 사항:
    1. conductor.mjs의 `createConductor()` 또는 factory 함수에 mesh bridge 초기화를 추가:
       ```javascript
       import { createConductorMeshBridge } from './conductor-mesh-bridge.mjs';
       import { createRegistry } from '../../mesh/mesh-registry.mjs';

       // conductor 생성 시 (옵션으로 mesh 활성화)
       if (opts.enableMesh !== false) {
         try {
           const registry = opts.meshRegistry || createRegistry();
           const bridge = createConductorMeshBridge(conductor, registry);
           bridge.attach();
           conductor._meshBridge = bridge;
           conductor._meshRegistry = registry;
         } catch (e) {
           // mesh 실패해도 conductor는 정상 동작
         }
       }
       ```
    2. conductor 종료 시 bridge detach:
       ```javascript
       // cleanup/destroy에서
       if (conductor._meshBridge) conductor._meshBridge.detach();
       ```
    3. conductor에 mesh registry 접근 메서드 추가:
       ```javascript
       getMeshRegistry() { return this._meshRegistry || null; }
       ```

    제약:
    - `enableMesh: false`로 비활성화 가능해야 함 (기존 테스트 호환)
    - mesh import 실패 시 graceful fallback (모듈 없어도 conductor 동작)
    - 기존 conductor 테스트 전체 통과 필수
    - 파일 800줄 이하

    커밋 메시지: "feat(conductor): mesh bridge 프로덕션 활성화 — 자동 attach/detach"

## Shard 2: swarm-hypervisor에 공유 registry 전달
- agent: codex
- files: hub/team/swarm-hypervisor.mjs
- prompt: |
    swarm-hypervisor.mjs에서 생성하는 모든 conductor에게 동일한 mesh registry를 공유하도록 한다.

    현재 상태: swarm-hypervisor가 각 shard마다 독립 conductor를 생성하지만, mesh registry는 전달하지 않는다.

    변경 사항:
    1. `createSwarmHypervisor()` 초기화 시 공유 registry 생성:
       ```javascript
       import { createRegistry } from '../../mesh/mesh-registry.mjs';
       const sharedRegistry = createRegistry();
       ```
    2. 각 shard의 conductor 생성 시 공유 registry 전달:
       ```javascript
       const conductor = createConductor({
         ...shardOpts,
         meshRegistry: sharedRegistry,
         enableMesh: true,
       });
       ```
    3. hypervisor에 registry 접근 메서드 추가:
       ```javascript
       getMeshRegistry() { return sharedRegistry; }
       ```
    4. hypervisor cleanup 시 registry clear:
       ```javascript
       sharedRegistry.clear();
       ```

    제약:
    - mesh 모듈 import 실패 시 graceful fallback
    - 기존 swarm 테스트 통과 필수
    - sharedRegistry는 hypervisor 수명과 동일

    커밋 메시지: "feat(swarm): 공유 mesh registry로 shard 간 에이전트 discovery 활성화"

## 파일
- `hub/team/conductor.mjs` (수정, ~25줄 추가)
- `hub/team/conductor-mesh-bridge.mjs` (변경 없음, 기존 코드 활용)
- `hub/team/swarm-hypervisor.mjs` (수정, ~15줄 추가)

## 제약
- mesh 비활성화 옵션 필수 (enableMesh: false)
- mesh import 실패 시 graceful fallback
- 기존 테스트 전체 통과
- 파일 800줄 이하

## 테스트 명령
```bash
node --test tests/unit/conductor*.test.mjs
node --test tests/unit/mesh-*.test.mjs
node --test tests/unit/swarm*.test.mjs
npm test
```
