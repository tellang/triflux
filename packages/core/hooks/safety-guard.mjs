#!/usr/bin/env node
// hooks/safety-guard.mjs — PreToolUse:Bash 훅
//
// 위험한 Bash 명령을 사전 차단(exit 2)하거나 경고(additionalContext)한다.
// hooks.json에서 `if: "Bash(*)"` 필터와 함께 사용.
//
// 차단 레벨:
//   BLOCK (exit 2)  — 복구 불가능한 파괴적 명령
//   WARN  (allow + context) — 주의가 필요한 명령

import { readFileSync } from "node:fs";

// ── 차단 규칙 ──────────────────────────────────────────────
const BLOCK_RULES = [
  { pattern: /\brm\s+(-[^\s]*)?-rf?\s+[/~](?!tmp\b)(?!\S*node_modules)/i, reason: "루트/홈 디렉토리 rm -rf 차단" },
  { pattern: /\brm\s+(-[^\s]*)?-rf?\s+\.\s*$/i, reason: "현재 디렉토리 rm -rf . 차단" },
  { pattern: /\bgit\s+push\s+.*--force\s+.*\b(main|master)\b/i, reason: "main/master force push 차단" },
  { pattern: /\bgit\s+push\s+--force\s*$/i, reason: "대상 미지정 force push 차단" },
  { pattern: /\bgit\s+reset\s+--hard\s+origin\//i, reason: "remote reset --hard 차단 — 로컬 작업 소실 위험" },
  { pattern: /\bdrop\s+(table|database|schema)\b/i, reason: "SQL DROP 차단" },
  { pattern: /\btruncate\s+table\b/i, reason: "SQL TRUNCATE 차단" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "디스크 포맷 차단" },
  { pattern: /\b(del|rmdir)\s+\/[sq]\b/i, reason: "Windows 재귀 삭제 차단" },
  { pattern: /\bgit\s+clean\s+.*-fd/i, reason: "git clean -fd 차단 — 추적되지 않은 파일 소실 위험" },
  { pattern: /\bpsmux\s+kill-session\b/i, reason: "raw psmux kill-session 차단 — WT ConPTY 프리징 위험. 안전 경로: node hub/team/psmux.mjs kill --session <name>", skipIfGit: true },
  { pattern: /\bpsmux\s+kill-server\b/i, reason: "psmux kill-server 차단 — 모든 세션이 즉시 종료됩니다. node hub/team/psmux.mjs kill-swarm 사용", skipIfGit: true },
];

// ── 경고 규칙 ──────────────────────────────────────────────
const WARN_RULES = [
  { pattern: /\bgit\s+push\b(?!.*--force)/i, warn: "git push 감지. 원격 저장소에 반영됩니다." },
  { pattern: /\bgit\s+rebase\b/i, warn: "git rebase 감지. 커밋 히스토리가 변경됩니다." },
  { pattern: /\bgit\s+branch\s+-[dD]\b/i, warn: "브랜치 삭제 감지." },
  { pattern: /\bnpm\s+publish\b/i, warn: "npm publish 감지. 공개 레지스트리에 배포됩니다." },
  { pattern: /\brm\s+(-[^\s]*)?-rf?\s/i, warn: "재귀 삭제 감지. 대상을 확인하세요." },
  { pattern: /--no-verify\b/i, warn: "--no-verify 감지. 훅 건너뛰기는 권장하지 않습니다." },
  { pattern: /\bchmod\s+777\b/i, warn: "chmod 777 감지. 보안 위험." },
  { pattern: /\bcurl\s.*\|\s*(bash|sh)\b/i, warn: "curl | sh 감지. 원격 스크립트 실행 주의." },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
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

  if (input.tool_name !== "Bash") process.exit(0);

  const command = (input.tool_input?.command || "").trim();
  if (!command) process.exit(0);

  // psmux 명령이 실제 CLI 호출인지 판별 (오탐 방지)
  // git commit 메시지, echo, grep, cat, heredoc 안의 텍스트는 무시
  function isPsmuxInvocation(cmd) {
    // psmux kill-session/server가 명령에 없으면 즉시 false
    if (!/\bpsmux\s+kill-(session|server)\b/i.test(cmd)) return false;

    // 줄 분할 → heredoc 경계 추적 → 세그먼트 분할(&&, ;, ||)로 각 명령 단위 검사
    // 세그먼트가 echo/grep/git-commit으로 시작하면 인자 텍스트이므로 무시
    const lines = cmd.split(/\n/);
    let heredocDelimiter = null;
    return lines.some((line) => {
      // heredoc 내부이면 닫는 구분자인지만 확인하고 건너뜀
      if (heredocDelimiter !== null) {
        if (line.trim() === heredocDelimiter) heredocDelimiter = null;
        return false;
      }
      // heredoc 시작 감지: <<'WORD', <<"WORD", <<WORD
      const heredocMatch = line.match(/<<['"]?(\w+)['"]?/);
      if (heredocMatch) {
        heredocDelimiter = heredocMatch[1];
        // heredoc 시작 줄 자체는 실제 명령이므로 계속 검사하되
        // 시작 줄에 psmux kill이 포함될 리 없으므로 여기서 false 반환
        return false;
      }
      const segments = line.split(/\s*(?:&&|;|\|\|)\s*/);
      return segments.some((seg) => {
        const t = seg.trim();
        if (!t || t.startsWith("#")) return false;
        if (/^\s*(echo|printf|grep|git\s+commit)\b/i.test(t)) return false;
        return /\bpsmux\s+kill-(session|server)\b/i.test(t);
      });
    });
  }

  // 1. BLOCK 체크 — exit 2로 차단
  for (const rule of BLOCK_RULES) {
    if (rule.skipIfGit && !isPsmuxInvocation(command)) continue;
    if (rule.pattern.test(command)) {
      process.stderr.write(
        `[triflux safety-guard] BLOCKED: ${rule.reason}\n` +
          `명령어: ${command.slice(0, 120)}${command.length > 120 ? "..." : ""}\n` +
          `이 명령은 실행할 수 없습니다. 안전한 대안을 사용하세요.`
      );
      process.exit(2);
    }
  }

  // 2. WARN 체크 — allow + additionalContext
  const warnings = [];
  for (const rule of WARN_RULES) {
    if (rule.pattern.test(command)) {
      warnings.push(rule.warn);
    }
  }

  if (warnings.length > 0) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext:
          `[safety-guard] ⚠ ${warnings.join(" | ")}\n` +
          `명령어: ${command.slice(0, 200)}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  // 3. 안전한 명령 → 통과
  process.exit(0);
}

try {
  main();
} catch {
  // 훅 실패 시 블로킹하지 않음
  process.exit(0);
}
