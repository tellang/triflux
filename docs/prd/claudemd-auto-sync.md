# PRD: CLAUDE.md 자동 동기화 — ensureTfxSection / ensureGlobalClaudeRoutingSection

## 목표
`triflux setup` 또는 `triflux update` 실행 시 프로젝트 CLAUDE.md와 글로벌 ~/.claude/CLAUDE.md에 triflux CLI 라우팅 섹션을 자동으로 삽입/갱신하는 기능을 추가한다. 이미 존재하면 최신 버전으로 갱신, 없으면 새로 삽입.

## 파일
- `scripts/claudemd-sync.mjs` (신규, ~120줄)
- `scripts/setup.mjs` (수정, ~10줄 — claudemd-sync 호출 추가)
- `bin/triflux.mjs` (수정, ~5줄 — cmdUpdate에서도 호출)
- `tests/unit/claudemd-sync.test.mjs` (신규, ~100줄)

## 인터페이스
```javascript
// scripts/claudemd-sync.mjs
export function ensureTfxSection(claudeMdPath, routingTable) {
  // CLAUDE.md에 '## triflux CLI 라우팅' 섹션이 있는지 확인
  // 없으면 파일 끝에 삽입, 있으면 내용을 최신 routingTable로 갱신
  // returns: { action: 'created' | 'updated' | 'unchanged', path: string }
}

export function ensureGlobalClaudeRoutingSection(claudeDir) {
  // ~/.claude/CLAUDE.md에 글로벌 라우팅 섹션 삽입/갱신
  // returns: { action: 'created' | 'updated' | 'unchanged', path: string }
}

export function getLatestRoutingTable() {
  // CLAUDE.md에 삽입할 최신 라우팅 테이블 마크다운을 반환
  // 소스: 현재 프로젝트의 CLAUDE.md 내 '## triflux CLI 라우팅' 섹션
  // returns: string (마크다운)
}
```

## 제약
- CLAUDE.md의 기존 내용(triflux 섹션 외)을 절대 수정하지 않는다
- 섹션 경계: `## triflux CLI 라우팅`으로 시작, 다음 `## `로 끝남
- 불변 패턴: immutable — 기존 CLAUDE.md 내용을 읽고 새 객체로 반환
- 글로벌 CLAUDE.md(~/.claude/CLAUDE.md) 없으면 생성하지 않고 skip
- 프로젝트 CLAUDE.md 없으면 생성하지 않고 skip
- 마크다운 구조를 깨뜨리지 않도록 빈 줄 경계 준수

## 의존성
- `node:fs` (readFileSync, writeFileSync, existsSync)
- `node:path` (join)

## 테스트 명령
```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/claudemd-sync.test.mjs --no-cache
```

## 완료 조건 (필수)
작업이 끝나면 반드시:
1. 변경 파일 검토 완료
2. `git add scripts/claudemd-sync.mjs scripts/setup.mjs bin/triflux.mjs tests/unit/claudemd-sync.test.mjs && git commit -m "feat: CLAUDE.md 자동 동기화 — setup/update 시 라우팅 섹션 자동 갱신"` 수행
3. 테스트 명령 실행 및 통과 결과 확인
