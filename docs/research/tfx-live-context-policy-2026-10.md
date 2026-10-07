# tfx-live 컨텍스트 정책 근거 (2026-10-08)

이 문서는 [tfx-live 운영 스킬](../../skills/tfx-live/SKILL.md)의 판단 근거와 실측을 보관한다. 아래 비율과 모델 창 표는 리드의 운영 합의이며 제공사의 공식 권고가 아니다. 모델별 최신 공식 문서와 실행 설정이 바뀌면 값을 다시 확인한다.

## 판단 순서

작업 연속성과 소유권을 먼저 본다. 같은 목표와 담당이 계속되고 상태가 파일과 git에 남아 있으면 compact를 검토한다. 담당·CLI·모델·소유자가 바뀌거나 compact 뒤 다시 임계에 닿으면 handoff한다. 무관한 작업으로 전환하거나 작성자에서 리뷰어로 바뀌면 미완료 상태를 정리한 뒤 clear한다.

| CLI·모델군 | 합의 당시 공식 창 | 준비 | compact | 신규 배정 중지·handoff | 전송 거부 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code: Fable 5.1, Opus 5.5, Sonnet 5.5 | 1,000,000 | 60% | 75% | 85% | 90% |
| Codex: Sol 6.1, Astra 6, Terra 6, Luna 6 | 1,050,000 | 15% | 18% | 20% | 22% |
| agy: Gemini 3.8 Flash | 1,048,576 | 12% | 없음 | 15% | 18% |

Claude의 85%와 90% 사이 여유는 50,000토큰이므로 85%에 닿으면 바로 handoff한다. Claude에서 실행 한도를 확인할 수 있으면 공식 창과 실행 한도 중 작은 값으로 가드를 판단한다. Codex 실행 한도는 별도 보고하고 위 운영 비율의 분모는 공식 창을 유지한다. 한도를 모르면 비율 가드는 거부하지 않고 경고한다.

## Claude 실행 한도

Claude Code의 [`CLAUDE_CODE_DISABLE_1M_CONTEXT`](https://code.claude.com/docs/en/env-vars)을 `1`로 설정하면 native 1M 모델의 세션도 200K 창으로 제한된다. [`Extended context`](https://code.claude.com/docs/en/model-config#extended-context)에서 모델별 가용성과 제한 방식을 확인한다. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`는 auto-compact 설정에 우선하며 모델 창을 넘지 못한다. 실행 한도는 `executionContextLimitTokens`로 보고하고 공식 창과 분리한다. 사용자가 자동 compact를 꺼 둔 경우 리드가 수동 compact를 지시한다.

## Codex 실행 관찰

합의 당시 카탈로그 창은 272,000토큰, 실제 사용 창은 258,400토큰(95%), 기본 자동 압축 계산값은 244,800토큰(272,000의 90%)이었다. 실측 압축 발동 구간은 209k~235k였다. Terra 6가 같은 사양인지는 확인하지 못했다. `model_context_window`와 `model_auto_compact_token_limit`을 올리지 않는 운영 결정을 유지한다. 272K는 당시 [OpenAI API 가격](https://developers.openai.com/api/docs/pricing)의 짧은 문맥과 긴 문맥 경계로, 경계를 넘으면 입력 단가 2배·출력 단가 1.5배였다. 창을 올려도 90% 자동 압축은 꺼지지 않는다는 코드 근거는 [compact.rs](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/compact.rs)와 [openai_models.rs](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/protocol/src/openai_models.rs)에 있다. 이 값과 가격은 시점 자료이며 현재 보장이 아니다.

agy의 실측 예산 약 200,000토큰은 필드 의미를 확인하지 못했다. `tfx-live`는 agy transport를 제공하지 않으므로 agy 수치는 운영 참고값이다.

## 참고 문서

- Claude Code: [모델 설정](https://code.claude.com/docs/en/model-config), [환경 변수](https://code.claude.com/docs/en/env-vars), [컨텍스트 창](https://platform.claude.com/docs/en/build-with-claude/context-windows), [운영 지침](https://code.claude.com/docs/en/best-practices), [명령](https://code.claude.com/docs/en/commands), [agent view](https://code.claude.com/docs/en/agent-view)
- Codex: [명령](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [설정](https://learn.chatgpt.com/docs/config-file/config-reference), [가격](https://developers.openai.com/api/docs/pricing), [슬래시 명령 구현](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/slash_command.rs)
- agy: [모델](https://ai.google.dev/gemini-api/docs/models), [CLI](https://antigravity.google/docs/cli/reference), [agents](https://antigravity.google/docs/cli/commands/agents)
