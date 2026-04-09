---
name: star-prompt
description: >-
  CLI 프로젝트의 setup/postinstall 흐름에 GitHub 스타 요청을 추가한다.
  기본: 모달 차단형 (AskUserQuestion). --soft: 부드러운 confirm 모드.
  gh CLI 인증 확인 → 이미 스타 여부 감지 → 선택 강제 → gh API로 자동 스타.
  'star prompt', '스타 요청', '리포 스타', 'star request', '깃헙 스타 넣어줘',
  'star 눌러달라고', '응원 요청' 같은 요청에 사용한다.
---

# tfx-star-prompt — GitHub Star Request Prompt

CLI 도구의 setup/postinstall 완료 시점에 GitHub 리포 스타 요청을 추가한다.
기본 모드는 aggressive(모달 차단형)이며, `--soft`를 전달하면 기존 부드러운 confirm 모드로 폴백한다.
CI/비인터랙티브 환경에서는 자동으로 soft 모드로 강등한다.

## 동작 흐름

```
detectInteractive() ─── false → soft 모드 강제
       │
       ✓ true
       │
gh --version ─── 실패 → URL만 표시
       │
       ✓ 설치됨
       │
gh auth status ─── 실패 → URL만 표시
       │
       ✓ 인증됨
       │
gh api user/starred/{owner}/{repo}
       ├─ 성공 → "이미 함께하고 계시군요. ⭐" + markPrompted()
       ├─ 404  → 미스타로 진행
       └─ 그 외 에러 → 프롬프트 없이 URL만 표시 (마커 남기지 않음)
       │
       ✗ 미스타
       │
이미 프롬프트 본 유저(마커 존재)면 즉시 스킵
       │
aggressive 기본: AskUserQuestion([예, 누를게요] / [아니오]) 블로킹 선택
soft(--soft): confirm("⭐ 하나가 큰 차이를 만듭니다.")
       │
       ├─ 아니오 → aggressive: 안내 + URL / soft: URL만 + markPrompted()
       └─ 예
       │
       Y
       │
gh api -X PUT /user/starred/{owner}/{repo}
       ├─ 성공 → aggressive: "감사합니다! 여러분의 ⭐가 프로젝트를 성장시킵니다."
       │         soft: "함께해 주셔서 감사합니다. ⭐"
       └─ 실패 → URL 폴백
       │
모든 프롬프트 완료 경로는 markPrompted() 호출
```

## 구현 패턴

### 유틸리티 계약

- `ok(message)`: 성공 메시지 출력(초록/강조 톤)
- `info(message)`: 일반 안내 메시지 출력
- `warn(message)`: 경고/실패 폴백 메시지 출력
- `confirm(message, defaultValue)`: soft 모드용 Y/n 확인
- `askUserQuestion({ question, options })`: aggressive 모달 선택 UI
  - 옵션은 정확히 `[예, 누를게요]`, `[아니오]`
  - 선택 전까지 흐름을 블로킹한다

### 전체 `starRequest` 교체 패턴

