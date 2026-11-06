# Jev MCP 추천 요구사항

## 목적

- 기존 triflux 워커와 리드 호출에서 프로젝트와 맡은 작업에 맞는 MCP를 추천한다.
- Claude, Codex, Antigravity를 같은 추천 계약으로 지원한다.
- 사용자가 합의한 첫 단계는 추천이며 자동 활성화는 세션 격리가 확인된 경로부터 후속 구현한다.

## 사용자 흐름

1. 기존 tfx-auto, multi, lead 흐름으로 작업을 요청한다.
2. triflux가 프로젝트 정보, 작업, 대상 CLI와 기존 MCP 인벤토리를 모은다.
3. 원 작업의 어휘로 로컬 카탈로그에서 후보를 가져와 Jev가 각 후보의 유용성을 독립 평가한다.
4. 추천 결과 데이터에는 MCP의 설명, 출처, 설치 상태와 승인 필요 여부를 담는다. 리드와 워커의 프롬프트에는 안전하게 인코딩한 식별값, 출처, confidence와 상태만 전달한다.
5. 미설치 항목은 설치 제안으로 표시한다. 첫 단계에서 설치하거나 새 MCP 서버를 시작하지 않는다.

## 첫 구현 범위

- 공식 MCP Registry 운영 API의 페이지와 버전을 처리하여 공개 서버 메타데이터를 캐시한다. 개발용 seed를 운영 목록으로 사용하지 않는다.
- Docker와 ToolHive는 보강 데이터 후보이다. 첫 배포의 필수 운영 데이터는 공식 Registry와 기존 로컬 카탈로그이다.
- 설치된 MCP의 후보 설명은 기존 인벤토리와 공개 카탈로그를 연결하여 보강한다. 이름이 비슷하다는 이유만으로 설치된 항목으로 확정하지 않는다.
- 대상 CLI는 claude, codex, agy이다. antigravity 입력은 agy로 정규화한다.
- 기존 Jev 클라이언트와 신뢰도 기준을 재사용한다. 자연어 작업의 의미를 새 정규식이나 부분 문자열 규칙으로 판정하지 않는다.
- 큰 목록은 한 요청에 모두 넣지 않는다. 원 작업을 Intl.Segmenter로 나눈 단어의 일치를 우선하고 명시 검색어, 프로젝트 키워드와 의존성은 보조 입력으로 쓴다. 어휘 검색은 의미 판정이 아니며 최종 적합성과 confidence는 Jev만 판단한다. package.json과 명시 검색어가 없어도 작업에 맞는 후보를 조회한다.
- 최대 12개 후보 안에서 공개 검색 6개, 로컬 기본 4개, 기설치 2개의 몫을 확보한다. 중복을 빼고 남은 공간에는 검색 일치 후보만 넣는다. 검색 신호가 없으면 공개 항목을 사전순으로 채우지 않고 제한된 기본 후보로 폴백하며 search_no_matches를 남긴다.
- 기존 queryJevBatch의 noul 질문으로 후보별 유용성을 독립 평가한다. 각 질문에 후보 설명을 포함하며 설치, 인증, 활성화 여부를 유용성과 구분한다. 임계값 이상의 양성 중 최고 confidence의 후보를 최대 하나 반환한다. 부분 응답과 잘못된 응답은 unavailable, 유효한 음성이나 낮은 신뢰도는 no_recommendation으로 구분한다.
- 첫 단계의 추천은 실제 활성화를 뜻하지 않는다. 기존 실행의 모델, effort, 권한, 명시 MCP 프로필과 MCP 필터를 바꾸지 않는다.
- raw tfx-live start처럼 작업이 아직 없는 호출은 프로젝트 정보만 쓰거나 task_missing으로 보류한다. 작업이 없는 상태를 구체적인 작업 추천으로 포장하지 않는다.

## 데이터 계약

- 카탈로그 항목: 안정적인 source ID, 서버 ID, 이름, 설명, 버전 또는 revision, 출처 URL, 수집 시각, transport, 알려진 요구사항.
- 인벤토리: 대상 CLI, 로컬 서버 이름, 확인된 식별 정보, present 또는 missing 또는 unknown 상태. 인증 상태는 인벤토리만으로 정상이라고 확정하지 않는다.
- 추천 결과: cli, status, recommendations, diagnostics, applied=false.
- 개별 추천: ID와 이름, 출처, 설명, confidence, 설치 상태, requiresApproval. 미설치 또는 설치 여부가 불명확하면 승인 없이 설치 가능한 항목으로 표시하지 않는다.
- 프롬프트: ID, 출처 ID와 URL, confidence, 설치 상태, 인증과 활성화 상태, requiresApproval, applied=false와 고정 정책만 전달한다. 이름, 설명과 버전은 결과 데이터에만 남긴다.
- requiresApproval은 새 설치 제안의 승인 필요 여부다. present는 false, missing과 unknown은 true다. false도 설치나 활성화 권한의 근거가 아니며 applied=false를 유지한다.
- 상태: recommended, no_recommendation, unavailable, deferred. 실패나 보류 이유를 diagnostics에 남긴다.
- 카탈로그의 env 요구사항 이름은 보관할 수 있지만 실제 인증값, 헤더, 사용자 설정 전문은 저장하거나 출력하지 않는다.

