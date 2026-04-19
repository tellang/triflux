# 스택 공존 가이드 — gstack + superpowers + triflux

## 공존 원칙

- 세 시스템은 흡수/대체 관계가 아니라 레이어 분리 관계다.
- triflux 코어는 gstack·superpowers에 **절대 의존하지 않는다** (단방향: gstack/sp → triflux만 허용).
- 80+ 스킬이 겹칠 때 기본 진입점은 `tfx-*`다. gstack/sp는 명시 호출 또는 워크플로우 통합 시점에만 쓴다.
- 각 시스템의 책임 경계를 침범하지 않는다. 동일 기능이 여러 곳에 있으면 아래 우선순위 규칙을 따른다.
- 스택 공존 정책 변경은 이 파일만 수정한다. 개별 스킬에 공존 로직을 분산하지 않는다.

## 레이어 분리표

| 레이어 | 시스템 | 역할 | 진입 방식 |
|--------|--------|------|-----------|
| **무대 (Stage)** | gstack | 워크플로우 게이트 — 언제 어떤 작업을 부를지 결정 | `/ship`, `/qa`, `/checkpoint`, `/investigate` 등 |
| **엔진 (Engine)** | superpowers | 리뷰 프리미티브 — 입력: diff, 출력: verdict | `/review`, `/design-review`, `/security-review` |
| **백엔드 (Backend)** | triflux | 오케스트레이션 — 병렬 worker 배분, 모델 선택, 실행 | `/tfx-*` 스킬 전체 |

> 사용자 → gstack(게이트) → triflux(실행) → superpowers(판정) → gstack(결과 처리)

## 의존 방향 규칙

```
gstack  →  triflux  (허용)
gstack  →  superpowers  (허용)
superpowers  →  triflux  (허용)

triflux  →  gstack  (금지)
triflux  →  superpowers  (금지)
```

**Fallback 규칙**

| 상황 | Fallback |
|------|---------|
| gstack 스킬 없음 | `tfx-auto`로 직접 라우팅 |
| superpowers review 실패 | triflux `--mode consensus` 3-CLI 합의로 대체 |
| triflux headless guard 차단 | 오류 즉시 서페이스. gstack/sp 우회 금지 |

## 책임 매트릭스

| 기능 | Owner | 근거 |
|------|-------|------|
| **Review** (코드 판정) | superpowers | 입력 diff → 출력 verdict 프리미티브. 가장 단순한 경계 |
| **Plan** (작업 설계) | triflux (`tfx-plan`, `tfx-deep-plan`) | 멀티모델 합의 + PRD 생성 포함 |
| **Checkpoint** (진행 상태 스냅샷) | gstack (`/checkpoint`) | 워크플로우 상태 관리는 무대 레이어 책임 |
| **Worktree** (격리 실행) | triflux (`tfx-swarm`) | PRD별 worktree + auto merge = 오케스트레이션 |
| **QA / 검증** | gstack (`/qa`) → triflux (`tfx-qa`) 팬아웃 | gstack이 게이트, triflux가 병렬 실행 |
| **Ship / 배포** | gstack (`/ship`) | 배포 게이트는 무대 레이어 |
| **Brainstorm** | triflux (`tfx-auto --mode consensus --shape debate`) | 우선순위 규칙 §충돌 해소 참조 |

## 워크플로우 통합 예시 — 영상 발표자 패턴

```
브레인스토밍
  → sc:brainstorm 또는 tfx-auto --mode consensus --shape debate
  ← 아이디어 리스트

라이팅플랜
  → /office-hours  (gstack 게이트: 발표자 영상 전용)
  → tfx-deep-plan  (triflux: PRD 생성)
  ← plan.md

워크트리 생성
  → tfx-swarm plan.md  (triflux 백엔드: worktree 격리 실행)
  ← shard별 브랜치

서브에이전트 실행
  → tfx-swarm 내부 자동 dispatch  (triflux)
  → 각 worker가 tfx-auto로 구현

리뷰
  → superpowers /review  (sp 엔진: diff → verdict)
  → gstack /checkpoint   (gstack 무대: 스냅샷 기록)
  ← 최종 머지 승인
```

## 충돌 해소 — 동일 기능이 여러 곳에 있을 때

| 기능 | 1순위 | 2순위 | 3순위 |
|------|-------|-------|-------|
| Brainstorm / 아이디어 발산 | `tfx-auto --mode consensus --shape debate` | `sc:brainstorm` | gstack 없음 |
| Plan / 설계 | `tfx-deep-plan` | `sc:pm` | gstack `/investigate` |
| Review / 코드 판정 | superpowers `/review` | `tfx-deep-review` | `tfx-auto --mode consensus` |
| QA / 테스트 검증 | gstack `/qa` → `tfx-qa` | `tfx-deep-qa` | — |
| Checkpoint / 스냅샷 | gstack `/checkpoint` | — | — |
| 문서 작성 | `sc:document` 또는 `/writer` | — | — |

> 규칙: 기능 경계가 명확하면 owner 시스템 1순위. 경계가 모호하면 triflux 우선.

## 안티패턴

| 패턴 | 문제 | 올바른 방법 |
|------|------|------------|
| triflux 코어가 gstack 스킬을 `spawn`으로 호출 | 역방향 의존 → 순환 참조 가능성 | triflux는 결과만 반환. gstack이 triflux를 호출하는 방향으로 |
| superpowers `/review` 스킬을 triflux 코어에 `import` | sp → tfx 단방향 위반 | triflux는 자체 review primitive 사용 또는 hook으로 sp 결과 수신 |
| 80+ 스킬 키워드 충돌 시 임의 선택 | 비결정적 라우팅 | 이 문서 §충돌 해소 표에서 1순위를 명확히 따름 |
| gstack `/ship`이 triflux를 우회하고 codex 직접 호출 | headless-guard 차단 | gstack → triflux → headless 경로 필수 |
| 발표자 영상 워크플로우에서 tfx-auto만 사용 | /office-hours 게이트 없이 배포 → QA 누락 | gstack /office-hours → tfx-deep-plan → tfx-swarm 순서 준수 |
| sp 판정 없이 triflux auto-merge | 미검증 코드 머지 | swarm 완료 후 superpowers review verdict 수신 확인 후 merge |
