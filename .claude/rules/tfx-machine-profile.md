---
paths:
  - "scripts/setup.mjs"
  - "scripts/tfx-route.sh"
  - "scripts/lib/machine-profile.mjs"
  - "hub/team/**/*"
  - "tests/**/*machine-profile*"
---
# Triflux machine profile

`scripts/setup.mjs`는 최초 설치 또는 명시적 재설정 시 머신 단위 라우팅/수명주기
정책을 캡처한다. 이 파일은 설치 여부를 기록하는 inventory가 아니라, 이 머신에서
사용자가 어떤 CLI와 timeout 정책을 **허용했는지** 기록하는 정책이다.

## 위치와 신뢰 경계

| OS | 기본 경로 |
| --- | --- |
| darwin / linux | `${XDG_CONFIG_HOME:-$HOME/.config}/triflux/machine-profile.env` |
| win32 | `%APPDATA%\triflux\machine-profile.env` |

`TFX_MACHINE_PROFILE_PATH`로 경로만 명시 override할 수 있다. 파일은 임시 `0600`
파일을 쓴 뒤 rename하는 방식으로 원자 저장한다. 대상 교체 rename을 OS가 거부하면
기존 프로파일을 삭제하지 않고 명시적으로 실패한다. 형식은 Bash/Node가 공통으로 읽을 수 있는 `KEY=VALUE`지만,
`tfx-route.sh`는 이 파일을 `source`/`eval`하지 않는다. 고정 allowlist와
`[A-Za-z0-9_.-]+` literal만 읽으므로 셸 표현식은 실행되지 않는다.

```dotenv
TFX_MACHINE_PROFILE_VERSION=1
TFX_MACHINE_OS=darwin
TFX_MULTIPLEXER_POLICY=tmux
TFX_DISABLE_CODEX=0
TFX_DISABLE_ANTIGRAVITY=1
TFX_DISABLE_CLAUDE=0
TFX_TIMEOUT_POLICY=visible
TFX_HARD_CEILING_SEC=0
TFX_STALL_THRESHOLD=1200
TFX_STALL_KILL=classify
```

OS 파생 multiplexer 정책은 `darwin|linux -> tmux`, `win32 -> psmux`다.
non-Windows의 `auto` 모드는 psmux 감지를 무시하고, 명시적 `psmux`는 오류로 처리한다.
WT 팀 모드와 in-process 모드는 지원하지 않는다. 대화형 실행에 멀티플렉서가 없으면
설치 안내 오류로 끝낸다. headless도 tmux/psmux 방에서 돌기 때문에 멀티플렉서가 필요하다.

## 설치 캡처

TTY에서 `node scripts/setup.mjs --machine-profile-only`를 실행하면 다음을 확인한다.

1. Codex 사용 여부 (binary 자동감지값을 기본으로 제시)
2. Antigravity 사용 여부 (`agy|antigravity` 자동감지값을 기본으로 제시)
3. Claude 외부 워커 사용 여부 (`claude` 자동감지값을 기본으로 제시)
4. hard ceiling 초 (`0`은 비활성)
5. stall threshold 초
6. stall 동작 (`kill|classify|intervene`)

현재 tmux 안의 interactive setup은 visible 권장값인 `hard ceiling=0`,
`stall=classify`를 기본으로 제시한다. 확인 없는 postinstall, CI, pipe 등
non-interactive 경로는 멈추지 않고 binary 자동감지와 unattended-safe 값
`21600 / 1200 / kill`을 저장한다. 자동감지를 고정하려면 다음 setup 전용 env를 쓴다.

```bash
TFX_SETUP_USE_CODEX=1 \
TFX_SETUP_USE_ANTIGRAVITY=0 \
TFX_SETUP_USE_CLAUDE=1 \
TFX_SETUP_HARD_CEILING_SEC=21600 \
TFX_SETUP_STALL_THRESHOLD=1200 \
TFX_SETUP_STALL_KILL=kill \
node scripts/setup.mjs --machine-profile-only --non-interactive
```

기존 파일을 다시 묻고 덮어쓰려면 `--machine-profile` 또는
`--machine-profile-only`를 쓴다. 일반 setup은 프로파일이 이미 있으면 보존한다.

## 우선순위와 hard routing

| 우선순위 | 층 | 의미 |
| ---: | --- | --- |
| 1 | 명시 runtime env (`TFX_DISABLE_CODEX`, `TFX_DISABLE_ANTIGRAVITY`, `TFX_DISABLE_CLAUDE`, `TFX_ANTIGRAVITY_FALLBACK`, `TFX_HARD_CEILING_SEC`, `TFX_STALL_*`) | 이번 실행의 최종 사용자 override |
| 2 | 영속 machine profile | 설치 시 확인한 머신 정책 |
| 3 | preflight 및 쿼터 스냅샷 (`TFX_CODEX_OK`, `TFX_ANTIGRAVITY_OK`, `TFX_CLAUDE_OK`, 사용량 `>=100%`, 쿨다운 마커) | 현재 가용성 확인; 비가용 CLI는 binary가 있어도 후보에서 제외되며 금지 권한도 되살릴 수 없음 |
| 4 | built-in default | 프로파일 미설정 시 기본값 |

