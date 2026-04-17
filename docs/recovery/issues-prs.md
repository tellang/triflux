# Issues/PRs Recovery Report (2026-04-10 ~ 2026-04-17)

## 스캔 범위
- Open PRs: #72, #73, #83, #84, #85, #86
- Closed PRs (최근 1주): #82, #75, #74, #71, #70, #69
- Open Issues (전체): #81, #80, #78, #77, #76, #67, #66
- Closed Issues (최근 1주): #79, #68, #65, #64, #62
- 최근 생성 이슈 재확인: #78, #80
- 수집 소스: PR/Issue 본문, PR conversation comment, review body, inline review comment
- 패턴: `follow-up`, `follow up`, `후속`, `연관`, `related`, `separate issue`, `별도 이슈`, `새 이슈`, `issue 로 올리`, `추가 이슈`, `나중에 처리`, `추후`, `later`, `block`, `depends on`, `revert`, `rollback`, `TODO`, `FIXME`, `XXX`

## 발견 항목

### [P1] Issue #79 / PR #82가 Codex config.toml 동기화를 별도 follow-up으로 분리 — type: `omission`+`intent`
- 상태: Issue #79 `closed`, PR #82 `merged`, 후속 이슈 #81 `open`
- 출처:
  - Issue #79 body by @tellang on 2026-04-17
  - PR #82 body by @tellang on 2026-04-17
  - Open Issue #81 body by @tellang on 2026-04-17 (실제 추적 이슈)
- **인용**:
  - Issue #79: "Codex config.toml TOML 동기화는 이번 PRD에서 누락되어 있으므로 follow-up 필요."
  - PR #82: "Codex `~/.codex/config.toml` 동기화는 별도 이슈 #81 (TOML 파서 필요)"
- **누락 내용**: `~/.codex/config.toml`의 `[mcp_servers.tfx-hub] url` 자동 갱신
- **해석**: 구현 범위를 Gemini/Claude settings sync로 제한하면서 Codex TOML sync는 의도적으로 분리했고, 실제로 Open Issue #81이 생성되어 후속 작업으로 남아 있다.
- **권장**: recovery 기준 canonical tracker는 #81로 통일하고, #79/#82는 “원인 문맥” 링크로만 참조

### [P2] PR #73이 PR #72의 후속 PR이며 macOS E2E 검증이 아직 미완 — type: `intent`+`omission`
- 상태: PR #72 `open`, PR #73 `open`
- 출처: PR #73 body by @tellang on 2026-04-15
- **인용**:
  - "PR #72의 후속"
  - "[ ] macOS headless E2E 검증 (tmux + codex/gemini)"
- **누락 내용**: macOS 환경에서 headless/psmux/codex+gemini 조합의 end-to-end 검증이 아직 체크되지 않음
- **해석**: PR #72와 #73이 같은 플랫폼 호환성 맥락을 나눠 들고 있고, PR #73 본문이 명시적으로 후속 PR임을 선언한다.
- **권장**: merge 전에 macOS E2E를 PR 내에서 닫거나, 장기화되면 별도 issue로 분리해 종료 조건을 명시

### [P3] PR #69는 merge 대신 later commits로 superseded되어 회수 포인트가 분산됨 — type: `loss`+`diff`
- 상태: PR #69 `closed` (not merged)
- 출처:
  - PR #69 body by @pbjuni1007-cmyk on 2026-04-15
  - closing comment by @tellang on 2026-04-15
- **인용**:
  - PR body: "필요 시 동일 helper를 공용화하는 후속 PR 고려"
  - closing comment: "이 PR은 위 커밋들로 대체(superseded)되어 닫습니다."
- **원래 의도**: Windows에서 Gemini `.cmd` shim spawn ENOENT를 해결
- **대체/닫힘 이유**: maintainer가 regression 원복 경로를 추적해 동일 문제를 별도 커밋(`7ea40ee`, `abaa8fc`, `38c4880`, `cb69706`)로 반영하면서 PR 자체는 superseded 처리
- **재시도 여부**: 기능은 다른 커밋 경로로 landed 되었으나, 토론/설계 근거는 PR #69 코멘트와 landed commit 사이에 분산됨
- **권장**: recovery 시 PR #69 브랜치가 아니라 landed commits + closing comment를 함께 읽도록 링크 묶기

## 중복 가능성 (이슈↔PR 이중 트래킹)
- type: `diff`
  - **#79 ↔ #82 ↔ #81**: 같은 Codex TOML sync 누락이 closed issue, merged PR, open issue 세 곳에 걸쳐 기록됨
  - **권장 canonical tracker**: #81
- type: `diff`
  - **#72 ↔ #73**: 같은 macOS/platform compatibility 맥락이 두 open PR로 분리되어 있음
  - **주의점**: 검증 상태와 merge 기준이 PR 본문 사이에 갈라져 추적 비용이 높아질 수 있음

## 명시적 미발견 항목
- Open PR #72, #83, #84, #85, #86: 본문/comment/review/inline comment에서 명시적 follow-up/separate-issue/TODO 패턴 미발견
- Closed PR #75, #74, #71, #70: 본문/comment/review/inline comment에서 명시적 follow-up/separate-issue/TODO 패턴 미발견
- Open Issue #66, #67, #76, #77, #78, #80: 본문/comment에서 명시적 follow-up/separate-issue 패턴 미발견
- Closed Issue #68, #65, #64, #62: closing comment/body에서 명시적 후속 언급 미발견

## 요약
- severity 분포: `P1=1`, `P2=1`, `P3=1`
- type 분포(중복 집계): `omission=2`, `intent=2`, `loss=1`, `diff=3`
- 명시적 follow-up이 **이미 새 이슈로 분리된 건**: #81
- 이번 스캔에서 **새로 추가 생성이 필요한 미추적 follow-up**은 없음
