---
id: 0034
title: headless 세션마다 결과 색인 JSON 하나를 둔다
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0015, 0029]
pr: null
---

# ADR-0034: headless 세션마다 결과 색인 JSON 하나를 둔다

## 컨텍스트와 문제

headless 실행이 남기는 결과는 두 가지였다.

- 워커별 출력 파일 `$TMPDIR/tfx-headless/<세션>-worker-N.txt` 와 `.err`, `.partial`.
- 표준 출력의 완료 마커 `=== HEADLESS_COMPLETE succeeded=N failed=N total=N ===` 와 사람이 읽는 요약.

워커별 상태와 exit 코드는 화면 문자열에만 있었다. 그래서 결과를 읽는 쪽은 출력 문자열을 해석해야 했고, 원격에서 회수할 때는 워커 수만큼 파일을 모은 뒤 완료 여부를 따로 추측해야 했다. 실행이 중간에 끝나면 어느 워커가 끝났는지 알 방법이 없었다.

## 결정

headless 세션마다 결과 색인 파일 하나를 둔다. 워커별 색인 파일은 만들지 않는다.

- 위치: 워커 출력 파일과 같은 디렉터리의 `$TMPDIR/tfx-headless/<세션>.results.json`.
- 쓰는 곳: `hub/team/results-index.mjs` 의 `createResultsIndex`. `runHeadless` 가 진행 이벤트를 받아 갱신한다.
- 경로 조회: `headlessResultsIndexPath(sessionName)`. `runHeadless` 와 `runHeadlessInteractive` 핸들은 `resultsIndexPath` 로 돌려주고, `tfx multi` 는 완료 마커 다음 줄에 경로를 출력한다.

스키마는 `version: 1` 이다. 필드 이름과 상태 값은 기존 코드(`collectResults`, TUI 워커 상태)를 따른다.

```json
{
  "version": 1,
  "sessionName": "tfx-hl-abc123",
  "startedAt": "2026-10-08T05:00:00.000Z",
  "finishedAt": null,
  "completed": false,
  "workers": [
    {
      "paneName": "worker-1", "displayName": "impl", "cli": "codex", "role": "executor",
      "status": "completed", "matched": true, "exitCode": 0, "sessionDead": false,
      "startedAt": "...", "finishedAt": "...",
      "resultFile": "$TMPDIR/tfx-headless/tfx-hl-abc123-worker-1.txt"
    }
  ]
}
```

- 워커 `status` 는 `pending`, `running`, `completed`, `failed` 중 하나다. 디스패치되면 `running`, 끝나면 `matched && exitCode === 0` 일 때 `completed`, 아니면 `failed` 다. 화면 마커의 succeeded 판정과 같다.
- 세션 `finishedAt` 은 실행이 끝나면 채운다. `completed` 는 모든 워커의 대기와 결과 수집이 예외 없이 끝났을 때만 `true` 다. 실행 중 예외로 끝나면 `finishedAt` 은 채우고 `completed` 는 `false` 로 남긴다.
- 쓰기 시점: 워커가 디스패치될 때, 워커가 끝날 때, 세션이 끝날 때마다 파일 전체를 다시 쓴다.
- 원자적 쓰기: 같은 디렉터리의 `<색인>.<pid>.tmp` 에 쓴 뒤 `rename` 한다. 읽는 쪽은 반쯤 쓴 JSON 을 보지 않는다.
- 소유권: 실행이 그 이름의 멀티플렉서 세션을 소유한 동안만 쓴다. 세션 이름이 겹쳐 생성이 실패하면 남의 색인을 덮어쓰지 않는다.
- 쓰기 실패는 실행을 멈추지 않는다. 색인은 보조 산출물이다.

`finishedAt` 이 `null` 인데 같은 이름의 멀티플렉서 세션(`tmux has-session -t <sessionName>`)이 없으면, 실행이 중간에 죽은 것으로 판단하고 `running` 워커는 결과가 없는 것으로 본다. 그 워커의 출력은 `resultFile` 과 `.partial`, `.err` 에 남은 만큼만 있다.

화면의 `HEADLESS_COMPLETE` 마커와 요약 출력은 그대로 둔다. 마커는 기존 소비자를 위한 완료 신호로 남고, 워커별 상태와 exit 코드는 색인 파일을 정본으로 읽는다.

## 검토한 대안

- **워커별 결과 JSON**: 워커마다 `<세션>-worker-N.json` 을 둔다. 쓰기 경합은 없지만 읽는 쪽이 파일을 모아야 하고 세션 완료를 표시할 곳이 없다. 사용자 결정으로 기각했다.
- **완료 마커 확장**: 마커 줄에 워커별 상태를 덧붙인다. 표준 출력을 받는 쪽만 읽을 수 있고, 실행이 죽으면 마커 자체가 나오지 않는다.
- **세션이 끝날 때 한 번만 쓰기**: 구현은 가장 단순하지만 실행 중이나 중간에 죽은 경우 아무것도 남지 않는다.

## 결과

- 결과를 읽는 쪽은 JSON 하나로 세션 완료 여부와 워커별 상태, exit 코드, 출력 경로를 얻는다. 원격 회수도 파일 하나를 먼저 가져오면 된다.
- 워커 상태가 바뀔 때마다 파일 전체를 다시 쓴다. 워커 수가 한 자릿수라 비용은 무시할 만하다.
- `runHeadlessInteractive` 핸들로 나중에 보내는 후속 명령은 색인에 반영하지 않는다. 색인은 첫 디스패치 회차의 결과만 담는다.
- 결과 디렉터리의 오래된 파일은 기존 `scripts/tmp-cleanup.mjs` 가 수정 시각 기준으로 함께 지운다.
- 스키마를 바꾸면 `version` 을 올린다. 읽는 쪽은 모르는 `version` 을 만나면 화면 마커로 폴백한다.
