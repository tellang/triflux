# triflux Execution Modes

> 상태: Draft  
> 작성일: 2026-04-02  
> 목적: triflux에서 Codex, Gemini, Claude를 어떤 실행 표면으로 호출할지 빠르게 판단하기 위한 운영 기준

---

## 1. 네 가지 실행 경로

| 모드 | 호출 표면 | 실제 실행체 | 파일 수정 가능 | 결과 수집 | 적합한 작업 |
|---|---|---|---|---|---|
| A. `tfx-route.sh` | 단일 CLI 라우팅 | `codex exec` / `gemini -p` / `claude` one-shot | 제한적 또는 불안정 | stdout/stderr | 분석, 리뷰, 계획, 짧은 문서화 |
| B. `tfx multi --teammate-mode headless` | headless 허브 기반 병렬 실행 | Hub + worker launcher | 기본적으로 텍스트 중심 | hub 상태 + handoff 파일 | 다중 에이전트 토론, 병렬 분석, 교차 검토 |
| C. direct `codex` / `gemini` in `psmux` | 대화형 세션 | 장기 실행 CLI 세션 | 가능 | git diff, 커밋, pane capture | 실제 구현, 테스트, 리팩터링 |
| D. native subagent | Codex/Claude 네이티브 서브에이전트 | 현재 세션 내부 도구 실행 | 가능 | 직접 반환값 | 탐색, 검증, 제한된 구현, 리뷰 |

---

## 2. 각 모드의 특징

### A. `tfx-route.sh`

```bash
bash ~/.claude/scripts/tfx-route.sh executor "구현 방향을 분석해라" codex53_high 900
```

- 장점
- 가장 단순하다.
- timeout, heartbeat, MCP 필터링 같은 운영 편의가 이미 들어 있다.
- CLI별 프로파일 라우팅을 중앙화하기 쉽다.
- 단점
- one-shot 성격이 강해서 긴 수정 작업에는 약하다.
- 출력이 좋아 보여도 실제 파일 변경이나 커밋 보장은 약하다.
- 프롬프트가 길어질수록 재현성과 회복력이 떨어진다.
- 권장 용도
- 리뷰, 설계 검토, 문서 초안, 실행 계획, 짧은 변환 작업.

### B. `tfx multi` headless

```bash
tfx multi --teammate-mode headless \
  --assign 'codex:라우팅 구조를 분석해라:architect' \
  --assign 'gemini:반례를 찾아라:critic'
```

- 장점
- 병렬성이 가장 좋다.
- Hub를 통해 상태 추적, handoff, dashboard 연동이 가능하다.
- 모델별 관점을 모아 합의나 비교에 강하다.
- 단점
- 실행 경로가 길고 디버깅 표면이 많다.
- 기본 성격은 여전히 텍스트 산출 중심이라 직접 구현에는 부적합할 수 있다.
- headless, route, hub, psmux 중 어느 계층이 문제인지 분리 진단이 필요하다.
- 권장 용도
- 다중 모델 합의, 리서치 분산, 리뷰 분업, 논쟁적 의사결정.

### C. direct `codex` / `gemini` in `psmux`

```bash
prompt=$(cat .codex-swarm/prompts/prompt-hook-integration.md)
codex -p codex53_xhigh --dangerously-bypass-approvals-and-sandbox "$prompt"
```

- 장점
- 실제 코드 읽기, 수정, 테스트, 커밋까지 이어질 수 있다.
- 장시간 자율 실행과 worktree 격리에 적합하다.
- 구현 작업에서는 가장 강한 실행 표면이다.
- 단점
- 프로세스 수명 관리가 어렵다.
- 완료 감지, 실패 감지, pane 수집이 별도 운영 로직을 요구한다.
- 잘못된 런처 패턴을 쓰면 즉시 종료하거나 메인 리포지토리를 오염시킬 수 있다.
- 권장 용도
- 구현, 리팩터링, 테스트 보강, 실제 릴리즈 전 수정.

### D. native subagent

