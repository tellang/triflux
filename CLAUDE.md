# triflux

<context>
<language>한국어로 응답. 코드 주석도 한국어.</language>
<description>CLI-first multi-model orchestrator — Codex/Gemini/Claude 라우팅</description>
<stack>Node.js (ESM), Bash</stack>
</context>

## 커밋 규칙

> **[필수] Claude/AI 관련 흔적을 커밋에 절대 남기지 마라**
>
> - `Co-Authored-By: Claude` 헤더 **금지**
> - `Co-Authored-By: *anthropic*` 헤더 **금지**
> - `Co-Authored-By: *noreply@anthropic.com*` 헤더 **금지**
> - 커밋 메시지에 "Claude", "AI 생성", "AI-generated" 등 AI 도구 언급 **금지**
> - `.claude/`, `.omc/` 등 AI 설정 디렉토리는 `.gitignore`에 포함, 커밋 **금지**
>
> **이 규칙은 어떤 상황에서도 예외 없이 적용된다.**

### 커밋 메시지 형식

```
Type: 한국어 설명 (50자 이내)

본문 (선택, 한국어, 72자 줄바꿈)
```

| Type | 용도 |
|------|------|
| Feat | 새 기능 |
| Fix | 버그 수정 |
| Refactor | 동작 변경 없는 코드 개선 |
| Docs | 문서만 변경 |
| Chore | 설정, 의존성, 빌드 |
| Style | UI/CSS/포맷팅만 변경 |
| Test | 테스트 추가/수정 |

## 프로젝트 구조

```
triflux/
├── bin/           # CLI 진입점 (triflux.mjs, tfx-setup.mjs, tfx-doctor.mjs)
├── skills/        # Claude Code 스킬 (tfx-auto, tfx-codex, tfx-gemini, tfx-setup)
├── scripts/       # cli-route.sh, setup.mjs, mcp-check.mjs
├── hooks/         # 세션 시작 훅
├── hud/           # HUD 상태 표시줄
├── docs/          # 문서, 에셋
├── .claude-plugin/ # 플러그인 메타데이터
└── package.json   # triflux v2.0.0
```

## 브랜딩

| 항목 | 값 |
|------|-----|
| 패키지명 | `triflux` |
| CLI | `tfx` (1순위) / `triflux` / `tfl` |
| Primary 색상 | Amber `#FFAF00` (ANSI 214) |
| Secondary | Slate `#374151` (ANSI 239) |
| Accent | Sky Blue `#38BDF8` (ANSI 39) |

## 보안

- `.env` 파일 커밋 금지
- API 키/인증 정보 로깅 금지
- `.claude/`, `.omc/`, `.codex/`, `.gemini/` → `.gitignore`
