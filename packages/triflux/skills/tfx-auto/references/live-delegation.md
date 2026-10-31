# Live 위임 계약

`--mode live`는 Codex 분류/Claude 분해 트리아지를 건너뛰고 `tfx-live peer`(Claude↔Codex 실시간 세션 릴레이)로 직접 위임한다. **독립 엔진 위임**이며 `tfx-live`를 병합·재구현하지 않는다. `--parallel N`은 `tfx multi`를 위임한다.

v1은 `peer` 단일 경로만 지원한다. `--live-shape`, `--live-mode`, `tfx-auto`의 `orchestrate` 위임은 v2 예정이며 현재 파서·실행 계약에는 없다.

**적용 대상**: 서브태스크로 쪼갤 수 없는 왕복 대화형 작업(설계 논쟁, 경쟁 가설 조율, 두 모델이 서로 반박하며 수렴해야 하는 케이스). 독립적으로 병렬 처리 가능한 작업, 또는 가벼운 반박 1라운드면 `--mode consensus --shape debate`(배치형, 리드 중개, ≤2라운드, per-round 재시작 오버헤드 있음)가 더 저렴하다. `live`는 리드 중개 없이 세션이 직접 이어받으며 세션 상태를 유지해야 하는 경우에만 쓴다.

**tfx-auto의 배치 모델과 근본적으로 다른 지점**: 나머지 모든 모드(quick/deep/consensus)는 "분해 → dispatch → 결과 수집"의 stateless 배치 잡이다. `live`는 `tfx-live`가 관리하는 장수명 세션(daemon UDS attach 또는 지속 tmux 세션)에 얹혀가므로, verify/fix loop 같은 배치형 계약이 적용되지 않는다.

디스패치:

```bash
# Bash(run_in_background=true). {task_file} 은 Write 도구로 쓴 입력 파일이다(아래 "실행" 절 참조).
tfx-live peer --cli-a codex --cli-b claude \
  --session-a {sid}-a --session-b {sid}-b \
  --cwd {cwd} --mode freeform --seed "$(cat {task_file})" \
  --rounds {rounds} --timeout {timeout}
```

**Closure**: `rounds * 2` hop 예산을 늘리지 않고 마지막 B(`--cli-b`) hop을 closure turn으로 대체한다. B는 `agreement_status`, `unresolved_questions`, `needs_more_rounds`를 포함한 구조화 선언을 반환해야 한다.

**상태 판정**: harness가 B의 자기선언과 독립적으로 판정한다. closure가 구조화되어 있고 `unresolved_questions=[]`, `needs_more_rounds=false`, `agreement_status=complete`일 때만 `status=complete`다. 검증·저장된 성공 hop이 1개 이상이면 그 외에는 `partial`, 0개면 `failed`다. timeout/transport 오류도 성공 hop이 있으면 `partial`이며 원인은 `exit_reason=timeout|transport_error`로 따로 남긴다.

**중단과 세션 정리**: SIGINT/SIGTERM은 transcript 수와 무관하게 `status=aborted`로 분리하고 `hops_completed`, `exit_reason=user_interrupt|terminated`를 남긴다. 첫 신호 뒤 3초 안에 transcript flush → status 기록 → session stop을 시도한다. stop이 3초를 넘기면 orphan tmux 세션은 허용하지만 transcript/status 파일은 보존한다. 두 번째 신호는 graceful 경로를 포기하고 즉시 종료한다.

**보고**: 배치 모드의 `=== OUTPUT ===` 대신 `tfx-live peer` JSON의 `status`, `exit_reason`, `hops_completed`, `transcript_path`, `status_path`를 위 규칙대로 해석하고 transcript를 요약한다.