- 장점
- 현재 세션 컨텍스트를 공유한다.
- 외부 허브나 별도 런처 없이 빠르게 병렬 탐색이 가능하다.
- 반환값 통합과 후속 지시가 간단하다.
- 단점
- 외부 CLI 전용 관찰값이나 실제 장기 실행 프로세스 관리에는 약하다.
- 세션 내부 맥락에 강하게 묶여 있어 독립 재현성이 낮을 수 있다.
- 권장 용도
- 코드베이스 탐색, 보조 구현, 검증, 짧은 병렬 태스크.

---

## 3. Dashboard / Lite / Headless / No Dashboard

| 표면 | 목적 | 장점 | 단점 | 권장 상황 |
|---|---|---|---|---|
| Full dashboard | 실시간 팀 모니터링 | 상태 가시성이 가장 좋다 | 화면 점유가 크다 | 수동 운영, 데모, 장기 관찰 |
| Lite dashboard | 저비용 상태 확인 | 간결하고 부담이 적다 | 세부 로그는 약하다 | 작은 터미널, 보조 모니터링 |
| Headless | 무인 실행 | 자동화에 적합 | 관찰성이 떨어진다 | CI 성격 실행, 백그라운드 런 |
| No dashboard | 최소 표면 | 로그만 남겨 단순하다 | 추적이 가장 어렵다 | 스크립트 통합, 실험적 호출 |

---

## 4. 모델별 실무 권장

### Codex

- 강점
- 구현, 수정, 테스트, diff 기반 반복에 강하다.
- 약점
- one-shot 경로에서는 실제 수정 가능 여부를 과신하기 쉽다.
- 권장
- 구현은 가능하면 mode C.
- 분석/문서는 mode A 또는 D.

### Gemini

- 강점
- 비교 관점, 빠른 대안 제시, 문서 초안에 유리하다.
- 약점
- 파일 변경 보장은 실행 표면에 크게 의존한다.
- 권장
- 병렬 분석은 mode B.
- 짧은 문서화는 mode A.

### Claude / native agent

- 강점
- 현재 세션과 가장 자연스럽게 결합된다.
- 약점
- 외부 CLI 조합보다 관점 다양성은 떨어진다.
- 권장
- 탐색, 검증, 오케스트레이션 보조는 mode D.

---

## 5. 운영 규칙

### 구현 작업

- 텍스트 산출이 아니라 실제 코드 변경이 목적이면 mode C 또는 D를 우선한다.
- `tfx-route.sh` 결과를 곧바로 "파일 생성 완료"로 간주하지 않는다.

### 스웜 런처

- 금지 패턴
- `codex exec`를 구현 전용 스웜 런처로 쓰지 않는다.
- `codex --full-auto < prompt.md`처럼 stdin 파이프에 의존하지 않는다.
- `-c 'model=...'` 하드코딩으로 프로필 체계를 우회하지 않는다.

- 권장 패턴

```bash
prompt=$(cat prompt.md)
codex -p codex53_xhigh --dangerously-bypass-approvals-and-sandbox "$prompt"
```

### 완료 감지

- direct CLI swarm은 pane 출력만으로 완료를 확정하지 않는다.
- `git diff`, `git status`, 테스트 결과, 커밋 여부를 함께 본다.
- polling 스크립트나 상태 집계 명령을 별도로 두는 편이 안전하다.

---

## 6. 권장 선택표

| 질문 | 권장 모드 |
|---|---|
| 코드 수정이 필요한가 | C 또는 D |
| 여러 모델 관점이 필요한가 | B |
| 짧은 분석/문서 응답이면 충분한가 | A |
| 현재 세션 문맥을 그대로 활용해야 하는가 | D |
| 장시간 자율 구현이 필요한가 | C |

---

## 7. 현재 기준 결론

- 분석/리뷰/문서화는 A/B/D가 효율적이다.
- 실제 구현은 C/D가 안정적이다.
- swarm 운영에서 가장 큰 리스크는 "텍스트 실행 표면"과 "실제 구현 표면"을 혼동하는 것이다.
- 설치/doctor/hook 계층은 잘못된 plugin root를 settings에 기록하지 않도록 방어해야 한다.
