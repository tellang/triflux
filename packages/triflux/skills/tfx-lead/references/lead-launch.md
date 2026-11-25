# 셸에서 리드 띄우기 상세

- 실행 명령은 `--launcher`, `~/.config/triflux/lead.json`(Windows 는 `%APPDATA%\triflux\lead.json`)의 `launchers.<cli>`, CLI 이름 순으로 고른다. 예: `{"launchers": {"claude": "<래퍼> launch", "codex": "codex"}}`. triflux 는 CLI 이름 자리만 이 값으로 바꿔 실행할 뿐 특정 도구에 의존하지 않는다.
- `tfx setup`과 `tfx update`가 대화형으로 돌 때, 설치된 CLI 중 아직 정하지 않은 것의 실행 명령을 한 번 묻는다. 물을 수 없으면 다음 대화형 실행으로 미룬다.
- 이 설정은 리드에만 쓴다. 워커는 `tfx-live start`가 기본 명령으로 띄운다.
- Codex 리드도 관리 TUI의 `--dangerously-bypass-hook-trust` 기본값을 따른다. `tfx lead <역할> --cli codex --no-bypass-hook-trust`는 live까지 opt-out을 전달하고, `TFX_CODEX_BYPASS_HOOK_TRUST=0`으로도 끈다. CLI opt-out이 우선하며 invocation에만 적용한다. 활성 훅은 사전 확인 없이 샌드박스 밖에서 실행될 수 있다. shared daemon prepared-thread attach에는 관리 플래그를 제외하며 CLI 수락을 daemon 적용 증거로 보지 않는다. 훅 검토는 `ready: false`, `blockedBy: "codex-hooks-review"`로 멈추므로 attach해 직접 검토하고, ready 전에는 리드 지시를 보내지 않는다. 전역 config·신뢰 기록과 사용자 launcher 내부는 바꾸지 않는다.
- tmux 안에서 pane 을 다시 띄우는(`respawn-pane`) 래퍼는 pane 의 셸을 없앤다. 그러면 리드가 끝날 때 pane 도 닫히고, 같은 pane 에서 `--resume`으로 이어 쓸 수 없다.

- `--json`의 `routing`에서 권고, effective 모델과 effort, 보존/폴백 이유를 확인한다. `appliedTo: start_args`는 시작 인자 선택이며 세션 ready나 실제 모델 수신 증거는 아니다. 프로필을 찾으려고 config를 추측 검색하지 않는다.
