#!/usr/bin/env node
// hooks/error-context.mjs — PostToolUseFailure 훅
//
// 도구 실패 시 에러 패턴을 분석하여 해결 힌트를 additionalContext로 주입한다.
// Claude가 동일 에러를 반복하지 않도록 구체적 가이드를 제공.

import { readFileSync } from "node:fs";

// ── 에러 패턴 → 해결 힌트 매핑 ─────────────────────────────
const ERROR_HINTS = [
  // Node.js / npm
  {
    pattern: /ENOENT.*no such file or directory/i,
    hint: "파일/디렉토리가 존재하지 않습니다. 경로를 확인하거나 mkdir -p로 디렉토리를 먼저 생성하세요.",
  },
  {
    pattern: /EACCES.*permission denied/i,
    hint: "권한 부족. Windows에서는 관리자 권한, Unix에서는 chmod/sudo를 확인하세요.",
  },
  {
    pattern: /EADDRINUSE/i,
    hint: "포트가 이미 사용 중입니다. lsof -i :{port} 또는 netstat -ano | findstr :{port}로 확인 후 프로세스를 종료하세요.",
  },
  {
    pattern: /ERR_MODULE_NOT_FOUND|Cannot find module/i,
    hint: "모듈을 찾을 수 없습니다. npm install을 실행하거나, import 경로에 .mjs/.js 확장자를 명시하세요.",
  },
  {
    pattern: /ETARGET|ERR_INVALID_PACKAGE_TARGET/i,
    hint: "패키지 버전 해석 실패. package.json의 exports 필드 또는 의존성 버전을 확인하세요.",
  },
  {
    pattern: /npm ERR! code E40[134]/i,
    hint: "npm 인증 오류. npm login 또는 .npmrc 토큰을 확인하세요.",
  },

  // Git
  {
    pattern: /fatal: not a git repository/i,
    hint: "git 저장소가 아닙니다. git init 또는 올바른 디렉토리로 이동하세요.",
  },
  {
    pattern: /merge conflict|CONFLICT.*Merge/i,
    hint: "병합 충돌 발생. 충돌 파일을 수동 해결 후 git add + git commit 하세요.",
  },
  {
    pattern: /rejected.*non-fast-forward/i,
    hint: "원격에 새 커밋이 있습니다. git pull --rebase 후 다시 push하세요.",
  },
  {
    pattern: /fatal: refusing to merge unrelated histories/i,
    hint: "--allow-unrelated-histories 플래그가 필요할 수 있습니다.",
  },

  // Python
  {
    pattern: /ModuleNotFoundError/i,
    hint: "Python 모듈 미설치. pip install 또는 가상환경 활성화를 확인하세요.",
  },
  {
    pattern: /SyntaxError.*invalid syntax/i,
    hint: "Python 문법 오류. Python 버전(2 vs 3) 호환성도 확인하세요.",
  },

  // Windows 특이
  {
    pattern: /is not recognized as an internal or external command/i,
    hint: "명령어를 찾을 수 없습니다. PATH 환경변수를 확인하거나 절대 경로를 사용하세요.",
  },
  {
    pattern: /execution policy/i,
    hint: "PowerShell 실행 정책 제한. -ExecutionPolicy Bypass 플래그를 추가하세요.",
  },
  {
    pattern: /The process cannot access the file because it is being used/i,
    hint: "파일이 다른 프로세스에 의해 잠겨 있습니다. 해당 프로세스를 종료하거나 잠시 후 재시도하세요.",
  },

  // 일반
  {
    pattern: /timeout|timed out|ETIMEDOUT/i,
    hint: "타임아웃 발생. 네트워크 상태를 확인하거나 timeout 값을 늘리세요.",
  },
  {
    pattern: /out of memory|heap|ENOMEM/i,
    hint: "메모리 부족. --max-old-space-size를 늘리거나 데이터 크기를 줄이세요.",
  },
  {
    pattern: /ECONNREFUSED/i,
    hint: "연결 거부. 대상 서버/서비스가 실행 중인지 확인하세요.",
  },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function findHints(errorText) {
  const hints = [];
  for (const rule of ERROR_HINTS) {
    if (rule.pattern.test(errorText)) {
      hints.push(rule.hint);
    }
  }
  return hints;
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // tool_output 또는 error 필드에서 에러 텍스트 추출
  const errorText = [
    input.tool_output || "",
    input.error || "",
    input.tool_input?.command || "",
    JSON.stringify(input.tool_result || ""),
  ].join("\n");

  const hints = findHints(errorText);
  if (hints.length === 0) process.exit(0);

  const toolName = input.tool_name || "Unknown";
  const output = {
    systemMessage:
      `[error-context] ${toolName} 실패 — 해결 힌트:\n` +
      hints.map((h) => `  → ${h}`).join("\n"),
  };

  process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch {
  process.exit(0);
}
