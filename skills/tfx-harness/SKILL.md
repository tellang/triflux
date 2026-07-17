---
name: tfx-harness
internal: true
description: >
  어떤 스킬·경로를 선택할지 묻는 메타 라우팅 요청에 사용한다. 실행하지 않고
  canonical routing SSOT에서 branch와 즉시 owner 하나만 반환한다.
---

# tfx-harness — Claude adapter

이 스킬은 실행 엔진이 아니다. `.claude/rules/tfx-routing.md`의 D0–D11을 읽어
사용자 intent와 확인 가능한 host capability evidence를 판정한다. 정책 표, keyword
표, owner 매트릭스를 이 파일에 복제하지 않는다.

반환 형식:

```text
[tfx-harness]
branch: D<n>
owner: <exactly one immediate owner>
availability: available | unavailable | unknown
fallback_notice: <optional>
status: recommendation-only | dispatching | blocked
```

- 한 판정에는 branch 하나와 immediate owner 하나만 둔다.
- availability가 unknown이면 fallback하지 않는다. 실제 unavailable 증거가 있을 때만
  `owner unavailable → tfx-X fallback`을 함께 알릴 수 있다.
- SSOT를 읽지 못하면 추측하지 말고 `blocked: routing SSOT unavailable`을 반환한다.
- “어떤 스킬/경로?” 질문은 recommendation-only다. 명백한 진행 요청만 `/skill` 문법으로
  owner에 handoff한다.
- downstream implementation agent나 model은 선택하지 않는다.
