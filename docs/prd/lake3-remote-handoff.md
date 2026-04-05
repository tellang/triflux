# Lake 3b: 원격 핸드오프

## 목표

로컬 세션의 git 컨텍스트, 결정사항, CLAUDE.md 경로를 직렬화하여 원격 Claude Code 세션에 전달할 수 있는 핸드오프 프롬프트를 생성한다.

## 요구사항

1. 컨텍스트 수집 (`collectHandoffContext`)
   - git root, branch, upstream ahead/behind, status, diff stat 수집
   - commandRunner 주입으로 git 명령을 외부에서 대체 가능
   - decisions 배열 + decisionFile 병합 (중복 제거)
   - claudeMdPaths 자동 탐지 또는 직접 주입
   - git 정보 없는 환경에서도 안전한 fallback
2. 프롬프트 빌드 (`buildHandoffPrompt`)
   - context 객체를 `## TFX Remote Handoff` 마크다운으로 변환
   - 변경 파일, diff stat, 결정사항, CLAUDE.md 참조, 다음 세션 지시 포함
   - 빈 필드에 대한 한국어 안내 메시지 표시
3. 직렬화 (`serializeHandoff`)
   - collectHandoffContext + buildHandoffPrompt를 합쳐 prompt 필드 포함 반환
   - bin/triflux.mjs `handoff` 커맨드에서 직접 호출

## 영향 파일

- scripts/lib/handoff.mjs — 핸드오프 코어 로직
- scripts/lib/claudemd-scanner.mjs — CLAUDE.md 경로 탐지 (기존)
- bin/triflux.mjs — handoff 커맨드 연동 (line 14, 102, 3697)
- tests/unit/handoff-serialization.test.mjs — 유닛 테스트 (26건)
- tests/unit/claudemd-scanner.test.mjs — scanner 테스트 (기존)

## 제약

- immutable 패턴 — 입력 객체를 변경하지 않음
- 파일 800줄 이하, 함수 50줄 이하
- 기존 API 호환 유지 (serializeHandoff 시그니처 불변)
- git 명령 실패 시 빈 문자열 fallback (예외 전파 금지)
