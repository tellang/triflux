---
name: tfx-setup
description: >
  triflux 초기 설정 및 진단. AskUserQuestion 기반 인터랙티브 위저드로
  파일 동기화, HUD 설정, Codex 프로파일, CLI 진단, MCP 확인, 검색 MCP 설정을 수행합니다.
  Use when: setup, 설정, 설치, install, 초기화, 처음, 시작, wizard
triggers:
  - tfx-setup
argument-hint: "[doctor]"
---

# tfx-setup — triflux 초기 설정 위저드

> 설치 후 최초 1회 + **매 업데이트 후** 실행 권장.
> `tfx update` 완료 후에도 이 스킬의 단계 1.5(훅 등록 확인)를 반드시 실행하여
> 신규/변경된 훅이 settings.json에 반영되도록 한다.
> 훅 우선순위 관리는 `tfx-hooks` 스킬의 오케스트레이터 패턴을 따른다.

## 워크플로우

### Step 1: 모드 선택 (AskUserQuestion)

```
question: "어떤 설정 모드를 실행하시겠습니까?"
header: "모드"
options:
  - label: "전체 설정 (Recommended)"
    description: "6단계 순서 실행: 동기화 → HUD → 프로파일 → CLI → MCP → 검색 MCP"
  - label: "단계별 선택"
    description: "필요한 단계만 골라서 실행"
  - label: "현재 상태 확인"
    description: "설정 없이 진단만 수행"
```

`doctor` 인자가 있으면 바로 `triflux doctor` 실행.

### Step 2: 전체 설정 (6단계)

각 단계를 순서대로 실행하며 결과를 보고한다.

#### 단계 1: 파일 동기화

```bash
Bash("triflux setup")
```

스크립트/HUD/스킬을 `~/.claude/`에 배포. 결과 표시.

#### 단계 1.5: 훅 등록 확인

`~/.claude/settings.json`을 Read 도구로 읽어 필수 훅이 등록되어 있는지 확인한다.

필수 훅 목록:
| 이벤트 | matcher | 스크립트 | 역할 |
|--------|---------|---------|------|
| PreToolUse | Bash\|Agent | headless-guard-fast.sh | Codex/Gemini 직접 호출 차단 |
| PreToolUse | Bash | psmux-safety-guard.mjs | psmux kill-session 직접 호출 차단 (WT 프리징 방지) |
| PreToolUse | Skill | tfx-gate-activate.mjs | tfx-multi 게이트 |

누락된 훅이 있으면 update-config 스킬로 등록한다. 이미 있으면 ✅ 표시.

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

#### 단계 3.6: Codex MCP Gateway 싱글톤 전환

Codex CLI가 매 호출마다 MCP 서버를 stdio로 spawn하면 좀비 Node.js 프로세스가 생긴다.
gateway SSE 싱글톤을 사용하도록 config.toml을 전환한다.

```bash
node scripts/codex-mcp-gateway-sync.mjs --status
```

- 전부 `sse` → ✅ 이미 전환됨
- `stdio` 또는 `missing` 있으면 → AskUserQuestion:
  ```
  question: "Codex MCP 서버를 gateway 싱글톤(SSE)으로 전환하시겠습니까? 매 호출마다 MCP를 새로 spawn하는 대신, 영속 gateway 데몬을 공유합니다. (좀비 Node.js 방지)"
  header: "MCP Gateway"
  options:
    - label: "전환 (Recommended)"
      description: "stdio → SSE URL 전환. 좀비 프로세스 방지"
    - label: "건너뛰기"
      description: "현재 stdio 방식 유지"
  ```
  "전환" 선택 시:
  1. gateway 데몬이 안 떠 있으면 먼저 기동: `node scripts/mcp-gateway-start.mjs`
  2. config.toml 전환: `node scripts/codex-mcp-gateway-sync.mjs --enable`
  3. 결과 확인: `node scripts/codex-mcp-gateway-sync.mjs --status`

#### 단계 3.7: Codex config.toml 충돌 감지

`~/.codex/config.toml`을 Read 도구로 읽어 `approval_mode`와 `sandbox` 설정을 확인한다.

