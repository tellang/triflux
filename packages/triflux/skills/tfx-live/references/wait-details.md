# wait 완료 판정 상세

`wait`는 Claude transcript에서 표식을 user 메시지, `queue-operation`의 `enqueue` content, queued command attachment에서 찾는다. 표식이 소비된 턴이 끝난 뒤 마지막 assistant 텍스트를 응답으로 쓴다. 표식 없는 `wait`는 최신 user turn을 본다. `isSidechain`과 합성 API 오류 메시지는 정상 응답에서 제외한다. 요청을 소비한 턴에서 합성 오류가 나타나면 오류 문구와 `status: "failed"`를 반환한다. daemon의 `idle`만으로 완료를 단정하지 않는다. timeout은 `status: "working"`, `timedOut: true`, `done: false`다.

tmux로 띄운 대화형 Claude는 `wait --session <tmux 대상>`을 쓴다. pane에 붙은 Claude 세션 기록(`~/.claude/sessions`)에서 sessionId를 찾아 같은 transcript 규칙으로 판정하고, daemon의 idle 대신 세션 기록의 `status: "idle"`을 쓴다. transcript는 처음 찾은 것을 끝까지 쓰므로 대기 중 `/clear`로 바뀐 세션은 따라가지 않는다. 로컬 전용이다.

Codex `wait`는 `--session` 또는 `--thread UUID`의 rollout에서 표식이 든 user 메시지의 `turn_id`를 찾고, 같은 턴의 `task_complete.last_agent_message`를 응답으로 쓴다. `turn_aborted`는 `status: "failed"`다. 표식이 아직 없으면 `status: "queued"`, `timedOut: true`다. `--timeout 0`은 한 번만 확인한다.

명시한 `--config-dir`은 정확히 일치하는 daemon만 선택한다. `CLAUDE_CONFIG_DIR`도 해당 env 디렉터리로 제한한다. stale endpoint 복구는 같은 source configDir 안에서만 재시도한다. attach 전 예외는 `inputSent: false`이므로 `auto`의 tmux fallback이 가능하다. attach 뒤 전송 여부가 불명확하면 `status: "unknown"`으로 보고하고 재전송하지 않는다.
