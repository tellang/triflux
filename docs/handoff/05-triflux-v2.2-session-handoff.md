# Claude `/tfx-team` Session Handoff (2026-03-11)

## 세션 목적

이번 세션의 목적은 Claude 기반 `/tfx-team` 운영에서 드러난 UX 문제와 Hub 복구 경로를 점검하고, 관련 변경사항과 남은 리스크를 후속 작업자가 바로 이어받을 수 있게 정리하는 것이었다.

## 이번 세션의 핵심 인사이트

- `/tfx-team` 자체에서 Codex/Gemini 워커 호출은 성공했다. 문제는 워커 호출 실패가 아니라 운영 경로와 UI 복원성에 있었다.
- 워커 UI가 보이지 않은 직접 원인은 코드 수정 자체보다 `Hub off -> 직접 Bash 병렬 실행 폴백` 경로였다. 이 경로에서는 Native Team 워커 UI와 Shift 네비게이션이 애초에 생기지 않는다.
- 사용자 관점의 핵심 문제는 "왜 저 라우팅을 택했는가"가 아니라 "왜 Hub가 죽었는가"와 "세션 시작 시 이를 백그라운드에서 얼마나 강건하게 복구하느냐"였다.
- preflight 확인을 포그라운드에서 장황하게 출력하는 현재 UX는 요구와 맞지 않는다. 세션 시작 점검은 비동기/요약 출력이 기본이어야 한다.
- `/health`만으로 Hub 생존을 판정하면 오판 가능성이 있다. 실제로 기존 27888 Hub는 `/status` 200, `/health` 404였다.
- SessionStart의 Hub ensure는 비동기 분리와 `postinstall` 예외 처리가 중요하다. 설치 단계에서 예기치 않게 Hub를 띄우면 부작용이 크다.
- 작업 범위가 한때 Claude `/tfx-team`와 Codex `codex-team` 런타임까지 섞였다. 이후 현재 턴의 직접 범위는 Claude `/tfx-team` 중심으로 재고정되었다.
- 요구사항 재질문보다 기존 로컬 PRD와 공식 Claude 문서를 먼저 대조하는 것이 맞다. 이번 세션에서 그 우선순위가 명확해졌다.

## 무엇이 새롭게 명확해졌는가

- Shift 네비게이션 문제와 워커 UI 부재는 같은 문제가 아니었다.
- Hub 미기동 상태에서 나타난 워커 UI 부재는 팀 UI 생성 경로 자체가 달라진 결과였다.
- `/status` 기반 판정과 비동기 Hub ensure가 Claude `/tfx-team` UX 안정화의 핵심 축이다.
- `skills/tfx-team/SKILL.md`의 preflight 출력 정책은 구현 변경과 함께 맞물려 조정되어야 한다.
- 이번 턴의 요구 범위는 `codex-team` 런타임이 아니라 Claude `/tfx-team` 관련 문서, 동작, 출력 정책 전체다.
- 브랜치 전략은 새 브랜치가 아니라 `dev` 직접 진행이며, 커밋은 단계별로 남겨야 한다.

## 무엇이 아직 불확실한가

- Hub가 실제로 죽는 근본 원인이 재현 가능한 형태로 정리되었는지는 아직 불충분하다.
- Shift+위 방향키 자체의 미동작이 Claude 내부 이슈인지, triflux 측 우회 여지가 더 있는지는 확정되지 않았다.
- 일부 리뷰에서 드러난 `teamKill()` fallback, 포트 하드코딩 잔존 문제가 Claude `/tfx-team` 범위에서 어디까지 바로 처리되어야 하는지 우선순위 정리가 필요하다.
- 공식 Claude Code 문서 링크는 수집되었지만, 로컬 PRD와의 요구사항 매트릭스는 아직 작성되지 않았다.

## 확인된 사실

### 운영 및 검증

- `/tfx-team` 테스트에서 Codex/Gemini 워커 호출은 성공했다.
- `node --check`가 관련 변경 파일들에서 통과했다.
- `npm run test:route-smoke`가 통과했다.
- 새 코드로 띄운 임시 Hub는 `/health` 200을 반환했다.
- 기존 27888 포트의 기존 Hub 프로세스는 `/status` 200, `/health` 404 상태였다.
- `postinstall` 상황에서는 setup이 Hub를 자동으로 띄우지 않도록 게이트가 동작했다.

### 이번 세션에서 실제로 건드린 파일

- `scripts/setup.mjs`
- `scripts/hub-ensure.mjs`
- `hub/server.mjs`
- `bin/triflux.mjs`
- `hub/team/cli.mjs`
- `hub/team/session.mjs`
- `skills/tfx-team/SKILL.md`

### 의도된 변경 요지

- SessionStart에서 Hub ensure를 포그라운드 흐름과 분리해 완전 비동기로 돌리는 방향
- `/status` 기준 probe 후 detached start
- `hub/server.mjs`에 `/health`, `/healthz` 추가
- Hub 탐지/기동/상태 판정 강건화 일부 반영
- Shift 이전 이동을 위한 대체 키 바인딩 추가
- `skills/tfx-team/SKILL.md`에 preflight 요약 출력 정책 반영

