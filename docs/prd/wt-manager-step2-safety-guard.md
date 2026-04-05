# PRD: WT Manager Step 2 — safety-guard wt.exe 직접 호출 차단

## 목표

`hooks/safety-guard.mjs`에 wt.exe 직접 호출 차단 패턴을 추가한다.
에이전트가 wt.exe를 직접 호출하면 차단하고, wt-manager.mjs 경유를 안내한다.

## 참조

기존 safety-guard.mjs의 psmux 관련 차단 패턴(isPsmuxInvocation)을 참고할 것.
현재 safety-guard.mjs 파일을 먼저 읽고 기존 구조를 파악한 후 작업할 것.

## 구현 범위

### 차단 패턴

```javascript
// wt.exe 직접 호출 감지 정규식
const WT_DIRECT_PATTERNS = [
  /\bwt\.exe\b/i,
  /\bwt\s+new-tab\b/i,
  /\bwt\s+split-pane\b/i,
  /\bwt\s+-w\b/i,
  /\bStart-Process\s+wt/i,
  /\bStart-Process\s+['"]?wt\.exe/i,
];
```

### 차단 동작

1. 명령에서 WT 직접 호출 감지
2. 에러 메시지 출력: `[safety-guard] wt.exe 직접 호출 차단됨. → hub/team/wt-manager.mjs의 createTab() 또는 applyLayout()을 사용하세요.`
3. `process.exit(1)` 또는 hook 차단 반환

### 예외 (오탐 방지)

- `echo`, `grep`, `git commit` 메시지 안의 "wt" 문자열은 차단하지 않음
- heredoc 내용은 차단하지 않음 (기존 isPsmuxInvocation과 동일한 세그먼트 분석)
- `wt-manager.mjs` 자체가 내부적으로 호출하는 wt.exe는 차단하지 않음 (safety-guard는 Claude의 Bash 도구만 차단)

### tfx-psmux-rules 확장

`skills/tfx-psmux-rules/` 디렉토리에 RULE 6을 추가한다:

```markdown
## RULE 6: WT 탭/창은 wt-manager 경유 필수
- `wt.exe new-tab ...` 직접 호출 금지
- `wt.exe split-pane ...` 직접 호출 금지
- `Start-Process wt.exe ...` PowerShell 호출 금지
- 반드시 wt-manager.mjs의 createTab() / applyLayout() 사용
```

## 파일

- 수정: `hooks/safety-guard.mjs` (기존 파일에 패턴 추가)
- 수정: psmux-rules 스킬 파일 (RULE 6 추가)

## 테스트

- `tests/unit/safety-guard-wt.test.mjs` 생성
- wt.exe 직접 호출 차단 테스트
- Start-Process wt 차단 테스트
- echo/grep 내 "wt" 오탐 방지 테스트
- git commit 메시지 내 "wt" 오탐 방지 테스트

## 커밋

작업 완료 후 반드시 `git add` + `git commit` 할 것. 커밋 메시지 형식:
```
feat: safety-guard wt.exe 직접 호출 차단 — RULE 6 추가
```
