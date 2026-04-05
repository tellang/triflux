> headless-guard가 이 규칙 위반을 **자동 차단**한다. 우회 불가.

1. **`codex exec` / `gemini -p` 직접 호출 절대 금지**
2. Codex·Gemini 작업은 직접 CLI 대신 반드시 TFX 래퍼(이 계열 스킬에서는 `Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign 'cli:프롬프트:역할' --timeout 600")`)로만 실행
3. Claude 작업은 `Agent(run_in_background=true)`
4. 교차 검토/병렬 단계에서는 Bash + Agent를 같은 메시지에서 동시 호출
