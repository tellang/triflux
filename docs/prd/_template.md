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

## 실행 제약

코드 변경을 병렬로 진행하면 작업별 worktree와 세션을 나누고, 각 세션의 CLI 실행은 `tfx-auto`를 거친다. Claude Agent를 사용하면 `isolation: worktree`를 지정할 수 있다. Codex 프로필과 실행 규칙은 [tfx-execution-skill-map.md](../../.claude/rules/tfx-execution-skill-map.md) 및 [tfx-psmux.md](../../.claude/rules/tfx-psmux.md)를 따른다.

- 모델·effort·sandbox·프로필은 CLI 하드코딩 대신 프로필/`config.toml`을 SSOT로 사용하고, `config.toml`에 이미 있는 값은 CLI 플래그로 중복 지정하지 않는다.
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능. 순차 실행을 권장한다.

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
