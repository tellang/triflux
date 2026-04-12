# PRD: 대시보드 통일 + UX 리뉴얼 + 실시간 관제

## 문제

대시보드 TUI가 4개 파일/3249줄에 걸쳐 분산되어 있다.
공통 로직(워커 상태, 키 입력, ANSI 렌더링)이 중복되고,
UX 변경 시 2~3곳을 동시에 수정해야 한다.

### 현재 구조

| 파일 | 줄 | 역할 |
|------|-----|------|
| tui.mjs | 2020 | 풀 대시보드 (alt-screen, 3-tier 레이아웃) |
| tui-lite.mjs | 606 | 경량 대시보드 (단일 패널) |
| tui-viewer.mjs | 521 | WT 뷰어 프로세스 (tui/tui-lite 라우터) |
| dashboard-open.mjs | 102 | 탭/패인 열기 유틸 |

## 목표

1. **ISSUE-11**: 단일 core + 2 렌더러(full/lite)로 통일
2. **ISSUE-14**: k9s+lazygit+btop 스타일 UX/UI 리뉴얼
3. **실시간 관제**: Synapse 이벤트 → TUI 시각화

## 설계

### Phase 1: Core 추출 (ISSUE-11)

```
tui-core.mjs (신규, ~400줄)
├── WorkerStateManager — 워커 상태 추적/갱신
├── KeyHandler — 키 입력 파싱/디스패치
├── LayoutEngine — 행/열 계산, 뷰포트
└── RenderScheduler — dirty-row 갱신, 프레임 제어

tui.mjs (리팩터, ~800줄) — full 렌더러
├── import { core } from "./tui-core.mjs"
├── Tier1/2/3 레이아웃 조합
├── Help overlay, flash, attach
└── Alt-screen 관리

tui-lite.mjs (리팩터, ~300줄) — lite 렌더러
├── import { core } from "./tui-core.mjs"
├── 단일 패널 레이아웃
└── 기본 키바인딩
```

**추출 대상 공통 로직:**
- `sanitizeTextBlock`, `stripCodeBlocks` — 텍스트 정규화
- `buildStatusBadge`, `progressBar` — 상태 표시 위젯
- `selectRelative`, `ensureSelectedWorker` — 워커 선택
- `scrollDetail`, `followTail` — 스크롤 상태
- `attachLimiter`, `buildDashboardAttachRequest` — attach 로직
- `buildTier1` — 상단 고정 헤더 (버전, 경과시간)

### Phase 2: UX 리뉴얼 (ISSUE-14)

디자인 레퍼런스: k9s(Kubernetes), lazygit(Git), btop(시스템 모니터)

**적용 패턴:**
- k9s: 리소스 목록 + 상세 분할, 컬러 상태 뱃지, vim 키바인딩
- lazygit: 패널 기반 레이아웃, 탭 전환, 컨텍스트 메뉴
- btop: 실시간 그래프, 프로그레스 바, 시스템 메트릭

**구체적 변경:**
- 워커 목록에 미니 스파크라인 (토큰 소비 추이)
- 상태 뱃지 컬러 통일 (Catppuccin Mocha 팔레트, 기존 ansi.mjs 활용)
- vim 모션 확장 (gg, G, /, n/N 검색)
- 패널 리사이즈 (좌우 드래그 대신 H/L로 비율 조정)

### Phase 3: 실시간 관제 (Synapse 연동)

```
tui-synapse.mjs (신규, ~200줄)
├── SynapseEventStream — HTTP SSE/polling
├── MetricsCollector — 토큰, 지연시간, 성공률
└── SparklineRenderer — 실시간 미니 차트

통합:
tui-core → SynapseEventStream 구독
tui.mjs Tier1에 실시간 메트릭 표시
```

**synapse-http.mjs**(이미 존재)의 `fireAndForgetSynapse`를 양방향으로 확장:
- 현재: 이벤트 송신만 (fire-and-forget)
- 추가: 이벤트 수신 (GET /events, polling 또는 SSE)

## Shard 분해 (스웜용)

| Shard | Agent | 의존성 | 파일 |
|-------|-------|--------|------|
| core-extract | codex | 없음 | hub/team/tui-core.mjs (신규) |
| tui-refactor | codex | core-extract | hub/team/tui.mjs |
| lite-refactor | codex | core-extract | hub/team/tui-lite.mjs |
| viewer-simplify | codex | tui-refactor, lite-refactor | hub/team/tui-viewer.mjs |
| ux-widgets | gemini | core-extract | hub/team/tui-widgets.mjs (신규) |
| synapse-stream | codex | 없음 | hub/team/tui-synapse.mjs (신규) |
| synapse-integrate | claude | synapse-stream, tui-refactor | hub/team/tui.mjs Tier1 |
| tests | codex | 전체 | tests/unit/tui-core.test.mjs |

## 수용 기준

- [ ] tui.mjs와 tui-lite.mjs 간 코드 중복 < 50줄
- [ ] 기존 키바인딩 전부 동작 (j/k, Enter, Tab, g/G, PgUp/PgDn, h, q)
- [ ] headless.mjs가 createLogDashboard를 정상 호출
- [ ] tui-viewer.mjs가 full/lite 전환 정상 동작
- [ ] Synapse 이벤트 수신 시 Tier1에 실시간 메트릭 표시
- [ ] 전체 테스트 통과
