---
name: tfx-auto-codex
description: Codex 리드형 tfx-auto. Claude 네이티브 역할을 Codex로 치환하고 Gemini 사용은 유지합니다.
triggers:
  - tfx-auto-codex
argument-hint: "\"작업 설명\" | N:agent_type \"작업 설명\""
---

# tfx-auto-codex — Codex 리드형 tfx-auto

> 목적: 기존 `tfx-auto`의 오케스트레이션 패턴을 유지하면서
> Claude 네이티브 역할(`explore`, `verifier`, `test-engineer`, `qa-tester`)을
> Codex로 치환해 Codex/Gemini만으로 실행한다.

## 핵심 원칙

1. **Codex 라우팅 유지**
   - 구현/분석/리뷰/디버깅/검증은 Codex 우선.
2. **Gemini 유지**
   - `designer`, `writer`는 Gemini 경로를 그대로 사용.
3. **Claude 네이티브 제거**
   - 실행 시 `TFX_NO_CLAUDE_NATIVE=1`로 강제.
4. **고난도 설계는 xhigh**
   - 설계/분해/비판 검토 성격의 작업은 `codex --profile xhigh` 기준으로 운용.

## 사용법

```bash
/tfx-auto-codex "인증 리팩터링 + UI 개선 + 테스트 보강"
/tfx-auto-codex 3:codex "src/api, src/auth, src/payment 병렬 리뷰"
/tfx-auto-codex 2:gemini "온보딩 UI 카피 + 접근성 개선"
```

## 실행 규칙

`tfx-auto` 워크플로우(입력 파싱 → 트리아지 → 분해 → DAG 실행 → 수집/보고)를 그대로 사용한다.

단, **실행 명령은 아래 환경변수를 반드시 포함**한다:

```bash
TFX_NO_CLAUDE_NATIVE=1 bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile}
```

### 역할 치환 (자동)

`TFX_NO_CLAUDE_NATIVE=1`일 때:

- `explore` -> Codex `fast`
- `verifier` -> Codex `thorough review`
- `test-engineer` -> Codex `high`
- `qa-tester` -> Codex `thorough review`

## 트리아지 기준

- `codex`: 코드 구현/수정/분석/리뷰/디버깅/테스트/검증/리서치
- `gemini`: 문서/UI/디자인/멀티모달

Claude 타입 반환은 기본적으로 허용하지 않는다.
분류 결과에 `claude`가 포함되면 `codex`로 치환 후 분해를 진행한다.
단, Codex CLI 미설치 환경에서는 실행 안전성을 위해 `claude-native` fallback이 유지될 수 있다.

## 권장 프로필

- 설계/계획/비판적 검토: `xhigh`
- 일반 구현/수정: `high`
- 리뷰: `thorough`
- 빠른 탐색: `fast`

## 의존성

- `~/.claude/scripts/tfx-route.sh` 최신 동기화 상태
- Codex CLI 설치
- Gemini CLI 설치 (UI/문서 경로 사용 시)

## Troubleshooting

문제 발생 시 `/tfx-doctor` 실행. (`--fix` 자동 수정, `--reset` 캐시 초기화)
