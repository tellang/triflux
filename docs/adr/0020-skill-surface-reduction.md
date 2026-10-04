---
id: 0020
title: tfx 스킬 표면을 12개 + Windows 1개로 줄인다
status: proposed
date: 2026-10-04
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0004, 0009]
pr: null
---

# ADR-0020: tfx 스킬 표면을 12개 + Windows 1개로 줄인다

## 컨텍스트와 문제 (Context)

패키지에 `tfx-*` 스킬이 23개 있었다. 그중 상당수는 다른 스킬의 얇은 별칭(`tfx-ralph` = `tfx-auto --retry ralph`)이거나, 호스트 기본 기능과 겹치거나(`tfx-find` ↔ Claude 기본 Explore 에이전트), 다른 스킬의 한 절이면 충분한 크기였다(`tfx-hooks`, `tfx-hub`, `tfx-goal-clarify`).

스킬은 설치되면 description이 매 세션 컨텍스트에 실리고, 비슷한 description끼리 활성화를 다툰다. 라우팅 정본(`.claude/rules/tfx-routing.md`)도 이 스킬들을 owner로 돌려주고 있어서 표면을 줄이려면 문서·키워드 규칙·설치 정리를 함께 바꿔야 했다.

`tfx-wt`는 Windows Terminal 전용인데 macOS/Linux에도 설치되어 description이 오탐 대상이 됐다. 키워드 규칙에는 이미 `platform` 필터가 있었지만 스킬 설치에는 없었다.

## 결정 (Decision)

우리는 남길 스킬을 `tfx-auto`, `tfx-harness`, `tfx-ship`, `tfx-live`, `tfx-remote`, `tfx-setup`, `tfx-doctor`, `tfx-profile`, `tfx-review`, `tfx-plan`, `tfx-research`, `tfx-interview` 12개와 Windows 전용 `tfx-wt`로 정한다.

- 기능 이전 없이 지운다: `tfx-ralph`, `tfx-forge`, `tfx-find`, `tfx-index`.
- 쓸모 있는 내용을 옮긴 뒤 지운다: `tfx-goal-clarify` → `tfx-interview --format goal`, `tfx-hooks` → `tfx-setup`의 훅 우선순위 절, `tfx-hub` → `tfx-doctor`의 hub 관리 절, `tfx-analysis` → `tfx-auto --mode consensus --shape panel`, `tfx-prune` → `tfx-auto --mode consensus`, `tfx-qa` → `tfx-review`(코드 판정)와 gstack `/qa`(브라우저·흐름 게이트).
- `tfx-hub` MCP 서버, `tfx hub` CLI, `hub/` 코드는 스킬이 아니므로 그대로 둔다.
- 지운 스킬을 가리키던 키워드 규칙은 패턴을 바꾸지 않고 흡수한 스킬로 돌린다. 대상이 없는 `tfx-find` 규칙만 지운다.
- 지운 스킬의 설치본은 cleanup 보호 목록(`LEGACY_ALIAS_TOMBSTONES`)에 넣지 않는다. 패키지에 없으므로 `tfx setup`의 stale 정리가 지운다.
- SKILL.md frontmatter `platform:`(process.platform 값 목록)을 둔다. 키워드 규칙의 `platform`과 같은 뜻이다. setup은 비대상 플랫폼에 그 스킬을 설치하지 않고 이미 깔린 사본을 지운다. Codex 쪽 managed 스킬 동기화도 같은 규칙을 따른다.

## 검토한 대안 (Considered Options)

- **지운 스킬을 `LEGACY_ALIAS_TOMBSTONES`에 넣는다**: v10 별칭 정리 때와 같은 모양이다. 그러나 이 목록은 설치본을 cleanup에서 *보호*하므로, 넣으면 낡은 `tfx-qa`(macOS에서 최하위 경로로 떨어지던 preflight 포함) 같은 사본이 사용자 기기에 영구히 남는다. 기각한다.
- **별칭 스킬로 남긴다**: 사용자 습관은 지키지만 description 경쟁과 컨텍스트 비용이 그대로다. 키워드 규칙 retarget이 명시 토큰을 받아 주므로 기각한다.
- **`tfx-wt`를 패키지에서 뺀다**: Windows 사용자에게는 safety-guard가 막는 `wt.exe`의 유일한 경로라 뺄 수 없다.
- **플랫폼 필드 이름을 `platforms`로 한다**: 영어로는 자연스럽지만 키워드 규칙이 이미 `platform`(배열)을 쓴다. 한 저장소에서 같은 뜻에 두 이름을 쓰지 않는다.

## 결과 (Consequences)

`tfx-*` 스킬 설치본이 23개에서 macOS/Linux 12개, Windows 13개로 준다. `/tfx-ralph`처럼 지운 이름을 직접 치던 사용자는 스킬을 찾지 못한다. 대신 `tfx analysis`, `tfx prune`, `tfx qa`, `tfx hub` 같은 명시 토큰은 키워드 훅이 흡수한 스킬로 보낸다.

플랫폼 필터는 `~/.claude/skills`로 복사하는 setup 경로에만 걸린다. Claude Code 플러그인 모드(`.claude-plugin/plugin.json`의 `skills: ./skills/`)는 디렉터리를 그대로 읽으므로 이 필터를 거치지 않는다.

README와 마켓플레이스 설명의 스킬 수는 이 결정과 별개로 다시 쓴다.
