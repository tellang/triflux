# 네이티브 goal 상세

`--cli`를 생략하면 세션 프로세스에서 추정한다. 로컬 Claude와 Codex만 지원하며 `--remote`와 agy는 거부한다. `--budget`은 Codex set의 daemon 경로에서만 받고 Claude와 tmux 폴백에서는 오류로 거부한다.

Claude는 tmux로 `/goal <조건>`과 `/goal clear`를 보내고 transcript의 마지막 `goal_status`로 상태를 읽는다. 별도 평가자의 완료는 `complete`, 수동 해제는 `none`이며 `judgedBy: "evaluator"`와 평가 이유를 보고한다. transcript를 찾지 못하면 상태는 `null`이고 경고를 남긴다. set/clear 뒤 새 sentinel을 최대 15초 확인하며 없으면 `confirmed: false`와 경고를 반환한다. 이미 해제된 goal의 clear는 입력 없이 `alreadyCleared: true`로 답한다. set은 기본 `--if-busy wait`, clear는 미충족 goal이 턴을 계속 이어 가도 끊을 수 있게 기본 `--if-busy interrupt`다. 평가자가 해제하지 않고 멈춘 goal은 `active`로 남으므로 리드가 `goal clear`로 정리한다.

Codex는 공유 daemon UDS의 `thread/goal/*`를 우선 쓴다. `--codex-socket PATH|default`로 소켓을 고르고 기존 thread 해석 순서와 `--thread UUID`를 따른다. 새 goal은 `origin: "user"`로 clear 후 active set한다. 소켓이 없거나 thread가 미적재면 set/clear는 tmux 슬래시로, status는 `$CODEX_HOME/goals_1.sqlite`의 읽기 전용 조회로 폴백한다. `node:sqlite`를 지원하지 않는 Node에서는 상태를 `null`로 두고 경고한다. 결과에 `transport: "daemon"|"tmux"|"sqlite"`와 폴백 이유를 남긴다. tmux 폴백의 set/clear는 sqlite로 최대 15초 확인하고, 확인하지 못하면 재전송을 막으려고 오류 대신 `confirmed: false`와 경고를 반환한다. Codex의 `judgedBy: "model"`, `complete`는 모델 자기 판정이므로 리드의 교차 검증이 필요하다.

Claude와 Codex는 네이티브 goal을 우선 쓴다. 현재 agy는 네이티브 goal을 지원하지 않는다.
