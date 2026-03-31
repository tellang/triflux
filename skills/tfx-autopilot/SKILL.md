---
name: tfx-autopilot
description: "간단한 작업을 자율적으로 구현해야 할 때 사용한다. 'autopilot', '자동으로', '알아서 해', '그냥 해줘' 같은 요청에 반드시 사용. 명확한 단일 작업을 빠르게 자동 구현+검증할 때 적극 활용."
triggers:
  - autopilot
  - 자동
  - 알아서 해
argument-hint: "<구현할 작업 설명>"
---

# tfx-autopilot — Light Autonomous Execution

> Codex 직접 구현 → Claude 검증. 최소 토큰으로 빠른 자율 실행.

## 용도

- 명확한 단일 작업을 빠르게 자동 구현
- 보일러플레이트 생성 + 검증
- 간단한 버그 수정 자동화
- 린트/포맷/리팩터 자동 적용
- "알아서 해줘" 류의 명확한 요청

## 워크플로우

### Step 1: 작업 파싱

사용자 입력에서 구현 범위와 완료 기준을 추출한다:

```
입력: "로그인 API에 rate limiting 추가"
파싱: {
  task: "로그인 API에 rate limiting 추가",
  scope: ["src/routes/auth.ts", "src/middleware/"],
  criteria: [
    "rate limiter 미들웨어 생성",
    "로그인 엔드포인트에 적용",
    "기존 테스트 통과"
  ]
}
```

모호하면 AskUserQuestion으로 명확화.

### Step 2: Codex 직접 구현

```bash
bash ~/.claude/scripts/tfx-route.sh codex \
  "다음 작업을 구현하라:
   작업: {task}
   프로젝트 컨텍스트: {context}
   완료 기준: {criteria}

   1. 관련 파일을 읽고 구조를 파악하라
   2. 필요한 코드를 작성/수정하라
   3. 기존 테스트를 실행하여 회귀가 없는지 확인하라
   4. 변경 사항을 요약하라" implement
```

### Step 3: Claude 검증

Codex 실행 완료 후, Claude가 변경 사항을 검증한다:

```
검증 항목:
  1. 파일 변경 확인 — git diff로 실제 변경 내용 확인
  2. 완료 기준 충족 — 각 criterion 대조
  3. 회귀 여부 — 테스트 결과 확인
  4. 코드 품질 — 명백한 결함 여부 (깊은 리뷰는 아님)

판정:
  PASS → 완료 보고
  FAIL → Codex에 수정 지시 (1회 재시도)
  재시도 FAIL → 사용자에게 문제 보고
```

### Step 4: 완료 보고

```markdown
## Autopilot 완료: {task}

### 변경 사항
- `{file1}` — {변경 요약}
- `{file2}` — {변경 요약}

### 검증
- 완료 기준: {pass}/{total} 충족
- 테스트: {pass}/{total} 통과
- 검증: Claude ✓

### 다음 단계 (선택)
- {추가 권장 사항이 있으면}
```

## 토큰 예산

| 단계 | 토큰 |
|------|------|
| Step 1 (파싱) | ~500 |
| Step 2 (Codex 구현) | ~5K |
| Step 3 (Claude 검증) | ~3K |
| Step 4 (보고) | ~500 |
| 재시도 (필요 시) | +4K |
| **총합** | **~10K** |

## 사용 예

```
/tfx-autopilot "이 함수에 입력 검증 추가해줘"
/tfx-autopilot "ESLint 경고 전부 수정"
/tfx-autopilot "알아서 해 — 이 TODO 코멘트 3개 구현"
```