## 사용자 결정사항 / 범위 고정

- 현재 직접 범위는 Claude `/tfx-team` 관련 전체다.
- `codex-team` 런타임은 이번 턴의 직접 범위에서 제외한다.
- Claude 범위에서는 문서뿐 아니라 관련 동작과 출력 정책까지 수정 가능하다.
- 브랜치 전략은 `dev`에서 직접 진행이다.
- 커밋은 단계별로 남겨야 한다.
- 후속 구현 전에 기존 로컬 문서와 공식 Claude Code 문서를 source of truth로 삼아야 한다.

## 현재 코드 상태 / 워크트리 상태

### Modified

- `bin/triflux.mjs`
- `hub/server.mjs`
- `hub/team/cli.mjs`
- `hub/team/session.mjs`
- `scripts/setup.mjs`
- `skills/tfx-team/SKILL.md`

### Untracked

- `docs/handoff/01-teammate-spawn-deepdive.md`
- `docs/handoff/02-teammate-lifecycle-state.md`
- `docs/handoff/03-alternative-registration-paths.md`
- `docs/handoff/05-triflux-v2.2-session-handoff.md`
- `scripts/hub-ensure.mjs`

### 추가 컨텍스트

- deep-interview 컨텍스트 스냅샷: `.omx/context/skill-scope-separation-20260311T034501Z.md`
- 현재 워크트리는 아직 정리/커밋 완료 상태가 아니다.
- 기존 `05-triflux-v2.2-session-handoff.md`는 이번 세션 사실보다 과장된 내용이 섞여 있어 재정리 대상이었다.

## 미해결 이슈와 리스크

- `teamKill()` fallback이 전체 `tfx-team-*` 세션을 잡아버릴 수 있는 위험이 남아 있다.
- 일부 모듈에 Hub 포트 `27888` 하드코딩이 남아 있어 non-default port 운용 시 오판 여지가 있다.
- Hub off 시 직접 Bash 폴백 경로로 내려가면 Native Team 워커 UI가 사라진다는 구조적 한계가 있다.
- 요구사항이 이미 문서에 있었는데 다시 질문한 점은 프로세스 리스크였다. 다음 작업에서도 문서 우선 확인 원칙이 무너지면 같은 비효율이 반복된다.
- 공식 문서를 실제로 대조하기 전까지는 "현재 구현이 사용자 요구와 완전히 정렬되었다"고 볼 수 없다.

## 다음 세션 권장 진행 순서

1. 로컬 PRD와 handoff 문서를 먼저 읽고 요구사항 매트릭스를 만든다.
2. 공식 Claude Code 문서 5종을 실제로 확인해 로컬 문서와 충돌 여부를 정리한다.
3. Claude `/tfx-team` 범위에서 반드시 필요한 수정과 `codex-team`으로 미뤄야 할 수정을 분리한다.
4. 현재 워크트리 변경을 성격별로 잘라 단계별 커밋 계획을 세운다.
5. Hub 복구 경로, preflight 출력 정책, Shift 네비게이션 관련 수정부터 우선 마감한다.
6. `teamKill()` fallback과 포트 하드코딩 잔존 문제의 Claude 범위 포함 여부를 결정한 뒤 후속 패치로 넘긴다.

## 참고 문서 / 소스 오브 트루스

### 로컬 문서

- `docs/tfx-team-v2.1-prd-reference.md`
- `.omc/plans/tfx-team-v2.1-prd.md`
- `.omc/plans/tfx-team-v2.2-prd.md`
- `.omc/plans/tfx-team-v2-plan.md`
- `docs/native-teams-insights.md`
- `docs/insights/native-agent-teams-research.md`
- `.omc/handoff/tfx-team-prd.md`
- `.omc/handoff/tfx-team-test.md`
- `skills/tfx-team/SKILL.md`

### 공식 Claude Code 문서

- `https://code.claude.com/docs/ko/agent-teams`
- `https://code.claude.com/docs/ko/skills`
- `https://code.claude.com/docs/ko/hooks-guide`
- `https://code.claude.com/docs/ko/cli-reference`
- `https://code.claude.com/docs/ko/settings`

## 후속 담당자 체크리스트

- [ ] 로컬 PRD와 handoff 문서를 모두 읽고 요구사항 매트릭스를 작성했다.
- [ ] 공식 Claude Code 문서 5종을 실제로 대조했다.
- [ ] Claude `/tfx-team` 범위와 `codex-team` 범위를 다시 섞지 않도록 작업 경계를 문서화했다.
- [ ] 현재 modified/untracked 파일을 성격별로 분류했다.
- [ ] 단계별 커밋 계획을 세웠다.
- [ ] Hub 복구 경로의 재현 시나리오와 검증 기준을 정리했다.
- [ ] preflight 출력 정책과 실제 구현이 일치하는지 확인했다.
- [ ] Shift 네비게이션 이슈와 Hub off 폴백 이슈를 서로 분리해 검증했다.
