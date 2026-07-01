# ADR — triflux 아키텍처 의사결정 기록

triflux의 아키텍처·정책·횡단 결정을 ADR(Architecture Decision Record)로 남긴다.
**상태보드에 행이 없는 ADR은 존재로 인정하지 않는다.** 규약(어떻게)은 [CONVENTIONS.md](CONVENTIONS.md), 근거(왜)는 각 ADR.

## 상태보드

| ADR | 결정 | 상태 | 관련 |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | ADR로 아키텍처 결정을 기록한다 | Accepted | — |
| [0002](0002-doc-and-devflow-architecture.md) | 문서 파운데이션 + 개발 플로우 아키텍처 | Accepted | 0001 |
| [0003](0003-tfx-skill-passing-prose-injection.md) | headless CLI 스킬 전달 = 즉석 prose 주입 | Accepted | 0002 |

상태 범례: **Proposed**(제안) · **Accepted**(확정, 불변) · **Superseded**(대체됨 → `_archive/`) · **Deprecated**/**Rejected**/**Withdrawn**(무효화 → `_archive/`).

## 새 ADR 작성

1. 다음 번호로 `docs/adr/NNNN-kebab-title.md` 생성([CONVENTIONS.md](CONVENTIONS.md) 템플릿 사용).
2. 본문에 `## 결정`과 `## 검토한 대안`을 반드시 포함.
3. 위 상태보드에 행 추가(미등재 = 존재 부정).
4. 논의가 필요하면 `proposed`로 시작, 합의 후 `accepted`.
