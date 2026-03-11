# ADR-008: 테스트 프레임워크 채택

- 상태: Accepted
- 날짜: 2026-03-11
- 이슈: #53

## 컨텍스트

프로젝트는 ESM(`"type": "module"`) 기반이며, 테스트 러너 도입 시 다음 조건이 필요했다.

- 추가 의존성 최소화
- CI/로컬에서 빠른 실행
- 기존 `test:route-smoke`와 일관된 테스트 방식 유지

## 결정

`node:test` + `node:assert/strict` 조합을 기본 테스트 프레임워크로 채택한다.

## 고려한 대안

1. Jest
- ESM 환경 설정 복잡도와 호환성 부담이 상대적으로 큼

2. Vitest
- 개발 경험은 우수하나 외부 의존성 추가가 필요함

3. Mocha
- 유연하지만 assertion/유틸리티 조합을 추가로 선택해야 하고 외부 의존성이 생김

## 근거

- Node.js 내장 모듈 기반으로 제로 의존성 유지 가능
- `node --test`로 표준 실행 경로 제공
- `node:assert/strict`로 명확한 단언 스타일 유지 가능
- 기존 스모크 테스트(`test:route-smoke`)와 같은 철학 유지

## 결과

- `tests/unit`, `tests/integration` 기본 구조 도입
- `package.json`에 `test`, `test:unit`, `test:integration` 스크립트 추가
- 핵심 모듈(`session`, `shared`, `pane`)에 기초 단위 테스트 추가
- 테스트 프레임워크는 Node.js 22+ 기준으로 운영한다
