# PRD: 3-CLI 프로파일 통일 리서치

## 목표

Claude, Codex, Gemini 3개 CLI의 프로파일/설정 시스템을 조사하고, 통일된 프로파일 관리 방안을 설계한다.

## 배경

현재 triflux는 3개 CLI를 사용하며 각각 독립된 설정 체계를 가진다:
- **Claude**: `~/.claude/` 디렉토리, CLAUDE.md, MCP 설정
- **Codex**: `~/.codex/config.toml`, profiles, approval_mode, sandbox
- **Gemini**: `~/.gemini/`, API key, 모델 설정

이로 인해:
- 프로파일 관리가 3곳에 분산
- 새 모델/effort 추가 시 3곳 동시 업데이트 필요
- 스웜 실행 시 프로파일 라우팅이 Codex에만 존재

## 조사 범위

### 1. 각 CLI 설정 체계 매핑

각 CLI의 공식 문서를 조사하고 설정 항목을 매핑한다:

| 항목 | Claude | Codex | Gemini |
|------|--------|-------|--------|
| 설정 파일 경로 | ? | ? | ? |
| 모델 선택 | ? | ? | ? |
| 승인 모드 | ? | ? | ? |
| 실행 환경 | ? | ? | ? |
| MCP 서버 | ? | ? | ? |
| 프로파일 시스템 | ? | ? | ? |

### 2. 통일 프로파일 스키마 설계

3-CLI 공통 프로파일 스키마를 설계한다:

```toml
[profiles.high]
claude_model = "opus"
codex_model = "codex-mini-latest"
codex_effort = "high"
gemini_model = "gemini-2.5-pro"
approval_mode = "full-auto"
```

### 3. 라우팅 통합 방안

tfx-route.sh가 통일 프로파일을 각 CLI의 네이티브 설정으로 변환하는 방안:

```bash
# 프로파일 → CLI별 변환
profile_to_claude_args(profile)
profile_to_codex_args(profile)
profile_to_gemini_args(profile)
```

### 4. 마이그레이션 경로

기존 Codex 전용 프로파일(codex53_high 등)에서 통일 프로파일로의 마이그레이션 방안.

## 산출물

- `docs/research/3cli-profile-unification.md` — 리서치 보고서 (최소 500줄)
  - 각 CLI 설정 체계 상세 분석
  - 통일 스키마 초안
  - 라우팅 변환 로직 설계
  - 마이그레이션 계획
  - 리스크/제약 사항

## 제약

- 코드 변경 없음 (리서치 + 문서만)
- 각 CLI의 공식 문서/소스를 기반으로 조사
- 추측이 아닌 실제 확인된 정보만 기록

## 커밋

작업 완료 후 반드시 `git add` + `git commit` 할 것. 커밋 메시지 형식:
```
docs: 3-CLI 프로파일 통일 리서치 보고서
```
