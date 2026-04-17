# Codex CLI 실행 컨벤션

> triflux에서 Codex CLI를 사용할 때 반드시 준수해야 하는 규칙.
> tfx-codex-swarm, tfx-auto-codex, tfx-route.sh 모두 이 규칙을 따른다.

## 1. 실행 방식

### 금지 패턴 (stdin redirect)
```bash
# WRONG — "stdin is not a terminal" 에러
codex < prompt.md
codex --profile X < prompt.md
cat prompt.md | codex
Get-Content prompt.md -Raw | codex
```

### 올바른 패턴 (인자 전달)
```bash
# codex exec — one-shot, config.toml 무시
PROMPT="$(cat prompt.md)"
codex exec "$PROMPT" --dangerously-bypass-approvals-and-sandbox

# tfx-route.sh 경유 — MCP/타임아웃 통합
~/.claude/scripts/tfx-route.sh executor "$(cat prompt.md)" "{profile}" 900
```

## 2. config.toml 규칙

| 상황 | 규칙 |
|------|------|
| interactive `codex` | config.toml `approval_mode` 존중 |
| `codex exec` | config.toml 무시 → `--dangerously-bypass-approvals-and-sandbox` 필수 |
| `--full-auto` 플래그 | 사용 금지. config.toml `sandbox`와 충돌 |
| `--profile` | interactive + `codex exec` 모두 지원 (codex 0.121.0 기준, `-p, --profile <CONFIG_PROFILE>`). `tfx-route.sh` 가 실제로 `exec --profile` 사용 중 |

## 3. PRD 작성 규칙

- **완료 조건에 git commit 필수**: codex는 명시적 지시 없이 자동 커밋하지 않음
- **테스트 명령 구체적으로**: `npm test`가 아닌 `node --test tests/unit/specific.test.mjs`
- **파일 경로 명시**: codex가 올바른 파일을 찾을 수 있도록 상대 경로 기재
- 템플릿: `docs/prd/_template.md`

## 4. psmux 세션 관리

### 생성
```bash
psmux new-session -s "codex-swarm-{id}" -d
BASH_WIN='C:\\Program Files\\Git\\bin\\bash.exe'
psmux send-keys -t "codex-swarm-{id}" \
  "& '${BASH_WIN}' '${LAUNCH_DIR}\\launch-{id}.sh'" Enter
```

### 정리 (WT 프리징 방지)
```bash
# 1. exit 전송 → 셸 종료
psmux send-keys -t "$s" "exit" Enter
# 2. WT pane 자동 닫힘 대기 (최소 5초)
sleep 5
# 3. 잔여 세션만 kill (pane 닫힌 후)
psmux kill-session -t "$s" 2>/dev/null
```

**절대 금지**: WT pane이 attach된 상태에서 `psmux kill-session` 직접 실행
→ WT ConPTY 레이스 → 프리징 (microsoft/terminal#17871)

`psmux detach-client`는 3.3.x에서 미지원. exit + 대기가 유일한 안전 경로.

## 5. 병렬 실행 제약

- test-lock: `.test-lock/pid.lock` — 동일 worktree에서 테스트 동시 실행 불가
- codex가 테스트 실행 후 lock 잔류 가능 → 수동 `rm .test-lock/pid.lock`
- 3+ worktree 병렬 테스트는 순차 실행 권장

## 6. Worktree 규칙

| 항목 | 규칙 |
|------|------|
| 경로 | `.codex-swarm/wt-{slug}` |
| 브랜치 | `codex/{slug}` |
| 정리 | 머지 완료 후 `git worktree remove` + `git worktree prune` |
| 충돌 | 브랜치 존재 시 재사용, 경로 존재 시 `-v{timestamp}` suffix |

## 4. MCP tool approval

- **증상**: `codex exec`가 시작된 뒤 끝나지 않고 멈춘다. 특히 MCP tool 호출이 필요한 프롬프트에서 무응답 stall로 보인다.
- **원인**: oh-my-codex 업데이트/재설치 후 `~/.codex/config.toml`의 `[mcp_servers.*.tools.*]` 블록이 `approval_mode = "approve"`로 복원될 수 있다. top-level `approval_mode`와 별개로, 이 per-tool 승인 대기는 `codex exec` subprocess에서 interactive approval을 기다리며 멈출 수 있다.
- **워크어라운드**:
  - 권장: 해당 MCP tool 블록의 `approval_mode`를 `auto`로 되돌린다.
  - 즉시 우회: `codex exec ... --dangerously-bypass-approvals-and-sandbox`
- **참고**: 자세한 재현, 검증, 복구 절차는 `docs/troubleshooting/issue-66-codex-mcp-approval.md` 참고.
