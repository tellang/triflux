---
name: star-prompt
description: >-
  CLI 프로젝트의 setup/postinstall 흐름에 GitHub 스타 요청 프롬프트를 추가한다.
  gh CLI 인증 확인 → 이미 스타 여부 감지 → 인터랙티브 confirm → gh API로 자동 스타.
  Apple 스타일 UX 카피 포함. 'star prompt', '스타 요청', '리포 스타', 'star request',
  '깃헙 스타 넣어줘', 'star 눌러달라고', '응원 요청' 같은 요청에 사용한다.
---

# tfx-star-prompt — GitHub Star Request Prompt

CLI 도구의 setup 완료 시점에 GitHub 리포 스타를 요청하는 프롬프트를 추가한다.
사용자 경험을 해치지 않으면서, 이미 스타한 사용자에겐 감사를 표하고, 아직 안 한 사용자에겐 부담 없이 한 번 물어본다.

## 동작 흐름

```
gh auth status ─── 실패 → URL만 표시 (비인터랙티브 폴백)
       │
       ✓ 인증됨
       │
gh api user/starred/{owner}/{repo} ─── 성공 → "이미 함께하고 계시군요. ⭐"
       │
       ✗ 미스타
       │
confirm("⭐ 하나가 큰 차이를 만듭니다.") ─── N → URL 조용히 표시
       │
       Y
       │
gh api -X PUT /user/starred/{owner}/{repo} → "함께해 주셔서 감사합니다. ⭐"
       │
       실패 → URL 폴백
```

## 구현 패턴

### 인터랙티브 (TUI / readline confirm)

setup 위저드 완료 후 호출. `confirm()` 으로 Y/n 입력 받고 `gh api`로 자동 스타.

```javascript
async function starRequest() {
  let ghOk = false;
  try {
    execFileSync("gh", ["auth", "status"], {
      timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    ghOk = true;
  } catch {}

  if (!ghOk) {
    // gh 미설치/미인증 — URL만 표시
    info(`⭐ 하나가 큰 차이를 만듭니다. https://github.com/{owner}/{repo}`);
    return;
  }

  let alreadyStarred = false;
  try {
    execFileSync("gh", ["api", "user/starred/{owner}/{repo}"], {
      timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    alreadyStarred = true;
  } catch {}

  if (alreadyStarred) {
    ok(`이미 함께하고 계시군요. ⭐`);
    return;
  }

  if (await confirm(`⭐ 하나가 큰 차이를 만듭니다.`, true)) {
    try {
      execFileSync("gh", ["api", "-X", "PUT", "/user/starred/{owner}/{repo}"], {
        timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      });
      ok(`함께해 주셔서 감사합니다. ⭐`);
    } catch {
      info(`https://github.com/{owner}/{repo}`);
    }
  } else {
    // 거절 시 URL만 조용히
    console.log(`     https://github.com/{owner}/{repo}`);
  }
}
```

### 비인터랙티브 (postinstall / CLI banner)

confirm 불가한 환경. 이미 스타 여부만 감지하고 메시지 분기.

```javascript
try {
  execFileSync("gh", ["auth", "status"], { timeout: 5000, stdio: ["pipe","pipe","pipe"] });
  try {
    execFileSync("gh", ["api", "user/starred/{owner}/{repo}"], { timeout: 5000, stdio: ["pipe","pipe","pipe"] });
    ok(`이미 함께하고 계시군요. ⭐`);
  } catch {
    info(`⭐ 하나가 큰 차이를 만듭니다. https://github.com/{owner}/{repo}`);
  }
} catch {
  info(`⭐ 하나가 큰 차이를 만듭니다. https://github.com/{owner}/{repo}`);
}
```

## 적용 시 규칙

1. `{owner}/{repo}`를 대상 리포로 치환한다
2. 프로젝트의 기존 ANSI 컬러 상수(AMBER, CYAN, RESET 등)를 사용한다
3. setup 완료 직후, 최종 요약 다음에 호출한다 — 핵심 설정 흐름을 방해하지 않는다
4. 모든 gh 호출은 `timeout: 5000`, `stdio: ["pipe","pipe","pipe"]`로 감싸서 실패해도 setup을 블로킹하지 않는다
5. 거절 시 죄책감을 주지 않는다 — URL만 조용히 남긴다

## UX 카피 톤

Apple 스타일: 짧고, 자신감 있고, 부담 없이.

| 상황 | 멘트 |
|------|------|
| 이미 스타 | `이미 함께하고 계시군요. ⭐` |
| 요청 | `⭐ 하나가 큰 차이를 만듭니다.` |
| 수락 후 | `함께해 주셔서 감사합니다. ⭐` |
| 거절 | URL만 |
| gh 없음 | `⭐ 하나가 큰 차이를 만듭니다.` + URL |
