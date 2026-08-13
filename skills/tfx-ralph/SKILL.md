---
internal: true
name: tfx-ralph
description: >
  tfx-auto의 완료 보장 retry 별칭. 'ralph', '끝까지', '끝까지 해', '멈추지 마' 같은
  요청에 사용하며, 원래 요청을 tfx-auto의 --retry ralph 상태 머신으로 전달한다.
---

# tfx-ralph — tfx-auto ralph retry 별칭

> **ARGUMENTS 처리**: 이 스킬이 `ARGUMENTS: <값>`과 함께 호출되면, 해당 값을 사용자 입력으로 취급하여
> 워크플로우의 첫 단계 입력으로 사용한다. ARGUMENTS가 비어있거나 없으면 기존 절차대로 사용자에게 입력을 요청한다.


이 스킬은 install-time 별칭을 경유하지 않고 canonical owner인 `tfx-auto`로 직접 전달한다.

## 동작

사용자의 원래 요청을 task 인자로 그대로 전달하고 다음 형태로 실행한다:
```
/tfx-auto "<원래 요청>" --retry ralph
```

`--retry ralph`의 기본 `--max-iterations 0`은 unlimited이며, 반복 실패가 같은 원인으로
3회 이어지면 상태 머신이 `STUCK`으로 중단한다.
