# triflux — Codex 가이드

상세 운영 지시는 `CLAUDE.md`에 있습니다. Codex는 `@import` 미지원이므로 필요 시 직접 읽어주세요.

## 핵심 규칙 (triflux 환경 특화)
- `codex exec "$(cat prompt.md)" -s danger-full-access --dangerously-bypass-approvals-and-sandbox` 경로만 psmux에서 동작
- config.toml에 `approval_mode`, `sandbox` 기본값을 두고 CLI는 `--profile`만 지정
- Claude 작성 코드는 Codex로 교차 검증 (self-approve 금지)
- headless 결과는 task-notification 완료 후에만 읽기
