# 🚀 triflux v6.0.0: Lead-Direct Headless

이번 v6.0.0은 **Lead-Direct Headless** 아키텍처를 도입한 대규모 메이저 업데이트입니다. 기존의 래퍼 방식을 완전히 탈피하여 토큰 효율을 극대화하고, Windows Terminal과의 강력한 통합을 통해 차세대 멀티 모델 오케스트레이션 경험을 제공합니다.

## ⚠️ Breaking Changes
*   **아키텍처 혁신 (Slim Wrapper 제거):** 이전의 Agent slim wrapper를 제거하고, Lead가 `psmux`를 통해 CLI를 직접 실행하는 구조로 변경되었습니다. 이로 인해 래퍼 유지에 소모되던 **토큰 비용이 0**으로 절감되었습니다.
*   **CLI 진입점 변경:** headless 모드 실행 시 새로운 플래그 체계를 사용합니다.
    *   명령어: `triflux multi --teammate-mode headless --assign 'cli:prompt:role'`

## ✨ New Features
*   **Lead-Direct Headless 모드:** 아키텍처 최적화를 통해 지연 시간을 줄이고 실시간성을 강화했습니다.
*   **Windows Terminal 가로 분할(Horizontal Split):** Claude Code 실행 시 하단에 `psmux` 페인이 자동으로 생성되어 한 화면에서 팀의 상태를 즉시 확인할 수 있습니다.
*   **Progressive 모드:** 작업 진행 상황에 맞춰 페인이 하나씩 실시간으로 추가(split-window)되는 생동감 있는 UI를 제공합니다.
*   **triflux 공식 테마:**
    *   **Catppuccin Mocha** 색상 체계가 적용된 상태 표시줄 및 페인 테두리.
    *   Windows Terminal 전용 프로필(투명도 40/20) 자동 구성 지원.
*   **psmux 자동 환경 구축:** `triflux setup` 실행 시 `winget`을 통해 `marlocarlo.psmux`를 자동으로 감지하고 설치합니다.

## 🛠️ Bug Fixes & Improvements
*   **HUD(Heads-Up Display) 고도화:**
    *   새로운 ▲ 아이콘 및 x/g/c 브랜드 태그를 통한 모델 식별 용이성 증대.
    *   전체 대시보드 및 HUD의 색상 체계를 통일하여 가독성을 높였습니다.
*   **안정적인 설치 프로세스 (EBUSY Fix):** 설치 중 발생하는 파일 잠금 오류를 해결하기 위해 `taskkill /T /F`, `Atomics.wait`, 파일 잠금 사전 확인 로직을 추가했습니다.
*   **프로세스 안전성:** `tasklist`를 통한 PID 소유자 검증으로 Node.js 프로세스 여부를 확인하고 PID 재사용 문제를 방지합니다.
*   **유령 워커 방지:** Headless 작업 완료 후 `team-state`를 자동으로 정리하여 HUD에 비정상적인 워커 정보가 남지 않도록 개선했습니다.
*   **강력한 예외 처리:** `onProgress` 콜백의 예외를 안전하게 처리하는 `safeProgress` 래퍼 도입 및 로그 캡처 내성을 강화했습니다.

## ⚙️ Internal & QA
*   **고도화된 QA 통과:** 입력 경계값 테스트, 강제 종료 안전성, 콜백 정밀도 등 20건의 핵심 QA 시나리오를 모두 통과(PASS)했습니다.
*   **패치 노트:** v5.2.0 대비 총 17개의 패치가 통합되었습니다 (v6.0.0 ~ v6.0.17).

## 📋 전체 패치 목록

| 버전 | 내용 |
|------|------|
| 6.0.0 | Lead-Direct Headless 엔진 핵심 |
| 6.0.1 | preinstall EBUSY fix (taskkill + 파일 잠금 대기) |
| 6.0.2 | onProgress 예외 삼킴 (safeProgress) |
| 6.0.3 | headless 기본 엔진 문서 정리 |
| 6.0.4 | PID 소유자 검증 + layout 자동 전환 |
| 6.0.5 | 캡처 로그 타이틀 변경 내성 + WT autoAttach |
| 6.0.6 | CLI 진입점 (triflux multi --headless --assign) |
| 6.0.7 | 빈 lead pane 제거 + 포커스 비탈취 |
| 6.0.8 | WT triflux 프로필 (투명도 + 테마) |
| 6.0.9 | 투명도 조정 + -NoExit 제거 |
| 6.0.10 | 투명도 상향 (40/20) |
| 6.0.11 | 가로 스플릿 + 동적 폰트/비율 |
| 6.0.12 | HUD ▲ + 워커 이모지 |
| 6.0.13 | HUD 이모지→글자 (x/g/c) |
| 6.0.14 | CLI 브랜드 색상 전체 통일 |
| 6.0.15 | headless 완료 후 team-state 자동 삭제 |
| 6.0.16 | setup에 psmux 자동 설치 (winget) |
| 6.0.17 | update 재시도에 --force 추가 |
