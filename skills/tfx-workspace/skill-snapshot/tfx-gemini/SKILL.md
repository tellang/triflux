---
name: tfx-gemini
description: "DEPRECATED — compatibility alias only. Use tfx-auto --cli antigravity / agy."
triggers:
  - tfx-gemini
argument-hint: "\"작업 설명\" | N:antigravity \"작업 설명\""
---

# tfx-gemini (DEPRECATED -> Antigravity alias)

> Gemini CLI 직접 실행은 금지입니다. 이 이름은 오래된 호출 호환성만 위해 남아 있으며 실제 실행은 Antigravity `agy` lane으로 수렴해야 합니다.

## 사용법

```bash
/tfx-auto "작업 설명" --cli antigravity
/tfx-gemini "작업 설명"  # deprecated compatibility alias
```

## 실행 규칙

1. 신규 문서, 계획, wrapper, Native Teams teammate에는 `gemini` worker 이름을 만들지 않습니다.
2. 호환 입력 `gemini`가 들어오면 `antigravity`로 정규화합니다.
3. 실행은 `tfx-route.sh`를 통해 `agy --print --dangerously-skip-permissions` stdin 계약으로만 수행합니다.

## 필수 조건

- Google Antigravity 설치
- `agy`가 PATH에서 실행 가능
- `agy --help`에 `--print`와 `--dangerously-skip-permissions`가 노출되어야 함
