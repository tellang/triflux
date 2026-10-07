---
id: 0031
title: CLI와 배포 표면을 줄인다 (2026-10 슬롭 정리 2단계)
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0020, 0023, 0025]
pr: null
---

# ADR-0031: CLI와 배포 표면을 줄인다 (2026-10 슬롭 정리 2단계)

## 컨텍스트와 문제

2026-10 전수 감사(`.triflux/plans/slop-audit-2026-10.md`)는 사용 기록이 없거나 구현만 있고 연결되지 않았거나, 공식 경로가 아니라서 유지 비용이 큰 공개 표면을 찾았다. 코드만으로 지울 수 있는 것은 PR #607~#613으로 이미 머지했다. 남은 것은 사용자 판단이 필요한 항목이었고, 2026-10-08에 사용자가 결정표를 검토해 권고대로 확정했다. 이 ADR은 그 결정과 이유를 기록한다.

## 결정

다음을 공개 표면에서 뺀다. 판단 근거는 세션 transcript 90일 사용 기록, 다른 경로와의 중복, 비공식 경로 의존이다.

| 대상 | 이유 | 처리 |
| --- | --- | --- |
| `tfx handoff`, `tfx codex-team`, `tfx notion-read`, `tfx monitor` | 90일 사용 0. `monitor`는 macOS에서 PowerShell 명령을 실행하는 결함도 있다 | 삭제 |
| `tfx schema`의 delegator 번들, `scripts/completions/*`, `tfx-setup-tui`와 `tfx-doctor-tui` 껍데기, `tfl` 별칭 | 90일 사용 0, 내용 없는 껍데기 | 삭제 |
| `checkForUpdate` | `tfx`와 `tfx help`가 `npm view`를 최대 5초 동기 대기하고 개발 버전에서도 "업데이트 있음"을 표시한다. 업데이트 감지는 세션 시작 훅과 `tfx update`가 맡는다 | 삭제 |
| `tfx stealth-fetch`, optionalDependencies 2개, setup 설치 단계 | 안티봇 우회라는 비공식 경로이고 90일 실행 0 | 삭제 |
| Codex app-server 워커(`hub/workers/codex-app-server-worker.mjs`) | 1067줄이 어디에도 연결되지 않았다 | 삭제, 의도는 아래에 보존 |
| `experiments/native-bridge-feasibility/` | 일회성 프로브와 보고서 | 카나리로 쓰는 2개(`codex-app-server-uds-smoke`, `claude-native-worker-adoption-probe`)만 남기고 삭제 |

**Codex 워커 진행 관찰이라는 의도의 보존**: 삭제한 워커가 겨냥한 "Codex 워커 진행을 실시간으로 본다"는 기능은 다른 경로가 맡는다.

- 사람이 보는 쪽: `tfx-live start --cli codex --session <tmux> --name ...`으로 워커를 띄우고 `tmr`로 연다(ADR-0029의 기본값).
- 리드가 기계적으로 받는 쪽: `tfx-live`의 Codex app-server UDS 경로(`jsonrpc-ws-uds`, `uds-orchestrator`)가 맡는다. 새 요구가 생기면 이 클라이언트 위에 짓는다.

### 이미 머지된 변화(PR #607~#613)

릴리스 노트에 모을 공개 표면 변화는 다음과 같다.

| 영역 | 빠지거나 바뀐 것 |
| --- | --- |
| `@triflux/core` | `./mesh/*` export, `CORE_INDEX`의 `executeGemini`, adaptive, reflexion, fingerprint export |
| `@triflux/remote` | 배럴의 swarm-reconciler export |
| `current.json` | `sources` 키 집합에서 session_vault, agy, gbrain 제거 |
| CLI | `tfx review`, `tfx why`, `tfx auto`, `tfx cto steward\|dashboard\|event`, doctor `--dynamic-routing`, `tfx-profile` |
| 이름과 값 | 에이전트 이름과 `TFX_CLI_MODE`의 `gemini` 값 |
| 환경변수 | `TFX_ROUTE_NODE`, `TRIFLUX_DYNAMIC_ROUTING`, `TFX_CODEX_TRANSPORT=mcp` |

## 검토한 대안

- **전부 유지**: 호환성 부담이 없다. 그러나 사용 기록이 없는 명령도 테스트, 문서, 보안 점검 비용이 계속 든다.
- **명령별로 사용자에게 유지 여부 확인**: 의도치 않은 삭제를 막는다. 사용자가 직접 쓰는 명령이 없다고 답해 기본값인 일괄 삭제로 확정됐다.
- **권고대로 일괄 삭제(채택)**: 표면과 유지 비용이 크게 준다. 대신 외부에서 우연히 쓰던 사용자가 있으면 깨지므로 릴리스 노트에 모두 명시한다.

## 결과

- 삭제는 분류별 PR로 나누어 머지하고 마지막에 한 번 릴리스한다. 각 삭제 PR 본문에 Codex 워커 의도와 대체 경로를 적는다.
- 지우는 명령은 별칭이나 안내 없이 사라진다. 필요해지면 새 ADR로 되살린다.
- `@triflux/core` 배럴의 축소와 `packages/triflux`에서 개발 도구를 빼는 작업은 `package.json`을 건드리므로 이 삭제 PR이 머지된 뒤에 한다.
- 이 ADR은 ADR-0020의 스킬 표면 축소를 CLI와 패키지 배포로 넓히고, ADR-0025의 swarm 퇴역과 ADR-0023의 허브 제거 작업과 같은 릴리스 노트에 묶인다.