**충돌 감지 규칙:**
- `approval_mode = "full-auto"` 가 config.toml에 있으면 → CLI에서 `--full-auto` 플래그 중복 사용 금지
- `sandbox = "elevated"` 가 config.toml에 있으면 → CLI에서 sandbox 플래그 중복 사용 금지
- 프로파일별 설정과 기본 설정이 충돌하면 → 경고 표시

결과 표시:
```
## Codex config.toml 분석

| 설정 | 값 | CLI 주의사항 |
|------|-----|-------------|
| approval_mode | full-auto | --full-auto 플래그 생략 필수 |
| sandbox | elevated | sandbox 플래그 생략 필수 |
| model | codex-mini-latest | 프로파일별 오버라이드 가능 |
```

충돌 발견 시 AskUserQuestion:
```
question: "config.toml에 approval_mode=full-auto가 설정되어 있습니다. triflux의 headless 실행에서 CLI 플래그 중복을 방지하려면 이 설정을 유지하는 것이 좋습니다. 현재 설정을 유지할까요?"
header: "Codex Config"
options:
  - label: "유지 (Recommended)"
    description: "config.toml 기본값 사용, CLI 플래그 자동 생략"
  - label: "수정"
    description: "config.toml을 편집하여 직접 조정"
```

**CLAUDE.md 주입 (필수):** 감지된 config.toml 설정을 프로젝트 CLAUDE.md의 `<codex-config>` 섹션에 반영한다.
이렇게 해야 훅(headless-guard, safety-guard)이 명령을 차단했을 때, Claude가 차단 메시지를 읽고 "왜 차단됐는지" + "어떻게 수정해야 하는지"를 CLAUDE.md에서 찾아서 올바르게 재시도할 수 있다.

주입 예시 (Edit 도구로 `<codex-config>` 섹션 업데이트):
```markdown
<codex-config>
## Codex config.toml

config.toml에 이미 설정된 값은 CLI 플래그로 중복 지정하지 않는다.

| config.toml에 있으면 | CLI에서 생략 |
|---------------------|-------------|
| `approval_mode = "full-auto"` | `--full-auto` |
| `sandbox = "elevated"` | `--full-auto` |

안전 패턴: config.toml에 기본값을 두고, CLI에서는 `--profile` 선택만 한다.
</codex-config>
```

차단 → 수정 흐름:
1. headless-guard가 `codex exec --full-auto` 차단
2. 차단 메시지: "config.toml에 approval_mode=full-auto 있으므로 --full-auto 중복"
3. Claude가 CLAUDE.md `<codex-config>` 읽음 → `--full-auto` 제거 후 재실행
4. 동일 실수 반복 방지

#### 단계 3.8: 원격 기기 프로빙 (Swarm Multi-Machine)

`references/hosts.json` 또는 `~/.triflux/hosts.json` 존재 여부 확인.

- 파일 없음 → AskUserQuestion:
  ```
  question: "원격 기기에서 스웜을 실행할 계획이 있나요? (tfx-swarm의 다중 기기 기능)"
  header: "Remote"
  options:
    - label: "네, 원격 설정"
      description: "SSH 호스트를 감지하고 연결 테스트합니다"
    - label: "나중에"
      description: "로컬만 사용. 나중에 /tfx-remote-setup으로 설정"
  ```
  "네" 선택 시 → `/tfx-remote-setup` 스킬 호출하여 호스트 위저드 실행

- 파일 있음 → 등록된 호스트 각각에 대해 SSH 연결 + Claude 설치 프로브:
  ```bash
  ssh -o ConnectTimeout=5 <host> echo ok 2>/dev/null && echo "REACHABLE" || echo "UNREACHABLE"
  ```
  결과 표시:
  ```
  ## 원격 기기 상태

  | 호스트 | SSH | Claude | 스웜 사용 |
  |--------|-----|--------|----------|
  | ryzen5-7600 | ✅ | ✅ v1.0.30 | 가능 |
  | m2 | ✅ | ⚠ 미설치 | 불가 (Claude 설치 필요) |
  | ultra4 | ❌ 연결 실패 | — | 불가 |
  ```

#### 단계 4: CLI 진단

`triflux doctor --json`에는 psmux 설치 여부뿐 아니라 **버전/capability preflight**도 포함된다.
특히 Windows에서는 아래 capability가 모두 있어야 headless 멀티모델 오케스트레이션을 안전하게 쓸 수 있다:

