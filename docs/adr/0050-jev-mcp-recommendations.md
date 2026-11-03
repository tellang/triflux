---
id: 0050
title: Jev MCP 추천을 기존 실행 경로에 연결한다
status: proposed
date: 2026-11-03
deciders: []
supersedes: []
superseded_by: null
relates: [0028, 0029]
pr: null
---

# ADR-0050: Jev MCP 추천 연결

## 목적

- 프로젝트와 작업에 맞는 MCP를 Claude, Codex, Antigravity 리드와 워커에게 추천한다.
- 카탈로그 검색, 설치 상태, 추천, 실제 활성화를 구분한다.

## 결정

- 기존 Jev 클라이언트와 triflux 호출 경로를 확장한다. 첫 단계는 세 CLI의 추천과 설치 제안이며 새 MCP를 실행하거나 설치하지 않는다.
- 공식 MCP Registry의 공개 서버 메타데이터와 로컬 인벤토리를 사용한다. 카탈로그는 사용자 캐시에 보관하고 전역 MCP 설정은 수정하지 않는다.
- 기존 호출에서 프로젝트와 작업을 전달하여 추천한다. 사용자가 추천 명령을 매번 추가로 입력해야 하는 흐름을 만들지 않는다.
- 추천 결과는 현재 CLI, 출처, 설치 여부, 신뢰도와 승인 필요 여부를 포함한다. 추천을 실행 권한이나 활성화 완료로 해석하지 않는다.
- 자동 활성화는 CLI별 세션 격리를 확인한 뒤 후속 단계로 연결한다. 기존 Codex 필터의 동작과 Claude shadow 계약을 첫 단계에서 바꾸지 않는다.
- 세션 범위를 확인하지 못한 경로에서 전역 설정 교체로 폴백하지 않는다. 미설치 MCP와 native plugin의 실제 설치는 사용자 확인이 필요하다.

## 이유

- 기존 코드에 Jev 호출, MCP 인벤토리와 Codex 실행별 필터가 있다. 별도 선택 서버를 추가하기보다 이 연결을 재사용할 수 있다.
- 공식 Registry는 공개 서버 메타데이터를 제공하지만 설치 상태와 세션 활성화 상태는 제공하지 않는다.
- 현재 Claude는 추천 기록만 있고 Antigravity는 프롬프트 힌트만 있다. 추천과 활성화를 함께 완료하였다고 표시하면 실제 적용 상태가 틀린다.
- ADR-0028은 전역 설정 교체가 동시 세션에 영향을 준 실제 결함과 실행별 설정 선택의 이유를 기록한다.

## 검토한 대안

- 별도 Jev MCP 도입: 다른 클라이언트가 공유하기 좋지만 기존 Jev 호출과 중복되고 카탈로그와 CLI 적용 기능은 여전히 필요하다.
- Docker 또는 ToolHive 실행 게이트웨이 중심 구성: MCP 실행과 격리를 맡길 수 있지만 추가 런타임이 필요하고 native plugin까지 같은 방식으로 처리하지 않는다.
- 전역 MCP 설정을 교체한 뒤 복원: 동시 세션과 비정상 종료의 기존 결함이 재발하므로 채택하지 않는다.

## 관련 문서

- [요구사항](../prd/0050-jev-mcp-recommendations.md)
- [실행 계획](../../.triflux/plans/0050-jev-mcp-recommendations.md)
- [공식 MCP Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md)
