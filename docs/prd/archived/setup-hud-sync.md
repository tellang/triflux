# PRD: setup.mjs HUD 디렉토리 동기화 — 개별 파일 매핑을 디렉토리 스캔으로 전환

## 목표
setup.mjs의 HUD 파일 동기화를 개별 파일 나열 방식에서 `hud/` 디렉토리 자동 스캔 방식으로 전환하여, 새 파일(예: context-monitor.mjs) 추가 시 setup.mjs 수정 없이 자동 배포되도록 한다.

## 파일
- `scripts/setup.mjs` (수정, ~30줄 변경)
- `tests/unit/setup-hud-sync.test.mjs` (신규, ~60줄)

## 인터페이스
```javascript
// 기존: FILE_MAP 배열에 개별 hud 파일을 하나씩 나열
// 변경: hud/ 디렉토리를 재귀 스캔하여 FILE_MAP에 동적 추가
function scanHudFiles(pluginRoot, claudeDir) {
  // hud/ 아래 모든 .mjs 파일을 재귀 탐색
  // 각 파일에 대해 { src, dst, label } 엔트리 생성
  // returns: Array<{src: string, dst: string, label: string}>
}
```

## 제약
- `hud/` 디렉토리 내 `.mjs` 파일만 동기화 (다른 확장자 무시)
- 기존 FILE_MAP의 hud 관련 개별 엔트리 9개를 scanHudFiles() 호출 1줄로 대체
- `omc-hud.mjs`, `omc-hud.mjs.bak`는 동기화 대상에서 제외 (레거시)
- `hud/` 하위 디렉토리(예: `providers/`)도 재귀 스캔
- PLUGIN_ROOT = 프로젝트 루트, CLAUDE_DIR = ~/.claude

## 의존성
- `node:fs` (readdirSync, existsSync)
- `node:path` (join, relative)

## 테스트 명령
```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/setup-hud-sync.test.mjs --no-cache
triflux doctor --json
```

## 완료 조건 (필수)
작업이 끝나면 반드시:
1. 변경 파일 검토 완료
2. `git add scripts/setup.mjs tests/unit/setup-hud-sync.test.mjs && git commit -m "fix: setup.mjs hud 디렉토리 동적 스캔으로 전환 — 신규 파일 자동 배포"` 수행
3. 테스트 명령 실행 및 통과 결과 확인
