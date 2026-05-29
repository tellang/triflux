# TFX Skill Authoring SSOT

이 문서는 Triflux 스킬 작성 규칙의 단일 정본이다. Claude Code와 Codex가
같은 스킬 표면을 읽을 때 drift가 생기지 않도록, 스킬 활성화·메타데이터·모델
지정 규칙을 여기로 고정한다.

## 1. 활성화 조건은 description 단독

- 스킬 활성화는 frontmatter `description:`만으로 결정된다.
- `triggers:`는 Claude Code 표준에서 활성화 신호로 인정되지 않는다.
- 기존 호환성이나 문서화를 위해 `triggers:`가 남아 있을 수 있어도, 새 판단
  기준으로 사용하지 않는다.
- 따라서 `description:`은 한국어로 유지하되, 언제 이 스킬을 써야 하는지
  명확하게 적는다.

## 2. name만 영문

- frontmatter `name:`은 영문 소문자, 숫자, 하이픈만 사용한다.
- 스킬 본문과 설명은 한국어를 기본 언어로 유지한다.
- 사용자가 보는 절차, 주의사항, 실패 처리 문구는 번역투보다 운영자가 바로
  실행할 수 있는 한국어 문장으로 쓴다.

## 3. 모델명은 프로필이 SSOT

- Codex, Claude, Antigravity 모델 ID는 프로필 설정이 단일 정본이다.
- `SKILL.md` 본문에 `gpt-5.5`, `opus-4-8` 같은 모델명을 하드코딩하지 않는다.
- 스킬 문서에서는 `gpt55_high`, `gpt55_xhigh`, `pro31` 같은 프로필명이나
  "프로필 설정을 따른다"는 표현을 사용한다.
- 모델 교체가 필요하면 스킬 본문을 고치지 말고 프로필 설정과 라우팅 규칙을
  갱신한다.

## 4. SKILL.md가 단일 정본

- `skills/**/SKILL.md`가 배포·리뷰·lint 기준의 단일 정본이다.
- `SKILL.md.tmpl` 기반 생성 파이프라인은 deprecated 상태이며 새 변경을
  추가하지 않는다.
- 기존 `.tmpl` 파일은 별도 gate에서 일괄 정리한다. 개별 shard는 lease 밖
  대량 삭제를 수행하지 않는다.

## 5. Lake4 manifest는 영구 보류

- Lake4 manifest 분리는 영구 보류한다.
- Claude Code가 frontmatter를 필수 표면으로 요구하므로, manifest만 별도
  정본으로 분리할 수 없다.
- `skill.json`이나 manifest 계열 파일이 있어도 `SKILL.md` frontmatter를
  대체하지 않는다.

## 6. 변경 검증

- 스킬 문서를 바꾼 뒤 `npm run lint:skills`를 실행한다.
- `npm test`는 `lint:skills`를 포함하므로, 테스트 파이프라인에서도 동일한
  규칙이 적용된다.
