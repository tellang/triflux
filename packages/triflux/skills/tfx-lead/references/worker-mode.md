# 워커 권한 모드 적용

- 요약에는 할 일의 종류만 쓴다. 비밀 값, 고객 이름, 이메일, 사용자 경로를 넣지 않는 것이 1차 방어다. 패턴 차단은 보조 수단이며 모든 표기를 잡지 못한다. 패턴에 맞으면 Jev로 보내지 않고 규칙으로 판정한다. 고객 이름은 패턴으로 식별하지 못하므로 요약에서 뺀다.
- 판정은 권고이고 실행을 바꾸지 않는다. 최종 결정은 리드와 사용자다. `source: rule`이면 단어 목록 기반 폴백이라 신호를 놓칠 수 있으므로 `fallbackReason`과 근거를 읽고 리드가 정한다. `mode`와 `ruleMode`가 다르면 작업 내용을 직접 보고 정한다.
- 근거에 모호하다고 나오면 부정이나 위임으로 외부 변경 신호를 제외한 경우도 포함한다. 작업을 나눠 외부 변경 부분만 bypass로 띄우는 쪽을 먼저 본다.

| 워커 CLI | 적용 방법 |
| --- | --- |
| Claude | bypass는 `tfx-live start --cli claude --launcher "DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude --dangerously-skip-permissions"`로 띄운다. `--launcher` 처리에서 워커용 환경 변수 접두를 제거하므로 launcher에 직접 넣는다 |
| Codex | 로컬 신규 thread는 `tfx-live start --cli codex`가 생성 RPC에 `approvalPolicy: "never"`, `sandbox: "danger-full-access"`를 명시한다. 제한 모드는 `--sandbox`로 `on-request`, `workspace-write`를 지정한다. 시작 결과의 `approvalPolicy`, `sandbox`는 attach 뒤 같은 thread의 daemon 응답이고 `sandbox.type`은 `dangerFullAccess`, `workspaceWrite` 형식이다. `--sandbox` 없는 unloaded resume은 기존 권한을 보존한다. loaded thread는 재개를 거부하므로 기존 TUI의 `/permissions`에서 Full Access를 선택하고 확인한다. `permissionsVerified`는 daemon 설정 일치 여부이며 다음 TUI 턴의 실제 권한 적용 완료를 뜻하지 않는다. 기존 `--remote` 기본 경로는 bypass를 유지한다 |
| agy | bypass는 `tfx-live start --cli agy --launcher "agy --dangerously-skip-permissions"`로 지정한다. 플래그는 `agy --help`에 있고 `tfx-live` 기본 시작은 쓰지 않는다. 대화형 실측은 아직 안 됐다. 관리자 샌드박스 강제는 이 플래그와 별개이고 `BypassSandbox: true`를 쓴다 |
