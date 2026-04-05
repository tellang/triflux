> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.

> **Telemetry**
>
> - Skill: `{{SKILL_NAME}}`
> - Description: `{{SKILL_DESCRIPTION}}`
> - Session: 요청별 식별자를 유지해 단계별 실행 로그를 추적한다.
> - Errors: 실패 시 원인/복구/재시도 여부를 구조화해 기록한다.
