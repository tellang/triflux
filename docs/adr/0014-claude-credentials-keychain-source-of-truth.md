---
id: 0014
title: Claude 자격증명은 macOS Keychain 을 정본으로 읽고 읽은 저장소에만 되쓴다
status: proposed
date: 2026-09-21
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: "#499"
---

# ADR-0014: Claude 자격증명은 macOS Keychain 을 정본으로 읽고 읽은 저장소에만 되쓴다

## 컨텍스트와 문제 (Context)
Claude Code 2.1.x 는 macOS 에서 OAuth 자격증명을 Keychain 항목에 둔다. 서비스명은 `Claude Code-credentials` 에 설정 디렉터리별 sha256 접미사가 붙고, 계정은 `$USER` 다. `.credentials.json` 은 Keychain 을 쓸 수 없을 때만 쓰는 평문 폴백이며, Keychain 이 살아 있으면 갱신되지 않는다. 이 계약은 2.1.268 바이너리의 secure-storage 구성(Keychain 우선, 평문 폴백 합성)에서 확인했다.

triflux HUD 와 로그인 감지 훅은 반대로 파일을 정본처럼 다뤘다. 그 결과가 실제 머신에서 세 가지로 드러났다.

- 파일에 남은 옛 계정의 만료 토큰을 HUD 가 독자적으로 갱신해 계속 살려 두었다.
- 갱신한 토큰을 Keychain 에 토큰 세 필드만 남긴 채 덮어써, Claude Code 가 쓰는 현재 로그인의 scopes, subscriptionType 같은 메타데이터를 지울 수 있었다.
- 로그인 감지는 파일 mtime 만 봐서, Claude Code 가 건드리지 않는 파일 때문에 계정 전환을 끝내 감지하지 못했다.

## 결정 (Decision)
우리는 macOS 에서 Keychain 을 Claude 자격증명의 정본으로 취급하고, triflux 는 읽어 온 저장소에만 되쓰기로 한다.

- **읽기 순서**: darwin 은 Keychain 먼저, 없을 때만 파일. 그 밖의 플랫폼은 파일 먼저.
- **항목 키**: (service, account) 복합 키만 읽고 쓴다. 서비스명은 `CLAUDE_SECURESTORAGE_CONFIG_DIR`(정의돼 있으면 우선, 빈 값은 기본, NFC 정규화) 다음 `CLAUDE_CONFIG_DIR` 원문의 sha256 앞 8자리로 만든다. 계정은 `USER`, 없으면 OS 사용자명, 허용 문자 밖이면 `claude-code-user`. 계정을 지정하지 않는 조회는 같은 서비스의 임의 계정 항목을 돌려주므로 쓰지 않는다.
- **되쓰기**: 자격증명을 읽어 온 저장소의 같은 항목, 또는 같은 파일 경로에만 쓴다. Keychain 출처를 파일에, 파일 출처를 Keychain 에 쓰지 않는다. 쓸 때는 기존 항목을 읽어 토큰 필드만 교체하고 나머지는 보존한다.
- **쓰기 경로**: `security -i` 표준입력에 명령 한 줄을 넘기고 payload 는 16진수로 싣는다. 토큰을 프로세스 인자에 두지 않는다.
- **로그인 지문**: refreshToken 해시를 Keychain 서비스명별로, 파일 mtime 을 경로별로 기억한다. accessToken 의 주기 갱신에는 HUD 캐시를 지우지 않고 재로그인에만 지운다.

## 검토한 대안 (Considered Options)
- **A안: Keychain 정본 + 출처 일치 되쓰기 (채택)**: Claude Code 의 실제 저장 계약과 같아 계정 혼합과 메타데이터 손실이 구조적으로 사라진다. 단점은 Claude Code 내부 계약을 관찰해 맞춘 것이라 버전이 오르면 다시 확인해야 한다는 점이다.
- **B안: 파일 우선 유지, Keychain 은 폴백**: 기존 방식. 변경이 없다는 것 말고 장점이 없다. 옛 파일이 남아 있는 한 현재 로그인 대신 옛 계정을 읽는다.
- **C안: 두 저장소에 모두 되써서 동기화 유지**: 어느 쪽을 읽어도 같은 값이 된다는 의도였다. 실제로는 서로 다른 계정이 두 저장소에 있을 때 한쪽이 다른 쪽을 덮어쓴다. 이번 결함의 직접 원인이다.
- **D안: HUD 는 읽기 전용, 토큰 갱신을 하지 않음**: Claude Code 의 로그인에 전혀 간섭하지 않는다. 다만 토큰이 만료된 직후 Claude Code 가 갱신하기 전까지 HUD 사용량이 빈다. 갱신 토큰 회전 정책이 바뀌어 되쓰기 실패가 로그인 파손으로 이어지면 이 안으로 물러난다.
- **E안: 항목 전체 해시를 로그인 지문으로**: 구현이 가장 단순하다. accessToken 이 몇 시간마다 갱신될 때마다 지문이 바뀌어 HUD 캐시를 지우고 사용량 API 를 불필요하게 다시 부른다.

## 결과 (Consequences)
긍정: HUD 가 Claude Code 의 현재 로그인을 읽고, 되쓰기가 그 로그인의 메타데이터를 지우지 않는다. 계정을 바꾸면 다음 세션 시작에서 HUD 캐시가 한 번 비워진다. 격리 설정 디렉터리를 쓰는 세션과 기본 세션이 번갈아 떠도 캐시를 반복 삭제하지 않는다.

부정과 리스크: 서비스명, 계정, 저장 우선순위는 공개 문서가 아니라 바이너리 관찰로 확정했다. Claude Code 가 저장 계약을 바꾸면 조용히 어긋난다. 상태 파일 형식이 바뀌어 적용 후 첫 실행에서 HUD 캐시를 한 번 지운다.

되돌릴 조건: Claude Code 가 자격증명 조회용 공식 인터페이스를 제공하거나 저장 계약을 바꾸면 새 번호 ADR 로 다시 정한다. 구현은 PR #499.
