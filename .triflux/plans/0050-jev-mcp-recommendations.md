# Jev MCP 추천 구현 계획

## 목적

- [요구사항](../../docs/prd/0050-jev-mcp-recommendations.md)과 [ADR-0050](../../docs/adr/0050-jev-mcp-recommendations.md)의 추천 단계를 구현하고 설치본에서 평가한다.
- 사용자가 리드에게 구현, 설치, 실사용 평가, 수정과 재설치의 반복을 위임하였다. 실행 방식은 리드가 배정한다.

## 공통 제약

- Node 22 이상, 새 의존성 없음.
- 전역 MCP 설정과 기존 shared daemon, 다른 세션과 worktree를 유지한다.
- 설치되지 않은 MCP나 native plugin을 자동 설치하지 않는다.
- 첫 단계는 세 CLI 추천이며 실제 자동 활성화는 바꾸지 않는다.
- 원 자연어 작업은 Jev가 판단한다. 새 의미 판정용 정규식은 만들지 않는다.
- packages 미러의 바이트와 remote import 변환을 보존한다.

## 카탈로그와 추천

- 새 카탈로그 모듈은 공식 Registry API 수집과 캐시, 로컬 후보 결합을 맡는다. 기존 mcp-server-catalog.mjs의 메타데이터와 인벤토리 함수를 우선 재사용한다.
- 새 추천 모듈은 task, project summary, cliType, 후보와 인벤토리를 받아 공통 추천 결과를 반환한다. 기존 queryJevBatch 또는 MCP 선택 함수를 재사용하고 필요한 설명 필드를 전달한다.
- 공개 메타데이터와 로컬 설정을 같은 신뢰도로 취급하지 않는다. 등록 이름만으로 설치와 연결 성공을 확정하지 않는다.
- 데이터 계약은 PRD의 상태와 필드를 따른다. 같은 모듈을 CLI 진단과 실제 dispatch 등 둘 이상의 호출 지점에서 재사용한다.
- 핵심 경계 사례: 페이지 누락과 malformed 데이터, 갱신 실패, cache 부재, 중복 ID, CLI 호환성, 낮은 신뢰도, 승인 필요한 미설치 후보.

## 기존 호출 연결

- scripts/tfx-route.sh와 hub/bridge.mjs: 직접 호출에서 추천 요청과 결과를 전달한다. 기존 stdout 프로토콜과 execution flags를 보존한다.
- hub/team/headless.mjs와 Claude worker 경로: 세 CLI assignment에 추천 컨텍스트를 전달한다. 기존 Claude shadow 기록을 활성화 성공으로 바꾸지 않는다.
- hub/team/lead-launch.mjs와 bin/triflux.mjs: 기존 task와 cwd에서 추천하고 JSON과 사람 출력에 추천 상태를 표시한다. 사용자의 일반 호출에 별도 추천 명령을 요구하지 않는다.
- tfx-live 저수준 경로는 실제로 작업 정보를 받는 시점을 확인하여 연결한다. 작업 정보가 없는 start는 추천을 지어내지 않는다.
- 내부 진단 진입점이 필요하면 기존 mcp 또는 judge 명령 아래에 추가한다. 새 최상위 명령이나 중복 별칭을 만들지 않는다.
- 관련 테스트 파일은 mcp-filter, jev-addon, headless-route-agent, lead-launch, route-worker와 새 모듈의 동작 테스트이다. 격리 fixture에서 전역 상태 불변과 실제 전달 결과를 검사한다.

## 역할과 순서

1. Codex Sol high: 카탈로그, 추천과 기존 호출 연결을 전용 worktree에서 구현한다. 소유 범위 밖 변경은 리드에게 보고한다.
2. Claude Opus high: 작성 벤더와 독립적으로 계약, 실패 경로와 diff를 리뷰한다. 결함은 작성자가 수정하고 독립적으로 재확인한다.
3. agy Argon: 설치본을 실제로 사용하여 추천 적합성과 사용자 흐름을 평가한다. 새 MCP를 설치하지 않고 확인 가능한 결과와 미확인을 구분한다.
4. 리드: 통합과 최소 fresh 확인, CI와 릴리스, 자산 snapshot, 설치와 세 CLI 실측을 맡는다. 결과가 기준을 만족하지 못하면 작성자로 되돌리고 수정, 재설치, 재평가한다.

## 완료 증거

- 관련 테스트와 독립 리뷰 결과, CI 결과를 구분한다.
- 세 CLI의 실제 추천 입력과 출력, 출처와 confidence, 설치 상태와 applied=false를 보존한다.
- 실제 MCP 도구 호출 여부를 추천 출력과 별도로 기록한다. 추천 단계의 성공으로 실제 도구 호출 성공을 보고하지 않는다.
- 설치 전후 전역 설정과 기존 세션 보존 상태, 설치본 버전과 해시를 기록한다.
- 불가능하거나 미확인인 동작은 결과에 남기고 기능을 완료로 포장하지 않는다.
