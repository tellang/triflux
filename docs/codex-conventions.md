# Codex CLI 실행 관례

Triflux에서 Codex 작업은 `tfx-auto --cli codex` 또는 `tfx-route.sh`를 경유한다. 실행 정책의 정본은 [tfx-psmux 규칙 4](../.claude/rules/tfx-psmux.md)다.

## 프롬프트와 프로필

`tfx-route.sh`는 Codex 프롬프트를 `--` 뒤의 단일 인자로 전달하고 표준 입력을 닫는다. 모델과 추론 수준은 프로필 설정에서 가져온다.

래퍼 내부의 인자 형태는 `codex exec --profile <profile> -- "$prompt" < /dev/null`이다. 실제 작업은 다음과 같이 요청한다.

```bash
bash ~/.claude/scripts/tfx-route.sh executor "$prompt" implement < /dev/null
```

`codex < prompt.md`는 비대화식 실행에서 사용할 수 없다. `--full-auto`는 제거된 플래그다. `approval_policy`와 `sandbox_mode`의 기본값은 `config.toml`에 둔다.

Antigravity CLI의 `--print`는 프롬프트 값을 받는다. `tfx-route.sh`의 `run_antigravity_exec`는 옵션을 조립한 뒤 `--print "$prompt"`를 마지막에 붙인다.

## 작업 문서

작업 계획에는 대상 경로, 완료 조건, 필요한 검증 명령을 구체적으로 적는다. [PRD 템플릿](prd/_template.md)과 [브랜치 정책](process/branch-policy.md)을 따른다.

## Windows 세션

Windows Terminal과 psmux 세션의 생성 및 정리는 [tfx-psmux 규칙](../.claude/rules/tfx-psmux.md)이 정본이다. macOS와 Linux의 tmux 경로에는 Windows 규칙을 적용하지 않는다.

## 병렬 작업

코드 변경 작업은 각각의 worktree와 세션에서 수행한다. 작업을 이어가기 전에 현재 디렉터리와 `git status --short --branch`를 확인한다. 테스트 락과 세션 정리는 소유 세션의 상태를 확인한 뒤 처리한다.

## MCP 승인 문제

Codex의 MCP 도구 호출이 대기 상태에 머무는 경우에는 [문제 해결 기록](troubleshooting/issue-66-codex-mcp-approval.md)의 진단 절차를 따른다.
