# #58 tfx-auto와 tfx-multi 통합 가능성

> 등록: 2026-03-13
> 상태: open
> 분류: design / architecture
> 심각도: low
> 관련: skills/tfx-auto/SKILL.md, skills/tfx-multi/SKILL.md, docs/adr/ADR-009-orchestration-architecture.md

## 질문

tfx-auto와 tfx-multi를 하나로 합칠 수 있는가?

## 현재 역할 비교

| 항목 | tfx-auto | tfx-multi |
|------|----------|-----------|
| 실행 단위 | Bash subprocess (tfx-route.sh) | Native Teams + Agent 래퍼 |
| 트리아지 | Codex 분류 → Opus 분해 | Codex triage → Opus 분해 |
| 상태 추적 | 없음 (fire-and-forget) | TeamCreate + TaskCreate |
| 네비게이션 | 없음 | Shift+Down (Native Teams) |
| 모드 | 커맨드 숏컷 / 자동 / 수동 | --quick / --thorough / --tmux |
| DAG | INDEPENDENT / SEQUENTIAL / DAG | 없음 (병렬 실행만) |
| 파이프라인 | 없음 | plan→prd→exec→verify→fix |

## 겹치는 부분

- 둘 다 Codex/Gemini 라우팅에 `tfx-route.sh` 사용
- 둘 다 Codex 트리아지 → Opus 분해 패턴
- 에이전트 매핑 테이블 동일
- MCP 프로필 결정 로직 동일

## 다른 부분

- **auto**: 경량, 빠른 실행. Agent 래퍼 없이 Bash 직접 실행
- **multi**: 무거움, 팀 구조. Agent 래퍼로 네비게이션 + 상태 추적

## 통합 시나리오

### A. multi가 auto를 흡수

```
/tfx "작업"                    # 자동 판단 (단순 → auto 모드, 복합 → multi 모드)
/tfx "작업" --quick            # 강제 auto 모드 (팀 구성 없이)
/tfx "작업" --thorough         # 강제 multi 모드 (파이프라인)
/tfx implement "작업"          # 커맨드 숏컷 (auto 모드)
/tfx 3:codex "작업"            # 수동 multi 모드
```

### B. auto에 팀 기능 추가

- auto의 DAG 실행에 TeamCreate/TaskCreate 선택적 적용
- `--team` 플래그로 팀 모드 활성화

### C. 유지 (현상 유지)

- auto = 단순/빠른 실행, multi = 팀/파이프라인
- 용도 명확히 분리하고 문서화

## 평가

| 기준 | A (multi 흡수) | B (auto 확장) | C (유지) |
|------|---------------|---------------|----------|
| 사용자 경험 | 진입점 1개 ✅ | 진입점 1개 ✅ | 진입점 2개 ❌ |
| 구현 복잡도 | multi SKILL.md 대폭 확장 | auto SKILL.md 대폭 확장 | 현상 유지 |
| 유지보수 | 하나만 관리 ✅ | 하나만 관리 ✅ | 두 개 관리 ❌ |
| 하위호환 | /tfx-auto → /tfx alias | /tfx-multi → /tfx alias | 변경 없음 |

## 권장

**A안 (multi가 auto를 흡수)** — 이유:
1. multi가 이미 auto의 상위집합 (tfx-route.sh 실행 + 팀 구조)
2. 커맨드 숏컷과 DAG를 multi에 추가하면 통합 완료
3. 진입점을 `/tfx`로 통일하면 사용자 혼란 제거
4. ADR-009에서 이미 통합 아키텍처 방향 설정

## 선행 조건

- #57 해결 (task 구성 안정화)
- tfx-multi v3 파이프라인 구현 완료 (handoff/16 Phase 1~5)
- 커맨드 숏컷 + DAG 로직을 multi에 이식
