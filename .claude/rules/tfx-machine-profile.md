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
TFX_TIMEOUT_POLICY=visible
TFX_HARD_CEILING_SEC=0
TFX_STALL_THRESHOLD=1200
TFX_STALL_KILL=classify
```

OS 파생 multiplexer 정책은 `darwin|linux → tmux`, `win32 → psmux`다.
non-Windows의 `auto` 모드는 psmux 감지를 무시하며, 명시적 `wt|psmux`도
`in-process`로 정규화한다. 따라서 macOS/Linux에서 WT/psmux 경로를 선택하지 않는다.

## 설치 캡처

TTY에서 `node scripts/setup.mjs --machine-profile-only`를 실행하면 다음을 확인한다.

1. Codex 사용 여부 (binary 자동감지값을 기본으로 제시)
2. Antigravity 사용 여부 (`agy|antigravity` 자동감지값을 기본으로 제시)
3. hard ceiling 초 (`0`은 비활성)
4. stall threshold 초
5. stall 동작 (`kill|classify|intervene`)

현재 tmux 안의 interactive setup은 visible 권장값인 `hard ceiling=0`,
`stall=classify`를 기본으로 제시한다. 확인 없는 postinstall, CI, pipe 등
non-interactive 경로는 멈추지 않고 binary 자동감지와 unattended-safe 값
`21600 / 1200 / kill`을 저장한다. 자동감지를 고정하려면 다음 setup 전용 env를 쓴다.

```bash
TFX_SETUP_USE_CODEX=1 \
TFX_SETUP_USE_ANTIGRAVITY=0 \
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
| 1 | 명시 runtime env (`TFX_DISABLE_*`, `TFX_HARD_CEILING_SEC`, `TFX_STALL_*`) | 이번 실행의 최종 사용자 override |
| 2 | 영속 machine profile | 설치 시 확인한 머신 정책 |
| 3 | preflight (`TFX_CODEX_OK`, `TFX_ANTIGRAVITY_OK`, `TFX_GEMINI_OK`, `TFX_HUB_OK`) | 현재 가용성 관측; `OK=0`인 CLI는 binary가 있어도 선택 불가, 금지 권한도 되살릴 수 없음 |
| 4 | built-in default | 프로파일 미설정 시 기존 호환값 |

`TFX_CLI_MODE`는 선호/강제 선택이고 `TFX_*_OK`는 관측값이라는 기존 구분을
유지한다. 최종 선택은 다음 순서다.

1. 선택 CLI가 금지되지 않았고 가용하면 그대로 실행한다.
2. 금지됐거나 미가용이면, 다른 **허용되고 가용한** 외부 CLI 하나로만 전환하고
   stderr에 이유와 대상을 출력한다.
3. 후보가 없으면 exit 78로 실패한다. availability 실패를 Claude native로
   조용히 강등하지 않는다.
4. quota reroute도 같은 disable/가용성 검사를 통과한 후보만 선택하고, 후보가
   없으면 exit 78로 실패한다.

Claude-native로 설계된 역할과 transport 내부의 `Codex MCP → Codex exec` 전환은
다른 CLI로의 availability fallback이 아니므로 이 정책과 독립적이다.

## Timeout 정책

| 상태 | tmux 경로 | headless / in-process 경로 |
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
