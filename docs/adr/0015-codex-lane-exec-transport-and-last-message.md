---
id: 0015
title: Codex 레인은 exec 전송과 최종 메시지 파일을 결과 계약으로 삼는다
status: proposed
date: 2026-09-21
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0004, 0006]
pr: "#503"
---

# ADR-0015: Codex 레인은 exec 전송과 최종 메시지 파일을 결과 계약으로 삼는다

## 컨텍스트와 문제 (Context)
Codex CLI 공식 레퍼런스는 `codex mcp-server` 명령과 `codex-mcp-server` 바이너리가 제거됐고 app server 를 쓰라고 적는다. changelog 에는 2026-08-24 에 deprecated 로 올라왔다. 0.154 이후 실측에서 이 명령은 인터랙티브 CLI 로 넘어가 터미널이 없다는 오류로 끝난다.

`scripts/tfx-route.sh` 의 기본 전송 `auto` 는 MCP 서버가 살아 있으면 MCP 워커를 먼저 띄웠다. 그래서 모든 Codex 디스패치가 실패한 워커 한 번과 경고를 거친 뒤 exec 로 폴백했다.

결과 계약에도 호출자가 결과를 바로 읽지 못하는 문제가 있었다.

- `=== OUTPUT ===` 이 최종 답이 아니라 hook, exec 추적, 파일 덤프가 섞인 stdout 전체였다.
- 출력 상한을 넘으면 머리를 남겨, 꼬리에 있는 최종 답이 잘렸다.
- 최종 메시지 없이 exit 0 으로 끝난 실행이 success 로 보고됐다.
- Codex 0.155 는 배너, 프롬프트 에코, 실행 추적을 stderr 로 낸다. 이를 경고로 분류해 정상 실행이 항상 success_with_warnings 였다.

## 결정 (Decision)
우리는 Codex 레인의 전송을 exec 로 고정하고, 공식 `--output-last-message` 파일을 결과의 정본으로 삼기로 한다.

- **전송**: `TFX_CODEX_TRANSPORT=auto` 는 MCP 워커를 거치지 않고 exec 로 간다. `mcp` 를 명시하면 업스트림 제거 사실을 한 줄로 알리고 exec 로 계속한다.
- **결과 정본**: exec 와 재시도 경로에 `--output-last-message <파일>` 을 넘기고 그 내용을 `=== OUTPUT ===` 으로 낸다. 원본 추적은 결과 헤더의 로그 경로로 남긴다.
- **절삭**: 상한을 넘으면 꼬리를 남긴다.
- **상태**: exit 0 이어도 최종 메시지와 의미 있는 stdout 이 모두 없으면 `status: partial`, `reason: no_final_message` 로 보고한다.
- **경고 분류**: tracing 형식의 WARN, ERROR 줄과 배너 앞의 warning, error 줄만 경고로 올린다.
- **후처리기**: 라우터는 자기와 같은 디렉터리의 후처리기를 먼저 쓰고 설치본은 폴백으로 둔다.
- **MCP 워커**: `hub/workers/codex-mcp.mjs` 와 그 의존부는 은퇴 대상으로 두고 별도 작업으로 제거한다. 프로그램적 제어가 필요한 경로는 이미 있는 app-server 워커로 옮긴다.

## 검토한 대안 (Considered Options)
- **A안: exec 전송 + 최종 메시지 파일 (채택)**: 공식 플래그만 쓰고 기존 사람이 읽는 추적 출력과 tmux 관전을 그대로 둔다. 단점은 진행 중 이벤트를 구조화해 받지 못한다는 점이다.
- **B안: MCP 워커를 app-server 로 즉시 이식해 auto 의 1순위로**: 구조화된 이벤트와 세션 제어를 얻는다. app-server 워커는 승인 정책 never 만 지원하고, 라우터와 워커 팩토리, 테스트 여섯 묶음을 함께 바꿔야 해 검증 범위가 크다. 후속 작업으로 둔다.
- **C안: rollout jsonl 에서 마지막 assistant 메시지를 추출**: 플래그 추가 없이 된다. 세션 파일 형식은 공식 계약이 아니라 버전마다 깨질 수 있다.
- **D안: `--json` 이벤트 스트림을 파싱**: 공식 출력이다. stdout 이 NDJSON 으로 바뀌어 tee 관전과 기존 추적 기반 진단이 읽기 어려워진다.

## 결과 (Consequences)
긍정: 호출자가 `=== OUTPUT ===` 만 읽으면 최종 답을 얻는다. 빈 결과가 성공으로 읽히지 않는다. 디스패치마다 발생하던 실패 워커 기동이 사라지고 정상 실행은 success 로 끝난다.

부정과 리스크: `TFX_CODEX_TRANSPORT=mcp` 를 명시하던 호출은 동작이 exec 로 바뀐다. 업스트림에 MCP 서버가 없어 기존에도 폴백으로 끝났으므로 실질 차이는 안내 문구뿐이다. MCP 워커 코드와 테스트가 은퇴 전까지 죽은 경로로 남는다.

후속: MCP 워커, 위임 워커의 의존, 워커 팩토리 기본값, 관련 테스트의 은퇴. 되돌릴 조건: 업스트림이 MCP 서버를 되살리거나 app-server 가 exec 를 대체할 만큼 안정되면 새 번호 ADR 로 다시 정한다. 구현은 PR #503.
