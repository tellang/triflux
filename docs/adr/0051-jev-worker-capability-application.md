---
id: 0051
title: Jev 추천을 워커의 실행별 설정에 연결한다
status: proposed
date: 2026-11-03
deciders: []
supersedes: []
superseded_by: null
relates: [0028, 0049, 0050]
pr: null
---

# ADR-0051: Jev 워커 설정 적용

## 목적

- 워커를 실행하기 전에 작업에 맞는 모델과 effort를 조회한다.
- 등록된 MCP 추천을 해당 워커의 실행별 설정에 반영한다.

## 결정

- `tfx judge worker-model`은 기존 역할 정책과 Jev 판단을 재사용하고 모델, 가족, effort, 출처와 폴백 이유를 JSON으로 반환한다. 조회만으로 세션을 생성하거나 모델 설정을 저장하지 않는다.
- 실제 워커 배정에서도 같은 정책을 사용한다. 명시 모델과 effort, 재시도 정책, 작성 벤더별 리뷰 정책을 보존한다.
- 모델 선택은 `agent-route-policy.mjs`에서 역할 기본값, `judgeTaskRouting` 결과, read-only 모델 resolver를 조합한다. Codex와 agy는 route가 최종 provider를 정한 뒤 한 번 선택하고, Claude 직접 워커는 부모가 같은 정책을 적용한다. 원 작업은 조립된 실행 prompt와 분리한다.
- headless의 명시 모델과 effort는 한쪽만 있어도 자동 추천으로 나머지를 채우지 않는다. 명시 모델이 없는 Codex는 역할 기본 프로필을 명시 오버라이드로 보내지 않아 Jev 조정이 가능하다.
- 워커의 `.model.json`에 선택값, 출처, 폴백 이유와 실행 인자를 기록하고 결과의 `workerModelFile`로 연결한다. `appliedTo: launch_arguments`, `runtimeConfirmed: false`는 인자 전달 단계이며 실제 모델 수신 완료를 뜻하지 않는다.
- MCP는 최종 CLI와 원 작업으로 얻은 추천 한 건을 재사용한다. route 워커는 route에서, Claude direct 워커는 부모에서 한 번 조회한다.
- `worker-mcp.mjs`는 카탈로그 identity를 로컬 원 정의와 연결한다. 이름 유사성이나 `present`만으로 실행하지 않는다. 중복 identity, 같은 이름의 충돌, disabled, 미승인 프로젝트, 읽기 실패는 `deferred`로 남긴다. 카탈로그의 command, URL로 실행 정의를 합성하지 않는다.
- 최초 입력이 `auto`이면 역할별 MCP profile은 조정 가능한 기본값이다. 작업별 추천으로 확인된 기등록 MCP를 해당 워커 실행에만 활성화할 수 있다. 사용자 명시 profile, filter, config, manifest 제한과 등록 항목의 disabled, trust, 도구 및 승인 제한은 보존한다.
- 추천 서버의 역할별 도구 목록이 있으면 원 등록의 도구 제한과 교집합을 적용한다. 목록을 모르면 빈 목록을 생성하지 않고 원 등록의 도구 및 승인 제한을 그대로 사용한다. 유효한 서버 매니페스트의 허용 목록 안에서만 단일 서버로 좁히며 빈 목록과 읽기 실패는 보류한다.
- Codex route의 직접 `exec` 프로세스는 등록된 이름의 실행별 `-c`로 서버를 선택한다. 원 `enabled_tools`, `disabled_tools`, 승인 키를 넓히지 않는다. unknown 도구 목록은 override를 생략하고 명시 빈 목록은 유지한다. 미등록 plugin에 섹션을 만들지 않는다.
- Codex의 shared daemon, thread 재사용 경로는 이번 적용 대상이 아니다. 격리 근거가 없는 transport는 `codex_transport_isolation_unverified`로 보류한다. exec의 공식 in-process 구현과 로컬 소유 subprocess argv, 설정 파일 불변을 확인하며 실제 서비스 연결을 주장하지 않는다.
- Claude direct와 route subprocess는 선택한 원 정의만 private 0700 디렉터리의 0600 파일로 전달하고 `--mcp-config`, `--strict-mcp-config`를 사용한다. 원 JSON과 비밀값은 argv나 프롬프트로 전달하지 않는다. 자식 종료와 실패 후 소유 파일만 삭제한다. SIGTERM, SIGINT, SIGHUP에서는 config를 먼저 정리하고 자식에게 신호를 전달한다. 핸들러 실행 전 직접 SIGKILL이나 파일시스템 오류의 완전 정리는 보장하지 않는다.
- Claude route runner는 발견한 프로젝트 파일을 자동으로 `--mcp-config`에 전달하지 않는다. 추천 적용을 보류하면 Claude 자체의 프로젝트 trust 및 승인 절차를 유지한다. native metadata 경로는 `native_metadata_only`로 보류한다.
- AGY 서버 설정의 session 격리는 미확인이다. `agy_server_session_isolation_unverified`로 보류하며 `--settings` permissions를 서버 활성화 근거로 쓰지 않는다.
- 결과의 `workerMcpFile`은 `.mcp.json` 메타데이터를 가리킨다. `application.status`는 `prepared`, `configured`, `deferred`이고 설정 인자 전달만 `appliedTo: start_args`로 표시한다. `applied`, `runtimeConfirmed`, `toolVerified`는 false를 유지한다. 추천과 설정 전달, 서버 연결, 도구 호출을 구분한다.
- 새 MCP나 플러그인은 설치하지 않는다. missing과 unknown의 설치 승인 필요 상태를 유지한다. 전역 설정 교체, 공유 daemon 재시작, 다른 세션 설정 변경으로 폴백하지 않는다.

## 이유

- 기존 모델 선택은 실행 래퍼 안에 있어 리드가 워커를 배정하기 전에 결과를 조회하기 어렵다.
- MCP 추천 단계는 완료되었고 사용자가 워커 적용을 요청하였다. 동시 세션의 설정을 보존하려면 호스트별 실행 범위가 확인되어야 한다.

## 검토한 대안

- 별도 모델 선택기 추가: 기존 역할 정책과 추천 결과가 달라질 수 있어 채택하지 않는다.
- 전역 MCP 설정 교체 후 복원: 동시 세션과 비정상 종료에 영향을 주므로 채택하지 않는다.
- 모든 CLI의 격리 확인까지 적용 보류: 확인된 실행 경로부터 연결하고 미확인 경로는 명시적으로 보류한다.
