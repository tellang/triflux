# Triflux CTO Tray Dropdown Design

## 1. Objective
기존 `systray2` 기반의 텍스트 메뉴를 대체하여, macOS 상단바(Status Bar)에서 작동하는 시각적인 대시보드 형태의 드롭다운(Popover) UI를 구축합니다. 
이를 통해 Triflux Hub, CTO 세션 트리, Gateway(MCP) 상태를 직관적으로 모니터링하고 제어할 수 있습니다.

## 2. Architecture & Stack
Triflux는 Node.js 기반 CLI/데몬 도구이므로, 커스텀 HTML UI를 상단바 팝오버로 띄우기 위해 다음과 같은 아키텍처를 채택합니다.

* **Frontend (UI)**: HTML/CSS/Vanilla JS (Liquid Glassmorphism 스타일)
  * `hub/public/tray.html` 형태로 서빙 (디자인된 v7 목업 기반)
  * 모델 식별 색상 적용 (Claude: `#d19a66`, Codex: `#ffffff`, AGY: `#61afef`)
* **Backend (Data Provider)**: `tfx-hub` (`server.mjs`)
  * `/api/tray-state` (또는 기존 `/api/qos-stats` 확장) 엔드포인트를 통해 세션 트리 및 MCP 상태 데이터를 JSON으로 제공
  * 포커스 이동 액션을 위한 엔드포인트 제공 (e.g., `/api/focus-session?id=...`)
* **Tray Host (Native Bridge)**: 
  * 기존 `systray2`를 제거하고, 가벼운 **macOS Native Webview (Swift/WKWebView 래퍼)** 또는 **Electron (menubar)** 기반의 별도 프로세스를 띄워 트레이 아이콘과 팝오버 창을 관리합니다.
  * *참고: 로컬 테스트 후 퍼블리시를 고려하여, 초기에는 배포가 용이한 래퍼 스크립트를 사용합니다.*

## 3. UI/UX Components
드롭다운은 크게 2개의 탭(Segmented Control)으로 구성됩니다.

### 3.1. Sessions & CTO Tab
* **CTO North Star (Root)**
  * 경로, 구동 모델(Claude), 환경(tmux 등) 배지
  * UDS ID 복사 버튼, iTerm2 포커스 액션 버튼
* **Child Workers/Runners (Tree View)**
  * 들여쓰기 및 트리 라인을 통해 CTO에 종속된 워커(Codex/AGY) 표시
  * UDS 및 Session ID 복사 버튼, 포커스 버튼

### 3.2. Gateway (MCP) Tab
* **MCP 서버 카드 목록** (e.g., `tfx-hub`, `github`)
  * 통신 방식(Stdio, SSE 등) 배지 표기
* **모델별 상태 인디케이터**
  * 각 MCP 카드 하단에 Claude, Codex, AGY 각각의 Active/Idle 상태를 LED Dot 형태로 표시

## 4. Data Flow & Interaction
1. **상태 폴링**: 트레이 UI가 열릴 때 및 열려있는 동안 주기적으로 `tfx-hub`에서 상태 JSON을 Fetch.
2. **복사 액션 (Copy)**: ID/UDS 텍스트 클릭 시 브라우저 클립보드 API(`navigator.clipboard`) 활용.
3. **포커스 액션 (Focus)**: 
   * "Focus" 버튼 클릭 시 `tfx-hub`의 `/api/focus-session` 호출.
   * `tfx-hub`는 전달받은 세션 ID/UDS를 기반으로 `tmux` 윈도우 선택 및 `osascript` 등을 통해 iTerm2 탭으로 시스템 포커스 전환.

## 5. Error Handling & Fallbacks
* **Hub 오프라인 상태**: `tfx-hub` 데몬이 꺼져 연결할 수 없는 경우, UI 내에 "Disconnected" 상태를 명확히 표시하고 재연결(새로고침) 버튼을 제공.
* **클립보드 권한**: 복사 실패 시 시각적 피드백(Tooltip 에러) 표시.

## 6. Testing Strategy
* UI 단독 렌더링 테스트 (Mock Data 주입)
* `tfx-hub` API 연동 통합 테스트
* macOS 환경에서의 Native Popover 동작(클릭 외부 영역 터치 시 닫힘 등) 검증