- `new-session`
- `attach-session`
- `kill-session`
- `capture-pane`
- `detach-client` 지원 여부도 함께 확인 (attach/detach hardening 참고)

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

#### 단계 6: 검색 MCP 설정

프로젝트 `.mcp.json`을 Read 도구로 읽어 기존 검색 MCP 서버 확인.
환경변수 파일(`~/projects/.env`, 프로젝트 `.env`)에서 API 키 자동 감지.

감지된 키 상태를 옵션 description에 반영하여 표시 → AskUserQuestion:
```
question: "어떤 검색 MCP 서버를 설정하시겠습니까?"
header: "검색 MCP"
multiSelect: true
options:
  - label: "Exa Web Search"
    description: "시맨틱 검색 + 크롤링 (EXA_API_KEY: ✅감지됨/❌미감지)"
  - label: "Brave Search"
    description: "웹/뉴스/이미지 검색 (BRAVE_API_KEY: ✅감지됨/❌미감지)"
  - label: "Tavily Search"
    description: "AI 최적화 검색 (TAVILY_API_KEY: ✅감지됨/❌미감지)"
  - label: "건너뛰기"
    description: "검색 MCP 설정 안 함"
```

"건너뛰기" 선택 시 이 단계 종료.

각 선택된 서버에 대해:
1. API 키가 감지됨 → "감지된 키를 사용합니다" 확인 메시지
2. API 키 미감지 → AskUserQuestion으로 키 입력 요청:
   ```
   question: "{서버명} API 키를 입력하세요 (발급: {URL})"
   header: "API Key"
   ```
   빈 입력이면 해당 서버 건너뛰기.
3. `.mcp.json`에 서버 추가 (Edit 도구). 파일 없으면 Write 도구로 생성.

MCP 서버 설정 레지스트리:
```json
{
  "exa": {
    "command": "npx",
    "args": ["-y", "exa-mcp-server"],
    "env": { "EXA_API_KEY": "{key}" },
    "keyUrl": "https://exa.ai/dashboard"
  },
  "brave-search": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": { "BRAVE_API_KEY": "{key}" },
    "keyUrl": "https://brave.com/search/api/"
  },
  "tavily": {
    "command": "npx",
    "args": ["-y", "tavily-mcp@latest"],
    "env": { "TAVILY_API_KEY": "{key}" },
    "keyUrl": "https://app.tavily.com/home"
  }
}
```

키 감지 경로 (순서대로 탐색, 첫 번째 매치 사용):
1. 셸 환경변수 (`$EXA_API_KEY` 등)
2. `~/projects/.env`
3. 프로젝트 루트 `.env`
4. `~/.claude/settings.json` → `env` 섹션

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
  - label: "검색 MCP"
    description: "Exa/Brave/Tavily 검색 서버 설정"
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
| Codex config.toml | ✅ approval_mode=full-auto (CLI 플래그 자동 생략) |
| Codex CLI | ✅ |
| Gemini CLI | ⚠ 미설치 (선택) |
| 원격 기기 | ✅ 2대 사용 가능 (ryzen5-7600, m2) / ❌ 1대 연결 실패 |
| MCP 인벤토리 | ✅ N개 서버 |
| 검색 MCP | ✅ Exa, Tavily / ⏭ Brave (키 없음) |

### 스웜 기능 수준

| 기능 | 상태 | 필요 조건 |
|------|------|----------|
| 로컬 단일 모델 | ✅ | Codex CLI |
| 로컬 다중 모델 | ✅ | Codex CLI + Gemini CLI |
| 다중 기기 스웜 | ✅ 2대 | SSH 호스트 + Claude 설치 |
| 전체 (다중 기기 x 다중 모델) | ✅ | 위 전부 |

### 다음 단계
- Codex 미설치 시: `npm install -g @openai/codex`
- Gemini 미설치 시: `npm install -g @google/gemini-cli`
- 원격 호스트 추가: `/tfx-remote-setup`
- 검색 MCP 추가/변경: `/tfx-setup` → 단계별 선택 → 검색 MCP
- 세션 재시작하면 HUD + 검색 MCP가 활성화됩니다
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
