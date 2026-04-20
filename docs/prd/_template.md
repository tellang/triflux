<!-- 사용법: 이 템플릿을 복사해 `docs/prd/<프로젝트명>/<순번>-<주제>.md`로 저장한 뒤, 각 섹션의 <> 플레이스홀더를 실제 내용으로 치환하세요. -->

# PRD: <모듈/기능명> — <한줄 요약>

## 목표
<이 PRD에서 반드시 달성해야 하는 결과를 1~3문장으로 작성>

## 파일
- `<경로/파일명>` (<신규|수정>, ~<예상 줄 수>줄)
- `<경로/파일명>` (<신규|수정>, ~<예상 줄 수>줄)

## 인터페이스
```javascript
// 예시: 공개 API, 함수 시그니처, 입력/출력 구조
export function <name>(<args>)
// returns: <반환 타입/구조>
```

## 제약
- <기술/운영/성능 제약 1>
- <기술/운영/성능 제약 2>
- <불변 조건 또는 금지 사항>

## 의존성
- <내부 모듈/패키지/외부 시스템>
- 없음 (해당 시)

## 테스트 명령
```bash
<테스트 명령어 1>
<테스트 명령어 2>
```

## Codex 실행 제약 (자동 삽입됨)
<!-- codex-swarm 스킬이 이 섹션을 자동으로 프롬프트에 주입합니다.
     PRD 작성자는 이 섹션을 수정하지 마세요. -->
- stdin redirect 금지: `codex < file` → "stdin is not a terminal" 에러
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec`는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox와 충돌)
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능 — 순차 실행 권장

## 완료 조건 (필수)
작업이 끝나면 반드시:
1. 변경 파일 검토 완료
2. 테스트 명령 실행 및 통과 결과 확인
3. **반드시** 아래 형식으로 커밋 수행:
   ```bash
   git add <변경 파일 목록>
   git commit -m "<type>: <설명>"
   ```
   커밋하지 않으면 작업이 유실됩니다. codex는 명시적 지시 없이 자동 커밋하지 않습니다.

## Completion Protocol (자동 삽입됨)
<!-- swarm hypervisor 가 이 섹션을 worker prompt 에 자동 주입합니다.
     PRD 작성자는 이 섹션을 수정하지 마세요.
     상세: hub/team/build-worker-prompt.mjs / sentinel-capture.mjs (#125). -->
- worker 는 stdout 의 마지막에 `<<<TFX_COMPLETION_BEGIN>>>` / `<<<TFX_COMPLETION_END>>>` sentinel 사이에 단일 JSON object payload 를 출력해야 한다.
- 미준수 시 conductor 는 16 KiB stdout tail 의 brace-scan fallback 으로 추출을 시도하지만, payload 가 16 KiB 를 초과하면 silent partial extraction 위험이 있다.
- BEGIN 만 출력하고 END 누락 시 conductor 가 truncation 으로 명확히 reject (F7).