`TFX_CLI_MODE`는 명시 강제 선택이고 `TFX_*_OK`는 확인값이라는 구분을 유지한다.
역할별 후보 선정(`scripts/lib/vendor-priority-policy.mjs`)과 실행 시 전환은 다음 순서다.

1. 명시 `TFX_CLI_MODE`(`codex|antigravity|claude`)가 있으면 해당 벤더 후보만 남기고, 금지됐거나 미가용이면 `exit 78`로 실패한다.
2. 자동 모드(`auto`)는 역할군별 3사 후보 배열에서 금지(`TFX_DISABLE_*=1`), 바이너리 미설치(`TFX_*_OK=0`), 쿼터 `>=100%`, 쿨다운 마커 미경과 벤더를 제외한다.
3. 사용률이 `95%`를 초과(`>95%`)한 벤더 후보는 배열 우측부터 역순으로 1칸씩만 후순위로 내린다.
4. 허용되고 가용한 다음 후보로 전환할 때 stderr에 이유와 대상을 출력하고, 모든 외부 CLI 후보가 소진되면 `exit 78`로 실패한다. 가용성 실패를 호스트 세션의 `claude-native`로 조용히 강등하지 않는다.
5. 런타임 쿼터 또는 429 한도 초과 오류는 방문한 벤더를 제외하며 남은 후보 체인을 따라 다단계 `auto_reroute`를 수행한다. 인증 실패(`401`/`403`), 컨텍스트 길이 초과, 안전 정책 거부는 다른 벤더로 전환하지 않고 즉시 실패한다.

`TFX_ANTIGRAVITY_FALLBACK=codex|claude`를 명시하면 Antigravity가 1순위였다가 제외된 역할에서 대체 1순위 벤더 순서를 우선 정렬한다. 잘못된 값은 오류로 끝낸다. 이 설정은 `code-reviewer`와 `quality-reviewer`의 작성 벤더별 교차 리뷰 후보에는 적용하지 않는다.

벤더별 런타임 쿼터 및 429 오류는 `$TFX_TMP/tfx-quota-reset-<cli>`(Antigravity는 기존 `$TFX_TMP/tfx-agy-quota-reset` 병행)에 리셋 시각을 epoch 초로 원자 기록한다.
`Resets in <h>h<m>m<s>s` 또는 초 단위를 읽지 못하면 1시간 뒤로 잡는다. 오류와 Error ID만 출력한 `exit 0`도 실패로 처리한다. 리셋 시각 전에는 해당 벤더를 후보에서 제외하고 다음 가용 후보로 전환하며, 리셋 뒤에는 마커를 무시하고 다시 허용하되 명시적으로 저장한 `TFX_DISABLE_*=1`은 그대로 존중한다.

호스트 리드가 직접 위임하는 `claude-native` 전용 경로(`explore` 등)와 transport 내부의 `Codex MCP -> Codex exec` 전환은 외부 CLI 가용성 폴백과 독립적이다.

## Timeout 정책

| 상태 | tmux 경로 | headless 경로 |
| --- | --- | --- |
| 프로파일 미설정 | 6h hard ceiling, 1200s stall kill | 동일 |
| non-interactive `unattended` 프로파일 | 6h hard ceiling, 1200s stall kill | 동일 |
| interactive `visible` 프로파일 | hard ceiling 없음, stall classify-only | **동일: 자동 kill 없음** |
| custom 프로파일 | 저장한 값 | 저장한 값 |

가시성 자동 분기는 사용하지 않는다. `teammateMode`가 `tfx-route.sh`까지 안정적으로
전달되지 않고, headless 자식이 부모의 `TMUX`를 상속할 수 있어 `TMUX`만으로는
사람이 보고 있는지 판별할 수 없기 때문이다. 따라서 visible 프로파일은 머신 전체
정책이며, 그 상태에서 headless/CI/원격 워커를 실행하면 hard ceiling과 stall kill
없이 무제한 실행될 수 있다.

`TFX_HARD_CEILING_SEC=0`은 outer coreutils timeout을 제거한다. Codex는 내부 MCP
timeout과 의미가 충돌하지 않도록 exec transport를 사용한다. 양수 hard ceiling인데
`timeout|gtimeout`이 없으면 setup이 경고한다. macOS의 일반 복구 명령은
`brew install coreutils`이며, 설치 후에는 `gtimeout`이 사용된다.

`tfx-live ask --timeout`은 폴링 루프 종료 조건이라 이 프로파일 대상이 아니며 유지한다.
