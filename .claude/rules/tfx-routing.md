# 자연어 → 스킬 라우팅

사용자가 스킬명을 모르더라도 자연어로 요청하면 아래 규칙에 따라 적절한 스킬을 호출한다.

## 행동 유형 → 스킬 매핑

| 의도 | 자연어 신호 | 스킬 |
|------|-----------|------|
| 구현/수정 | 만들어, 고쳐, 구현해, 짜줘, 수정해, 바꿔 | tfx-auto |
| 리뷰 | 봐줘, 리뷰해, 검토해, 괜찮아? | tfx-review |
| 분석 | 분석해, 어떻게 돌아가?, 구조가 뭐야 | tfx-analysis |
| 계획 | 계획, 어떻게 하지, 설계해 | tfx-plan |
| 검색 | 찾아, 어디있어, 파일 찾아 | tfx-find |
| 리서치 (빠른) | 검색해줘, 찾아봐, 공식문서, 이거 뭐야 | tfx-research |
| 리서치 (자율) | 자율 리서치, 검색하고 정리해, research and plan | tfx-autoresearch |
| 테스트 | 테스트, 검증, 돌려봐, QA | tfx-qa |
| 정리 | 정리해, 슬롭 제거, 클린업 | tfx-prune |
| 토론/비교 | 뭐가 나을까, 비교해, A vs B | tfx-auto (`--mode consensus --shape debate`) |
| 합의 | 합의로 분석해, 3자 합의, consensus | tfx-auto (`--mode consensus`) |
| 패널 | panel, 패널, 전문가 의견, expert panel | tfx-auto (`--mode consensus --shape panel`) |

## 깊이 수정자

| 수정자 | 신호 | 효과 |
|--------|------|------|
| 기본 | (없음), 빠르게, 간단히 | Light 스킬 |
| 깊이 | 제대로, 꼼꼼히, 철저히 | Deep 스킬 (tfx-deep-*). 예외: tfx-deep-interview는 Gemini 단독 |
| 합의 | 3자, 교차, 다각도 | `tfx-auto --mode consensus` |
| 반복 | 끝까지, 멈추지마, ralph | `--retry ralph` (Phase 3 true state machine, `.claude/rules/tfx-escalation-chain.md` 참조) |
| 승격 | 알아서 승격, 안 되면 더 강한 모델 | `--retry auto-escalate` (Phase 3 CLI 체인 승격) |
| 자율 | 알아서, 자동으로, autopilot | autopilot 모드 |

## CLI 라우팅

headless-guard가 `codex exec` / `gemini -y -p` 직접 호출을 차단한다. tfx 스킬 경유 필수.

**Layer 1 — Light** (tfx-route.sh → 단일 CLI)

| 스킬 | CLI | 용도 |
|------|-----|------|
| tfx-auto | 자동 | 통합 진입점 |
| tfx-codex | Codex | Codex 전용 |
| tfx-gemini | Gemini | Gemini 전용 |
| tfx-autopilot | Codex→검증 | 단일 파일, 5분 이내 |
| tfx-autoroute | 자동 승격 | 실패→더 강한 모델 |

**Layer 2 — Deep** (headless 3-CLI 합의)

tfx-deep-review, tfx-deep-qa, tfx-deep-plan, tfx-deep-research, tfx-auto (`--mode consensus --shape consensus|debate|panel`), tfx-fullcycle, tfx-persist

호환 alias:
- `tfx-consensus` → `tfx-auto --mode consensus`
- `tfx-debate` → `tfx-auto --mode consensus --shape debate`
- `tfx-panel` → `tfx-auto --mode consensus --shape panel`
- 위 3개 alias 는 deprecated 이며 stderr 경고 + stdout `[DEPRECATED]` + `.omc/state/alias-usage.log` append 규약을 따른다

**Layer 3 — Remote/병렬**

| 스킬 | 용도 |
|------|------|
| tfx-multi | 2+개 태스크 headless 병렬 |
| tfx-swarm | PRD별 worktree + 다중 모델(Codex/Gemini/Claude) + 다중 기기(로컬+원격) |
| tfx-remote | Claude Code 원격 세션 (SSH, user-state hosts.json setup 필수; tfx-remote-spawn은 legacy alias) |

**Claude 네이티브** (CLI 불필요): tfx-find, tfx-forge, tfx-prune, tfx-index, tfx-setup, tfx-doctor, tfx-hooks, tfx-hub

자원 우선순위: remote-spawn > swarm > multi > Light > 로컬 단독

원격 hosts 설정은 user-state 경로만 참조한다: macOS/Linux `~/.config/triflux/hosts.json`, Windows `%APPDATA%\triflux\hosts.json`. 기존 source-tree `references/hosts.json` 은 라우팅 입력으로 사용하지 않으며 첫 실행 lazy auto-migration 대상이다.

## 충돌 해소

- ralph = persist alias
- "auto" 단독 → tfx-auto. "알아서 해" → tfx-autopilot
- "코드에서 찾아" → tfx-find. "알아봐" → tfx-research
- 복합 의도: "구현하고 리뷰까지" → tfx-auto → cross-review hook
- "합의해서 비교해" 류 요청은 alias 대신 기본적으로 `tfx-auto --mode consensus --shape debate` 로 fold 한다

## Q-Learning 동적 라우팅 (실험적)

- `TRIFLUX_DYNAMIC_ROUTING=true` 또는 `1` 설정 시 Q-Learning 기반 동적 스킬 라우팅 활성화
- `routing-weights.json` + Q-table로 스킬 선택 최적화
- 기본 비활성
