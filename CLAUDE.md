# triflux — Claude Code 운영 가이드

## 자연어 → 스킬 라우팅

사용자가 스킬명을 모르더라도 자연어로 요청하면 아래 규칙에 따라 적절한 스킬을 내부적으로 호출한다.

### 1차 분류: 행동 유형

| 의도 | 한국어 | 영어 | 스킬 |
|------|--------|------|------|
| 구현 | 만들어, 추가해, 구현해, 짜줘, 개발해, 넣어줘, 붙여줘 | implement, build, add, create, develop | tfx-auto |
| 수정 | 고쳐, 수정해, 바꿔, 변경해, 패치해, 업데이트해 | fix, modify, change, patch, update | tfx-auto |
| 리뷰 | 봐줘, 리뷰해, 검토해, 확인해, 괜찮아?, 이상 없어? | review, check, look at, examine, is this ok | tfx-review |
| 분석 | 분석해, 파악해, 어떻게 돌아가?, 구조가 뭐야, 해부해 | analyze, how does it work, structure, dissect | tfx-analysis |
| 계획 | 계획, 어떻게 하지, 순서, 단계, 설계해, 로드맵 | plan, how should I, steps, design, roadmap | tfx-plan |
| 검색 | 찾아, 어디있어, 파일 찾아, 위치, 어디서 쓰여 | find, where is, locate, which file | tfx-find |
| 리서치 | 조사해, 알아봐, 최신, 공식문서, 뭐가 좋아, 비교해봐 | research, look up, latest, docs, compare options | tfx-research |
| 테스트 | 테스트, 검증, 돌려봐, 통과시켜, QA | test, verify, run tests, make pass, QA | tfx-qa |
| 정리 | 정리해, 슬롭 제거, 불필요한 거 지워, 클린업, 다이어트 | clean up, remove slop, simplify, trim | tfx-prune |
| 토론 | 뭐가 나을까, 비교해, A vs B, 장단점, 트레이드오프 | which is better, compare, pros cons, tradeoff | tfx-debate |

### 2차 분류: 깊이 수정자

| 수정자 | 자연어 신호 | 효과 |
|--------|-----------|------|
| 기본 | (없음), 빠르게, 간단히, 얼른 | Light 스킬 사용 |
| 깊이 | 제대로, 꼼꼼히, 철저히, 심층, 확실하게, 편향 없이 | Deep 스킬로 에스컬레이션 |
| 합의 | 3자, 교차, 합의, 다각도, 여러 관점, 세 모델 다 | consensus 프로토콜 활성화 |
| 반복 | 끝까지, 멈추지마, 완료될때까지, 다 될때까지, ralph | persist 모드 |
| 자율 | 알아서, 자동으로, 그냥 해, autopilot, 손 안 대고 | autopilot 모드 |

### 라우팅 매트릭스 (행동 x 깊이 → 스킬)

| 행동 \ 깊이 | 기본 | 깊이 | 합의 | 반복 | 자율 |
|------------|------|------|------|------|------|
| 리뷰 | tfx-review | tfx-deep-review | tfx-deep-review | — | — |
| 분석 | tfx-analysis | tfx-deep-analysis | tfx-deep-analysis | — | — |
| 계획 | tfx-plan | tfx-deep-plan | tfx-deep-plan | — | — |
| QA | tfx-qa | tfx-deep-qa | tfx-deep-qa | — | — |
| 리서치 | tfx-research | tfx-deep-research | tfx-deep-research | — | — |
| 구현 | tfx-auto | tfx-autopilot | tfx-fullcycle | tfx-persist | tfx-autopilot |
| 토론 | tfx-debate | tfx-panel | tfx-panel | — | — |

### 3차 분류: 모델 선호

| 신호 | 라우팅 |
|------|--------|
| codex한테, codex가, codex로 | TFX_CLI_MODE=codex |
| gemini한테, gemini가, gemini로 | TFX_CLI_MODE=gemini |
| 셋 다, 3개 다, 전부 동원 | tfx-consensus / tfx-multi |
| (없음) | 자동 판단 |

### 신뢰도 기반 행동

| 신뢰도 | 조건 | 행동 |
|--------|------|------|
| 높음 | 의도 + 깊이 모두 명확 | 자동으로 Skill 호출 |
| 중간 | 의도 명확, 깊이 불명확 | Light 기본값 사용 |
| 낮음 | 의도 불명확 | 1문장 확인 질문 |

### 트리거 충돌 해소

| 충돌 | 해소 규칙 |
|------|----------|
| ralph vs persist | ralph은 persist alias. 라우팅은 persist로 통합 |
| auto vs autopilot | "auto" 단독 → tfx-auto. "알아서 해/자동으로" → tfx-autopilot |
| analysis vs /analyze | /analyze 커맨드 → tfx-auto. "분석해" 자연어 → tfx-analysis |
| research vs /research | /research 커맨드 → tfx-auto. "조사해" 자연어 → tfx-research |
| 검색 vs find vs research | "코드에서 찾아/어디있어" → tfx-find. "알아봐/조사해" → tfx-research |

### 복합 의도 처리

여러 의도가 한 문장에 섞인 경우:
* "구현하고 리뷰까지" → tfx-auto(구현) → 완료 후 교차 리뷰(cross-review hook)
* "계획 세우고 바로 실행" → tfx-plan → 승인 후 tfx-auto
* "3자 합의로 리뷰하고 끝까지 수정" → tfx-deep-review → 이슈 발견 시 tfx-persist

## 맥락 이탈 판단

현재 세션 맥락과 무관한 요청이 감지되면 psmux 격리를 제안한다.

| 확신도 | 신호 | 행동 |
|--------|------|------|
| 확실 | "새 탭", "별도로", "새 세션", "깨끗하게" | 바로 psmux spawn |
| 높음 | 다른 프로젝트/디렉토리/스택 언급 | AskUserQuestion으로 분리 제안 |
| 중간 | 작업 유형 전환, 무관한 모듈 언급 | 분리 제안 + 현재 세션 옵션 |
| 낮음 | 현재 작업 연장, 부연 질문 | 현재 세션 유지 |

## psmux/WT 필수 규칙

**psmux 세션·WT 패인을 생성/조작/정리할 때 반드시 `tfx-psmux-rules` 스킬을 참조하라.**
RULE 5(WT 프리징 방지)를 위반하면 WT 전체가 응답 불능이 되어 모든 탭이 유실된다.
핵심: exit → sleep 2 → kill 순서. 바로 kill 절대 금지.

## 교차 검증 규칙

* Claude 작성 코드 → Codex 리뷰
* Codex 작성 코드 → Claude 리뷰
* 동일 모델 self-approve 금지
* git commit 전 미검증 파일 감지 시 nudge