## 실행 경로

- 기존 tfx-route 직접 호출과 multi headless 경로의 차이를 처리한다. Claude direct backend도 추천을 빠뜨리지 않는다.
- lead는 이미 받은 task와 cwd를 사용한다. 명시한 모델과 launcher의 우선순위를 유지한다.
- 같은 dispatch에서 부모와 자식이 동일 추천을 중복 조회하지 않도록 결과를 전달하거나 동일 요청을 재사용한다. 전달된 결과는 추천 정보이며 권한의 근거가 아니다.
- 추천 요약과 출처를 기존 컨텍스트 전달에 첨부한다. 원 작업 내용을 삭제하거나 작업 의미를 바꾸지 않는다.
- 카탈로그 갱신과 추천 실패는 기존 워커 실행을 막지 않는다. 실패를 정상 추천이나 활성화 완료로 표시하지 않는다.

## 캐시와 장애

- 캐시는 CLI 공용 사용자 캐시 경로에 두며 MCP 등록 설정과 분리한다.
- 갱신 실패 시 마지막 정상 캐시를 보존하고 오래된 데이터라는 상태를 함께 표시한다.
- 카탈로그가 없으면 기존 로컬 후보로 추천하거나 unavailable을 반환한다. 빈 파일로 정상 캐시를 덮어쓰지 않는다.
- 일반 워커 호출마다 카탈로그 전체를 다운로드하지 않는다. 갱신은 리드의 준비 단계나 내부 갱신 경로로 분리한다.
- Jev 비활성, 네트워크 실패, 낮은 신뢰도와 잘못된 응답은 각각 보류 또는 실패로 기록한다. 임계값을 낮추거나 억지로 후보를 고르지 않는다.

## 완료 기준

- 세 CLI의 기존 호출에서 추천 결과와 출처를 확인할 수 있다.
- 추천만 된 항목과 실제 적용된 MCP를 혼동하지 않는다.
- 설치된 항목, 미설치 항목과 확인되지 않은 항목이 구분된다.
- 일반 작업에서 카탈로그와 Jev가 실패해도 기존 호출이 유지된다.
- 전역 MCP 설정, 기존 shared daemon과 다른 세션은 바뀌지 않는다.
- 미설치 MCP와 plugin의 실제 설치가 승인 없이 발생하지 않는다.
- native plugin의 세 호스트별 데이터와 자동 활성화는 후속 범위로 유지한다. 첫 단계에서 지원하지 않는 기능을 완료로 표시하지 않는다.

## 워커 실행별 적용

- 후속 구현은 ADR-0051을 따른다. accepted ADR-0050의 추천 계약은 유지한다.
- 로컬 원 정의와 유일하게 연결되는 등록 서버만 실행별 적용한다. 명시 profile, 서버 및 도구 제한, config와 프로젝트 승인을 우선한다.
- Codex 직접 exec 경로는 등록명만 실행별 override에 포함한다. unknown 도구 목록과 명시 deny-all을 구분하고 원 도구 및 승인 제한을 보존한다. shared daemon 격리를 확인하지 못한 경로는 보류한다.
- Claude direct와 route subprocess는 private config 파일과 strict 설정을 사용한다. 설정 파일은 자식 종료 후 정리하며 원 정의와 비밀값은 프롬프트, argv, 결과에 넣지 않는다. native metadata 경로는 적용으로 표시하지 않는다.
- AGY 자동 서버 적용은 session 격리 미확인으로 보류한다. 전역 또는 workspace 설정 쓰기로 우회하지 않는다.
- 실행 결과의 workerMcpFile에서 추천과 application 상태 및 보류 이유를 확인한다. 설정 인자 전달은 appliedTo=start_args이며 runtimeConfirmed와 toolVerified는 별도 증거를 확보하기 전까지 false다.

## 관련 문서

- [ADR-0050](../adr/0050-jev-mcp-recommendations.md)
- [실행 계획](../../.triflux/plans/0050-jev-mcp-recommendations.md)
