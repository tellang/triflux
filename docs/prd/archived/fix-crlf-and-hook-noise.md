# PRD: CRLF 통일 + hook noise 수정

## 목표
npm run pack 후 CRLF→LF 변환 경고 119개 제거 + hook-orchestrator Write/Edit 에러 노이즈 제거

## Shard 1: .gitattributes LF 강제
- agent: codex
- files: .gitattributes
- prompt: |
    프로젝트 루트에 .gitattributes 파일을 생성하거나 수정하여 다음 규칙을 추가하라:
    ```
    *.mjs text eol=lf
    *.js text eol=lf
    *.json text eol=lf
    *.md text eol=lf
    *.sh text eol=lf
    ```
    그 후 `git add .gitattributes` 하고 커밋 메시지: "chore: .gitattributes LF 강제 — pack CRLF 경고 제거"

## Shard 2: hook-registry Write/Edit passthrough
- agent: codex
- files: hooks/hook-registry.json
- prompt: |
    hooks/hook-registry.json의 PreToolUse 이벤트에 Write와 Edit 도구에 대한 passthrough 엔트리를 추가하라.
    현재 PreToolUse에는 Bash와 Agent matcher만 있어서, Write/Edit 호출 시 "no matching hook" 에러가 발생한다.
    다음 엔트리를 PreToolUse 배열 마지막에 추가:
    ```json
    {
      "id": "tfx-write-edit-passthrough",
      "source": "triflux",
      "matcher": "Edit|Write",
      "command": "echo '{}'",
      "priority": 999,
      "enabled": true,
      "timeout": 1,
      "blocking": false,
      "description": "Edit/Write 도구 기본 통과 (hook-registry matcher 없음 에러 방지)"
    }
    ```
    커밋 메시지: "fix: hook-registry에 Edit/Write passthrough 추가 — orchestrator 에러 노이즈 제거"
