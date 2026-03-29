---
name: tfx-setup
description: >
  triflux 초기 설정 및 진단. AskUserQuestion 기반 인터랙티브 위저드로
  파일 동기화, HUD 설정, Codex 프로파일, CLI 진단, MCP 확인을 수행합니다.
  Use when: setup, 설정, 설치, install, 초기화, 처음, 시작, wizard
triggers:
  - tfx-setup
argument-hint: "[doctor]"
---

# tfx-setup — triflux 초기 설정 위저드

> 설치 후 최초 1회 실행 권장. HUD 설정, CLI 확인, 전체 진단을 수행합니다.

## 워크플로우

### Step 1: 모드 선택 (AskUserQuestion)

```
question: "어떤 설정 모드를 실행하시겠습니까?"
header: "모드"
options:
  - label: "전체 설정 (Recommended)"
    description: "5단계 순서 실행: 동기화 → HUD → 프로파일 → CLI → MCP"
  - label: "단계별 선택"
    description: "필요한 단계만 골라서 실행"
  - label: "현재 상태 확인"
    description: "설정 없이 진단만 수행"
```

`doctor` 인자가 있으면 바로 `triflux doctor` 실행.

### Step 2: 전체 설정 (5단계)

각 단계를 순서대로 실행하며 결과를 보고한다.

#### 단계 1: 파일 동기화

```bash
Bash("triflux setup")
```

스크립트/HUD/스킬을 `~/.claude/`에 배포. 결과 표시.

#### 단계 2: HUD 설정

`~/.claude/settings.json`을 Read 도구로 읽어 `statusLine` 확인.

- statusLine이 이미 `hud-qos-status.mjs`를 가리키면 → ✅ 표시
- statusLine이 없으면 → AskUserQuestion:
  ```
  question: "HUD statusLine을 설정하시겠습니까?"
  header: "HUD"
  options:
    - label: "설정 (Recommended)"
      description: "hud-qos-status.mjs를 statusLine으로 등록"
    - label: "건너뛰기"
      description: "나중에 수동 설정"
  ```
- statusLine이 다른 값이면 → AskUserQuestion:
  ```
  question: "기존 statusLine을 triflux HUD로 교체하시겠습니까?"
  header: "HUD"
  options:
    - label: "교체"
      description: "기존 statusLine을 triflux HUD로 덮어씀"
    - label: "유지"
      description: "현재 statusLine 유지"
  ```

설정 시 Edit 도구로 settings.json 수정:
```json
{
  "statusLine": {
    "type": "command",
    "command": "\"<NODE_PATH>\" \"<HOME>/.claude/hud/hud-qos-status.mjs\""
  }
}
```

#### 단계 3: Codex 프로파일

`~/.codex/config.toml`을 Read 도구로 읽어 필수 프로파일 존재 여부 확인.
필수: `high`, `xhigh`, `spark_fast`.

- 모두 존재 → ✅ 표시
- 누락 있으면 → AskUserQuestion:
  ```
  question: "누락된 Codex 프로파일 N개를 생성하시겠습니까?"
  header: "Profiles"
  options:
    - label: "생성 (Recommended)"
      description: "누락된 프로파일을 config.toml에 추가"
    - label: "건너뛰기"
      description: "나중에 /codex-profile로 관리"
  ```

#### 단계 4: CLI 진단

`triflux doctor --json`을 Bash로 실행하여 CLI 존재 여부 확인.
결과를 테이블로 표시.

#### 단계 5: MCP 서버 확인

`~/.claude/cache/mcp-inventory.json` 존재 여부 + 서버 수 확인.
없으면 재생성 여부를 AskUserQuestion으로 확인.

### Step 3: 단계별 선택

AskUserQuestion(multiSelect):
```
question: "실행할 단계를 선택하세요"
header: "단계"
multiSelect: true
options:
  - label: "파일 동기화"
    description: "스크립트/HUD/스킬 배포"
  - label: "HUD 설정"
    description: "settings.json statusLine 등록"
  - label: "Codex 프로파일"
    description: "필수 프로파일 생성"
  - label: "CLI + MCP 진단"
    description: "CLI 존재 + MCP 인벤토리 확인"
```

선택된 단계만 순서대로 실행.

### Step 4: 결과 요약

```
## tfx-setup 완료

| 항목 | 상태 |
|------|------|
| 파일 동기화 | ✅ |
| HUD 설정 | ✅ statusLine 등록됨 |
| Codex 프로파일 | ✅ 3개 확인 |
| Codex CLI | ✅ |
| Gemini CLI | ⚠ 미설치 (선택) |
| MCP 인벤토리 | ✅ N개 서버 |

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
| 기존 statusLine이 다른 HUD | 교체/유지 AskUserQuestion |
| node.exe 경로에 공백 | 큰따옴표로 감싸기 |

## standalone TUI

터미널에서 직접 실행도 가능: `node tui/setup.mjs` (arrow key 방식)
