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
필수: `codex53_high`, `codex53_xhigh`, `spark53_low`.

- 모두 존재 → ✅ 표시
- 누락 있으면 → AskUserQuestion:
  ```
  question: "누락된 Codex 프로파일 N개를 생성하시겠습니까?"
  header: "Profiles"
  options:
    - label: "생성 (Recommended)"
      description: "누락된 프로파일을 config.toml에 추가"
    - label: "건너뛰기"
      description: "나중에 /tfx-profile로 관리"
  ```

#### 단계 3.5: Gemini 프로필

`~/.gemini/triflux-profiles.json` 존재 여부 확인.
필수 프로필: `pro31`, `flash3`.

- 파일 존재 + 필수 프로필 있음 → ✅ 표시
- 파일 미존재 → 기본 프로필 5개 자동 생성 (pro31, flash3, pro25, flash25, lite25)
- 누락 있으면 → AskUserQuestion:
  ```
  question: "누락된 Gemini 프로필을 생성하시겠습니까?"
  header: "Gemini Profiles"
  options:
    - label: "생성 (Recommended)"
      description: "누락된 프로필을 triflux-profiles.json에 추가"
    - label: "건너뛰기"
      description: "나중에 /tfx-profile --gemini로 관리"
  ```

#### 단계 4: CLI 진단

`triflux doctor --json`을 Bash로 실행하여 CLI 존재 여부 확인.
결과를 테이블로 표시.

#### 단계 5: MCP 서버 설정 위저드

> MCP 서버를 선택적으로 활성화한다. API 키 없는 서버는 건너뛸 수 있다.
> 선택 결과는 `~/.claude/cache/mcp-enabled.json` 매니페스트에 저장된다.
> 이후 gateway-start, gateway-config, mcp-filter 모두 이 매니페스트를 참조한다.

##### 5-1: 기존 매니페스트 확인

Read 도구로 `~/.claude/cache/mcp-enabled.json` 읽기 시도.
- 존재하면 → 현재 설정 표시 후 AskUserQuestion:
  ```
  question: "MCP 서버 설정을 변경하시겠습니까?"
  header: "MCP"
  options:
    - label: "현재 설정 유지"
      description: "활성: {현재 enabled 목록}"
    - label: "다시 설정"
      description: "서버를 다시 선택"
  ```
  "현재 설정 유지" 선택 시 → Step 5 완료, 다음 단계로.

##### 5-2: Core 서버 안내

Core 서버(context7, serena)는 API 키 불필요, 자동 활성화됨을 표시:
```
✅ context7 — 라이브러리 문서 조회 (API 키 불필요)
✅ serena   — 시맨틱 코드 분석 (API 키 불필요)
```

##### 5-3: 검색 MCP 선택

AskUserQuestion(multiSelect):
```
question: "어떤 검색 MCP를 활성화하시겠습니까? (API 키 필요)"
header: "검색 MCP"
multiSelect: true
options:
  - label: "brave-search"
    description: "Brave 웹/뉴스 검색 (BRAVE_API_KEY 필요)"
  - label: "exa"
    description: "코드/리포/학술 검색 (EXA_API_KEY 필요)"
  - label: "tavily"
    description: "리서치/팩트체크 검색 (TAVILY_API_KEY 필요)"
  - label: "없음"
    description: "검색 MCP 사용 안 함 (context7만 사용)"
```

선택된 서버마다 환경변수 존재 여부를 `process.env`로 확인:
- 환경변수 있음 → ✅ 표시
- 환경변수 없음 → ⚠️ 경고 + 안내:
  ```
  ⚠️ exa: EXA_API_KEY가 설정되지 않았습니다.
     → 환경변수를 설정한 뒤 세션을 재시작하면 활성화됩니다.
     → 매니페스트에는 활성으로 기록합니다 (키 추가 후 바로 사용 가능).
  ```

##### 5-4: 통합 MCP 선택

AskUserQuestion(multiSelect):
```
question: "어떤 통합 MCP를 활성화하시겠습니까?"
header: "통합 MCP"
multiSelect: true
options:
  - label: "jira"
    description: "Jira 이슈/스프린트 관리 (JIRA_API_TOKEN + EMAIL + URL 필요)"
  - label: "notion"
    description: "Notion 페이지 관리 (NOTION_TOKEN 필요)"
  - label: "없음"
    description: "통합 MCP 사용 안 함"
```

notion 선택 시 notion-guest도 함께 활성화.
환경변수 체크는 5-3과 동일 패턴.

##### 5-5: 매니페스트 저장

선택된 서버 목록을 수집하여 Bash 도구로 저장:
```bash
node -e "
  import { writeManifest } from './scripts/lib/mcp-manifest.mjs';
  writeManifest(['brave-search', 'exa']);  // 예시: 선택된 서버
  console.log('Manifest saved');
"
```

또는 Write 도구로 직접 `~/.claude/cache/mcp-enabled.json` 작성:
```json
{
  "version": 1,
  "updatedAt": "2026-03-31T...",
  "enabled": ["context7", "serena", "brave-search", "exa"]
}
```

##### 5-6: 결과 표시

```
## MCP 서버 설정 완료

| 서버 | 상태 | 비고 |
|------|------|------|
| context7 | ✅ 활성 | Core (항상 활성) |
| serena | ✅ 활성 | Core (항상 활성) |
| brave-search | ✅ 활성 | BRAVE_API_KEY ✅ |
| exa | ⚠️ 활성 | EXA_API_KEY 미설정 — 키 추가 후 사용 가능 |
| tavily | ⏭️ 건너뜀 | 사용자 선택 |
| jira | ⏭️ 건너뜀 | 사용자 선택 |
| notion | ⏭️ 건너뜀 | 사용자 선택 |

💡 나중에 변경: `/tfx-setup` → 단계별 선택 → MCP 설정
```

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
  - label: "Gemini 프로필"
    description: "triflux-profiles.json 생성/확인"
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
