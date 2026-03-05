---
name: tfx-setup
description: triflux 초기 설정 및 진단을 수행합니다.
triggers:
  - tfx-setup
argument-hint: "[doctor]"
---

# tfx-setup — triflux 초기 설정 및 진단

> 설치 후 최초 1회 실행 권장. HUD 설정, CLI 확인, 전체 진단을 수행합니다.

## 사용법

```
/tfx-setup
/tfx-setup doctor    ← 진단만 실행
```

## 동작

### 기본 모드 (`/tfx-setup`)

1. **파일 동기화** — `triflux setup` 실행
2. **HUD 설정** — `settings.json`에 statusLine 자동 등록
3. **CLI 진단** — `triflux doctor` 실행
4. **결과 보고** — 설정 상태 요약

### 진단 모드 (`/tfx-setup doctor`)

`triflux doctor`만 실행하고 결과를 보고합니다.

## 실행 방법

### Step 1: 파일 동기화

```bash
Bash("triflux setup")
```

### Step 2: HUD 설정 확인 및 적용

`~/.claude/settings.json`을 읽어 `statusLine` 설정을 확인합니다.

**statusLine이 없거나 hud-qos-status.mjs를 가리키지 않는 경우:**

```javascript
// settings.json에 추가할 statusLine 설정
{
  "statusLine": {
    "type": "command",
    "command": "\"<NODE_PATH>\" \"<HOME>/.claude/hud/hud-qos-status.mjs\""
  }
}
```

- `<NODE_PATH>`: `node -e "console.log(process.execPath)"` 결과
- `<HOME>`: `~` 또는 홈 디렉토리 절대 경로
- Windows: 경로에 공백이 있으면 큰따옴표로 감싸기
- **기존 statusLine이 있으면 덮어쓰기 전 사용자에게 확인**

Read 도구로 `~/.claude/settings.json`을 읽고, Edit 도구로 statusLine을 추가/수정합니다.

### Step 3: CLI 진단

```bash
Bash("triflux doctor")
```

### Step 4: 결과 보고

```markdown
## tfx-setup 완료

| 항목 | 상태 |
|------|------|
| cli-route.sh | ✅ v1.5 |
| HUD (hud-qos-status.mjs) | ✅ v1.7 |
| HUD 설정 (settings.json) | ✅ statusLine 등록됨 |
| Codex CLI | ✅ / ⚠️ 미설치 (선택) |
| Gemini CLI | ✅ / ⚠️ 미설치 (선택) |
| 스킬 | ✅ N개 설치됨 |

### 다음 단계
- Codex 미설치 시: `npm install -g @openai/codex`
- Gemini 미설치 시: `npm install -g @google/gemini-cli`
- 세션 재시작하면 HUD가 표시됩니다
```

## 에러 처리

| 상황 | 처리 |
|------|------|
| `triflux: command not found` | `npm install -g triflux` 안내 |
| `settings.json` 파싱 실패 | 백업 생성 후 새로 작성 |
| 기존 statusLine이 다른 HUD | 사용자에게 덮어쓸지 확인 |
| node.exe 경로에 공백 | 큰따옴표로 감싸기 |