아래 패턴으로 기존 `starRequest` 함수를 전면 교체한다.

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function detectInteractive() {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

function runGh(args) {
  return execFileSync("gh", args, {
    timeout: 10000,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function getHttpStatus(error) {
  const out = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
  const match = out.match(/HTTP\s+(\d{3})/i) || out.match(/\b(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

export async function starRequest({
  owner,
  repo,
  soft = false,
  askUserQuestion,
  confirm,
  ok,
  info,
  warn,
}) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const interactive = detectInteractive();
  const useSoft = soft || !interactive;

  const MARKER_DIR = path.join(os.homedir(), ".config", "star-prompt");
  const MARKER = path.join(MARKER_DIR, `${owner}-${repo}.prompted`);

  const markPrompted = () => {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.writeFileSync(MARKER, new Date().toISOString(), "utf8");
  };

  if (fs.existsSync(MARKER)) return;

  try {
    runGh(["--version"]);
  } catch {
    info(repoUrl);
    return;
  }

  try {
    runGh(["auth", "status"]);
  } catch {
    info(repoUrl);
    return;
  }

  let alreadyStarred = false;
  try {
    runGh(["api", `user/starred/${owner}/${repo}`]);
    alreadyStarred = true;
  } catch (error) {
    const status = getHttpStatus(error);
    if (status === 404) {
      alreadyStarred = false;
    } else {
      // API 에러(404 외): 프롬프트 없이 URL만 출력, 마커 미기록
      warn(repoUrl);
      return;
    }
  }

  if (alreadyStarred) {
    ok("이미 함께하고 계시군요. ⭐");
    markPrompted();
    return;
  }

  let accepted = false;
  if (useSoft) {
    accepted = await confirm("⭐ 하나가 큰 차이를 만듭니다.", true);
  } else {
    const answer = await askUserQuestion({
      question: "⭐ 이 프로젝트가 마음에 드셨나요? 스타를 누르시겠습니까?",
      options: ["예, 누를게요", "아니오"],
    });
    accepted = answer === "예, 누를게요";
  }

  if (!accepted) {
    if (useSoft) {
      info(repoUrl);
    } else {
      info(`괜찮습니다. 나중에 마음이 바뀌시면: ${repoUrl}`);
    }
    markPrompted();
    return;
  }

  try {
    runGh(["api", "-X", "PUT", `/user/starred/${owner}/${repo}`]);
    if (useSoft) {
      ok("함께해 주셔서 감사합니다. ⭐");
    } else {
      ok("감사합니다! 여러분의 ⭐가 프로젝트를 성장시킵니다.");
    }
  } catch {
    warn(repoUrl);
  } finally {
    markPrompted();
  }
}
```

## 적용 시 규칙

1. 기본 모드는 aggressive이며 `--soft` 전달 시에만 soft 모드로 전환한다.
2. CI/비인터랙티브 감지는 아래 조건으로 강제 soft 폴백한다.
   - `!process.stdout.isTTY || process.env.CI || process.env.TERM === "dumb"`
3. gh 설치 확인은 `which` 대신 `gh --version`으로 수행한다 (크로스플랫폼).
4. gh 인증 확인은 `gh auth status`로 수행한다.
5. 스타 여부 체크는 `gh api user/starred/{owner}/{repo}`를 사용하고, `404`만 미스타로 판단한다.
6. 스타 체크 API 에러가 `404` 외 상태면 프롬프트를 띄우지 않고 URL만 출력하며 마커를 남기지 않는다.
7. 중복 요청 방지를 위해 아래 마커를 사용한다.
   - `~/.config/star-prompt/{owner}-{repo}.prompted`
   - 이미 스타한 유저도 `markPrompted()`를 호출한다.
8. 모든 gh 호출은 `timeout: 10000`, `stdio: ["pipe","pipe","pipe"]`를 사용한다.
9. setup/postinstall의 핵심 성공/실패 처리 흐름을 막지 않도록, 스타 로직 실패는 모두 조용히 폴백한다.

## UX 카피 테이블

| 상황 | Aggressive (기본) | Soft (`--soft`) |
|------|-------------------|-----------------|
| 이미 스타 | `이미 함께하고 계시군요. ⭐` | (동일) |
| 요청 | `AskUserQuestion: ⭐ 이 프로젝트가 마음에 드셨나요? 스타를 누르시겠습니까?` | `⭐ 하나가 큰 차이를 만듭니다.` |
| 수락 후 | `감사합니다! 여러분의 ⭐가 프로젝트를 성장시킵니다.` | `함께해 주셔서 감사합니다. ⭐` |
| 거절 | `괜찮습니다. 나중에 마음이 바뀌시면:` + URL | URL만 |
| gh 미설치 | URL만 표시 | (동일) |
| gh 미인증 | URL만 표시 | (동일) |
| CI/비인터랙티브 | soft 자동 폴백 | (동일) |
| API 에러 (404 외) | 프롬프트 없이 URL만 표시, 마커 안 남김 | (동일) |
| 이미 프롬프트 본 유저 | 스킵 | (동일) |
