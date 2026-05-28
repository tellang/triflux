# main lint 출처 분석

## 요약

- 실행 기준: `HEAD=ff7a66f279f2dcc994619f9c2996ea01b551419d`, `main`, `origin/main`이 모두 동일한 커밋.
- 실행 명령: `npm run lint`
- 실행 결과: `biome check bin config hooks hub hud mesh scripts tests .claude-plugin .github package.json package-lock.json biome.json`가 exit 1로 종료.
- Biome 요약: 707 files checked, `errors=1`, `warnings=2`, `infos=0`.
- 요청서의 "20 errors"는 현재 checkout의 `main`에서 재현되지 않았다. 현재 재현 가능한 실패 출처는 `tests/unit/native-bridge-interactive-transport.test.mjs` 한 파일의 포맷 오류 1건과 lint warning 2건이다.
- 재현된 3개 진단은 모두 source shard가 아닌 `main`에 이미 포함된 pre-existing drift로 판단한다. 런타임 동작 결함으로 볼 근거는 없다.

근거:

- `npm run lint` 캡처: `/tmp/triflux-main-lint-source-lint.txt`
- Biome JSON 확인: `/tmp/triflux-main-lint-source-biome.json`
- 해당 라인 blame: `a7c522010948f951866990dec47ad367eb330cfe` (`Harden interactive transport startup-prompt dismissal`)

## 파일별 표

| 파일 | rule | 건수 | 분류 | 권장조치 |
| --- | --- | ---: | --- | --- |
| `tests/unit/native-bridge-interactive-transport.test.mjs` | `format` | 1 | pre-existing drift | 별도 source-fix lease에서 Biome formatter 제안대로 `updatePromptScreen()`/`trustPromptScreen()`의 `.map()` 콜백을 한 줄 표현으로 정리한다. |
| `tests/unit/native-bridge-interactive-transport.test.mjs` | `lint/complexity/noAdjacentSpacesInRegex` | 2 | pre-existing drift | 별도 source-fix lease에서 `line.replace(/^  /, "› ")` 두 곳을 `line.replace(/^ {2}/, "› ")`로 바꿔 연속 공백 regex를 명시한다. |

## 출처/원인 분석

`tests/unit/native-bridge-interactive-transport.test.mjs`의 문제 라인은 `updatePromptScreen()`과 `trustPromptScreen()` 테스트 헬퍼 안에 있다. 두 헬퍼는 Codex TUI의 선택 커서처럼 보이도록 선행 공백 두 칸을 `› `로 치환한다.

Biome formatter error는 두 `.map((line) => ...)` 블록을 현재 포맷 규칙이 한 줄 삼항 표현으로 출력하려 하기 때문에 발생한다. 이는 포맷 drift이며 테스트 의미를 바꾸는 결함은 아니다.

`lint/complexity/noAdjacentSpacesInRegex` warning 2건은 `/^  /`가 시각적으로 두 칸인지 세기 어렵다는 Biome 규칙에서 나온다. 의도는 선행 공백 두 칸 치환으로 명확하며, 안전 수정안은 `/^ {2}/`이다. 따라서 실제 결함보다는 lint rule 표현 선호와 source formatting drift에 가깝다.

`git blame -L 39,63 -- tests/unit/native-bridge-interactive-transport.test.mjs` 기준으로 해당 블록 전체는 `a7c522010948f951866990dec47ad367eb330cfe`에서 도입되었고, 이 커밋은 현재 `main`에 포함되어 있다. 현재 shard는 report-only lease이므로 source 파일 수정은 하지 않았다.

## 다음 단계 권고

1. "20 errors" 기준이 필요한 경우, conductor가 사용한 정확한 커밋/워크트리/명령 로그를 다시 확인한다. 현재 `main` 재현 결과는 20건이 아니라 Biome error 1건 + warning 2건이다.
2. lint green을 목표로 하는 별도 source-fix shard를 열고, 수정 범위를 `tests/unit/native-bridge-interactive-transport.test.mjs`로 한정한다.
3. source-fix shard에서는 두 regex를 `/^ {2}/`로 바꾸고 Biome formatter 출력에 맞춘 뒤 `npm run lint`로 전체 lint가 통과하는지 재검증한다.
4. 이 report-only shard에서는 `.triflux/reports/main-lint-source.md` 외 파일을 커밋하지 않는다.
