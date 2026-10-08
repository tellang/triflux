# triflux Antigravity 프로젝트 지시

Antigravity CLI는 웹 검색, 코드 검토, consensus·debate·panel 분석과 작업 실행을 맡는다.
프로젝트 운영 규칙은 `CLAUDE.md`, 실행 정책은 `.claude/rules/`, 결정 근거는 `docs/adr/README.md`에 있다.

## 행동 규칙

- 한국어로 답하고 코드 식별자·명령어·로그는 원래 언어를 유지한다.
- 확인한 사실과 추정을 구분한다.
- 커밋 형식은 `type(scope): 한국어 설명`이다. `Co-Authored-By`와 AI 꼬리표를 넣지 않는다.
- API 키, 토큰, 세션 값을 하드코딩하지 않는다.

## 실행 경로

Antigravity 작업은 `tfx-auto --cli antigravity` 또는 역할 기반 `tfx-route.sh`를 경유한다.
코드 변경 병렬 작업은 작업별 worktree와 세션을 분리한다.

```bash
TFX_CLI_MODE=antigravity bash ~/.claude/scripts/tfx-route.sh executor "$prompt" implement < /dev/null
```

`tfx-route.sh`의 인자는 역할, 프롬프트, MCP 프로필 순서다. `--cli` 옵션은 받지 않는다.
`agy`의 비대화식 프롬프트는 `--print` 값으로 전달한다. Gemini CLI 실행 경로는 제공하지 않는다.
모델과 추론 수준은 프로필 설정을 따른다.

## 운영 규칙

- Windows psmux와 WT 실행 규칙은 `.claude/rules/tfx-psmux.md`에 있다.
- 원격 실행은 `tfx-remote`를 사용한다.
- 비대화식 결과는 작업 완료 알림 뒤에 읽는다. 완료 마커는 `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===`다. 워커별 상태와 exit 코드는 `$TMPDIR/triflux-<uid>/tfx-headless/{sessionName}.results.json` 결과 색인을 읽는다(ADR-0034).
- Claude 작성 코드는 Codex로, Antigravity 작성 코드는 Claude 또는 Codex로 교차 검증한다. 동일 모델이 스스로 승인하지 않는다.

## 스킬 라우팅

설치된 스킬의 description과 사용자 요청이 맞으면 해당 스킬을 호출한다.

| 작업 | 스킬 |
| --- | --- |
| 제품 아이디어 | `/gstack-office-hours` |
| 전략과 범위 | `/gstack-plan-ceo-review` |
| 아키텍처 | `/gstack-plan-eng-review` |
| 설계 검토 | `/gstack-design-consultation`, `/gstack-plan-design-review` |
| 계획 검토 | `/gstack-autoplan` |
| 오류 조사 | `/gstack-investigate` |
| QA | `/gstack-qa`, `/gstack-qa-only` |
| 코드 검토 | `/gstack-review` |
| 시각 설계 검토 | `/gstack-design-review` |
| 출시 | `/gstack-ship`, `/gstack-land-and-deploy` |
| 진행 저장 | `/gstack-context-save` |
| 맥락 복원 | `/gstack-context-restore` |
| 명세 작성 | `/gstack-spec` |

## 검증

변경 영역의 lint, 타입 검사, 테스트를 실행한다. 스킬 문서는 `npm run lint:skills`로 검사한다.
패키지 미러와 버전은 `node scripts/release/check-packages-mirror.mjs`와
`node scripts/release/check-sync.mjs`로 확인한다.
