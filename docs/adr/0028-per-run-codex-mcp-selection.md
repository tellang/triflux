---
id: 0028
title: Codex MCP 선택은 전역 설정 교체 대신 실행별 -c 설정으로 한다
status: accepted
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0015]
pr: "#617"
---

# ADR-0028: Codex MCP 선택은 전역 설정 교체 대신 실행별 -c 설정으로 한다

## 컨텍스트와 문제

`scripts/tfx-route.sh`의 `_codex_config_swap`은 Codex 실행 동안 전역 `~/.codex/config.toml`에서 허용하지 않은 `[mcp_servers.*]` 섹션을 지웠다가 실행이 끝나면 되돌렸다. 이 방식은 두 가지 결함이 있었다.

- 실행 중에는 같은 시각의 다른 Codex 세션도 줄어든 설정을 읽는다.
- 라우터가 비정상 종료하면 복원이 일어나지 않아 MCP 항목이 줄어든 채로 남는다. 2026-10-08에 두 번 발생했고 한 번은 MCP 서버 8개가 사라졌다.

사용자 전역 파일을 실행의 부작용으로 쓰는 구조 자체가 원인이다.

## 결정

Codex가 쓸 MCP 서버는 실행별 인자 `-c mcp_servers.<이름>.enabled=false|true`로 고른다. 전역 `config.toml`은 읽기만 하고 쓰지 않는다. `_codex_config_swap`과 호출부는 삭제한다.

- override 대상은 `config.toml`에 섹션이 있는 서버로 한정한다. 섹션이 없는 플러그인 서버에 `-c`를 주면 Codex가 `failed to load bootstrap configuration`으로 기동하지 못한다.
- `mcp-filter`가 만드는 플래그 구분자를 쉼표에서 `\x1f`로 바꾼다. `enabled_tools=[...]` 배열이 쉼표에서 쪼개지던 문제를 없앤다.
- MCP preflight는 죽은 서버의 override를 지우지 않고 `enabled=false`로 바꾼다. 지우면 config 기본값대로 다시 켜진다.
- doctor의 `config.toml.pre-exec` 복원은 예전 버전이 남긴 파일을 치우는 용도로만 둔다.

## 검토한 대안

- **swap 유지, 복원 보강(trap, 락)**: 변경이 작다. 그러나 동시 세션이 줄어든 설정을 보는 문제가 남고, SIGKILL이나 전원 차단에서는 복원이 보장되지 않는다.
- **실행마다 임시 `CODEX_HOME`에 설정 사본 작성**: 전역 파일을 건드리지 않는다. 그러나 인증과 세션 기록, 프로필 파일을 모두 연결해야 해서 Codex 내부 구조에 의존한다.
- **실행별 `-c` override(채택)**: 상태를 파일에 남기지 않으므로 동시성과 비정상 종료 문제가 구조상 사라진다. 대신 Codex의 `-c` 키 규약에 의존한다.

## 결과

- 실행 전후 `~/.codex/config.toml` 해시가 같다. codex-cli 0.160.1 실측에서 `codex -c 'mcp_servers.exa.enabled=false' mcp list`가 해당 서버를 disabled로 표시했고, 이 브랜치의 라우터를 실제 Codex로 1회 실행해 해시 동일을 확인했다.
- 구 swap 테스트(`tfx-route-config-swap.test.mjs`)는 삭제하고 `tfx-route-config-per-run.test.mjs`로 바꿨다.
- `packages/triflux`, `packages/core`, `packages/remote`에 미러했다.
- ADR-0015의 exec 전송 계약은 그대로다. 이 결정은 MCP 선택 방식만 바꾼다.
- 되돌릴 조건: Codex가 `-c`의 `mcp_servers.*.enabled` 키를 지원하지 않게 되면 재검토한다.
