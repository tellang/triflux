#!/usr/bin/env node
// hooks/safety-guard.mjs — PreToolUse:Bash 훅
//
// 위험한 Bash 명령을 사전 차단(exit 2)하거나 경고(additionalContext)한다.
// hooks.json에서 `if: "Bash(*)"` 필터와 함께 사용.
//
// 차단 레벨:
//   BLOCK (exit 2)  — 복구 불가능한 파괴적 명령
//   WARN  (allow + context) — 주의가 필요한 명령

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── 로컬 우회 플래그 ──────────────────────────────────────────
// LOCAL ONLY — Issue #89 대안 API 구현 전까지 psmux kill 시리즈 우회용.
// 활성 조건 (OR):
//   1) env: TFX_CLEANUP_BYPASS=1
//   2) 파일: .claude/cleanup-bypass 존재 (repo root)
// 파일 방식은 Claude Code Bash 도구가 훅에 env 전달 못하는 경우에도 동작.
// 정식 해결: hub/team/psmux.mjs 에 listSessions/killSessionByTitle/pruneStale 노출.
const CLEANUP_BYPASS = (() => {
  if (process.env.TFX_CLEANUP_BYPASS === "1") return true;
  try {
    return existsSync(join(process.cwd(), ".claude", "cleanup-bypass"));
  } catch {
    return false;
  }
})();

// ── 차단 규칙 ──────────────────────────────────────────────
const BLOCK_RULES = [
  {
    pattern: /\brm\s+(-[^\s]*)?-rf?\s+[/~](?!tmp\b)(?!\S*node_modules)/i,
    reason: "루트/홈 디렉토리 rm -rf 차단",
  },
  {
    pattern: /\brm\s+(-[^\s]*)?-rf?\s+\.\s*$/i,
    reason: "현재 디렉토리 rm -rf . 차단",
  },
  {
    pattern: /\bgit\s+push\s+.*--force\s+.*\b(main|master)\b/i,
    reason: "main/master force push 차단",
  },
  {
    pattern: /\bgit\s+push\s+--force\s*$/i,
    reason: "대상 미지정 force push 차단",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\s+origin\//i,
    reason: "remote reset --hard 차단 — 로컬 작업 소실 위험",
  },
  { pattern: /\bdrop\s+(table|database|schema)\b/i, reason: "SQL DROP 차단" },
  { pattern: /\btruncate\s+table\b/i, reason: "SQL TRUNCATE 차단" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "디스크 포맷 차단" },
  { pattern: /\b(del|rmdir)\s+\/[sq]\b/i, reason: "Windows 재귀 삭제 차단" },
  {
    pattern: /\bgit\s+clean\s+.*-fd/i,
    reason: "git clean -fd 차단 — 추적되지 않은 파일 소실 위험",
  },
  {
    pattern: /\bpsmux\s+kill-session\b/i,
    reason:
      "raw psmux kill-session 차단 — WT ConPTY 프리징 위험. 대안: listSessions()/killSessionByTitle()/pruneStale() 또는 node hub/team/psmux.mjs --internal kill-by-title <prefix|/regex/> (또는 TFX_CLEANUP_BYPASS=1/.claude/cleanup-bypass)",
    skipIfGit: true,
    cleanupBypass: true,
  },
  {
    pattern: /\bpsmux\s+kill-server\b/i,
    reason:
      "psmux kill-server 차단 — 모든 세션이 즉시 종료됩니다. node hub/team/psmux.mjs kill-swarm 사용 (또는 TFX_CLEANUP_BYPASS=1)",
    skipIfGit: true,
    cleanupBypass: true,
  },
];

const WT_DIRECT_PATTERNS = [
  /\bwt\.exe\b/i,
  /\bwt\s+new-tab\b/i,
  /\bwt\s+split-pane\b/i,
  /\bwt\s+-w\b/i,
  /\bStart-Process\s+wt/i,
  /\bStart-Process\s+['"]?wt\.exe/i,
];

const WT_DIRECT_BLOCK_MESSAGE =
  "[safety-guard] wt.exe 직접 호출 차단됨.\n" +
  "→ hub/team/wt-manager.mjs의 createWtManager() 팩토리 사용:\n" +
  "  wt.createTab({ title, command, profile, cwd })  — 새 탭\n" +
  "  wt.splitPane({ direction: 'H'|'V', title, command })  — 패인 분할\n" +
  "  wt.applySplitLayout([{ title, command, direction }])  — 다중 배치\n" +
  "사용법: node -e \"import('./hub/team/wt-manager.mjs').then(m => { const wt = m.createWtManager(); wt.createTab({ title: '제목', command: 'pwsh' }); })\"";

const PSMUX_INTERNAL_WRAPPER_PATTERNS = [
  /node(?:\.exe)?\s+.*hub[\\/]+team[\\/]+psmux\.mjs\s+--internal\s+(?:list|kill-by-title|prune-stale)\b/i,
];

// ── SSH+PowerShell bash 문법 차단 ────────────────────────────
// 원격 기본 셸이 PowerShell인 호스트에 bash redirect/glob을 보내면 오동작
// macOS/Linux 대상 SSH에는 bash 문법이 정상이므로 hosts.json OS를 확인한다.
const BASH_SYNTAX_IN_SSH = [
  /2>\/dev\/null/, // 2>/dev/null → PowerShell에서 Out-File C:\dev\null
  />\s*\/dev\/null/, // >/dev/null
  /&>\s*\/dev\/null/, // &>/dev/null
  /\$\(/, // $(cmd) → PowerShell에서 다른 의미
  /\bsource\s+/, // source → PowerShell에 없음
  /\bexport\s+\w+=/, // export VAR= → PowerShell에 없음
];

const SSH_POWERSHELL_HINT =
  "원격 셸이 PowerShell입니다. bash 문법 직접 전달 금지. scp + pwsh -File 패턴 사용. " +
  "2>/dev/null → 2>$null, $() → $(), export → $env:, source → . (dot-source)";

/** hosts.json에서 Windows 호스트 식별자 집합을 구축한다. */
function getWindowsHostIds() {
  const ids = new Set();
  try {
    const paths = [
      join(process.cwd(), "references", "hosts.json"),
      join(process.cwd(), "packages", "triflux", "references", "hosts.json"),
    ];
    let hostsConfig = null;
    for (const p of paths) {
      if (existsSync(p)) {
        hostsConfig = JSON.parse(readFileSync(p, "utf8"));
        break;
      }
    }
    if (!hostsConfig?.hosts) return ids;
    for (const [name, cfg] of Object.entries(hostsConfig.hosts)) {
      if (cfg.os !== "windows") continue;
      ids.add(name);
      if (cfg.tailscale?.ip) ids.add(cfg.tailscale.ip);
      if (cfg.tailscale?.dns) ids.add(cfg.tailscale.dns);
      if (cfg.ssh_user) {
        ids.add(`${cfg.ssh_user}@${name}`);
        if (cfg.tailscale?.ip) ids.add(`${cfg.ssh_user}@${cfg.tailscale.ip}`);
      }
    }
  } catch {
    // hosts.json 로드 실패 시 빈 집합 → 차단 안 함 (POSIX 기본)
  }
  return ids;
}

/** SSH 명령의 대상이 Windows 호스트인지 판별한다. */
function isSshTargetWindows(command) {
  const winIds = getWindowsHostIds();
  if (winIds.size === 0) return false; // Windows 호스트 없으면 POSIX 가정
  for (const id of winIds) {
    if (command.includes(id)) return true;
  }
  return false;
}

// ── 경고 규칙 ──────────────────────────────────────────────
const WARN_RULES = [
  {
    pattern: /\bgit\s+push\b(?!.*--force)/i,
    warn: "git push 감지. 원격 저장소에 반영됩니다.",
  },
  {
    pattern: /\bgit\s+rebase\b/i,
    warn: "git rebase 감지. 커밋 히스토리가 변경됩니다.",
  },
  { pattern: /\bgit\s+branch\s+-[dD]\b/i, warn: "브랜치 삭제 감지." },
  {
    pattern: /\bnpm\s+publish\b/i,
    warn: "npm publish 감지. 공개 레지스트리에 배포됩니다.",
  },
  {
    pattern: /\brm\s+(-[^\s]*)?-rf?\s/i,
    warn: "재귀 삭제 감지. 대상을 확인하세요.",
  },
  {
    pattern: /--no-verify\b/i,
    warn: "--no-verify 감지. 훅 건너뛰기는 권장하지 않습니다.",
  },
  { pattern: /\bchmod\s+777\b/i, warn: "chmod 777 감지. 보안 위험." },
  {
    pattern: /\bcurl\s.*\|\s*(bash|sh)\b/i,
    warn: "curl | sh 감지. 원격 스크립트 실행 주의.",
  },
];

// ── reflexion 적응형 패널티 로드 ──────────────────────────────
function loadReflexionPenalties() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const penaltyFile = join(
      home,
      ".triflux",
      "reflexion",
      "pending-penalties.jsonl",
    );
    if (!existsSync(penaltyFile)) return [];
    return readFileSync(penaltyFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function shouldSkipSegment(segment) {
  return (
    !segment ||
    segment.startsWith("#") ||
    /^\s*(echo|printf|grep|git\s+commit)\b/i.test(segment)
  );
}

function hasSegmentInvocation(cmd, patterns) {
  if (!patterns.some((pattern) => pattern.test(cmd))) return false;

  const lines = cmd.split(/\n/);
  let heredocDelimiter = null;
  return lines.some((line) => {
    if (heredocDelimiter !== null) {
      if (line.trim() === heredocDelimiter) heredocDelimiter = null;
      return false;
    }

    const heredocMatch = line.match(/<<['"]?(\w+)['"]?/);
    if (heredocMatch) {
      heredocDelimiter = heredocMatch[1];
      return false;
    }

    const segments = line.split(/\s*(?:&&|;|\|\|)\s*/);
    return segments.some((seg) => {
      const trimmed = seg.trim();
      if (shouldSkipSegment(trimmed)) return false;
      return patterns.some((pattern) => pattern.test(trimmed));
    });
  });
}

function blockCommand(message, command) {
  process.stderr.write(
    `${message}\n` +
      `명령어: ${command.slice(0, 120)}${command.length > 120 ? "..." : ""}\n` +
      "이 명령은 실행할 수 없습니다. 안전한 대안을 사용하세요.",
  );
  process.exit(2);
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
    return hasSegmentInvocation(cmd, [/\bpsmux\s+kill-(session|server)\b/i]);
  }

  function isAllowedPsmuxWrapperInvocation(cmd) {
    return hasSegmentInvocation(cmd, PSMUX_INTERNAL_WRAPPER_PATTERNS);
  }

  function isWtDirectInvocation(cmd) {
    return hasSegmentInvocation(cmd, WT_DIRECT_PATTERNS);
  }

  if (isWtDirectInvocation(command)) {
    blockCommand(WT_DIRECT_BLOCK_MESSAGE, command);
  }

  if (isAllowedPsmuxWrapperInvocation(command)) {
    process.exit(0);
  }

  // 0.1. reflexion 적응형 패널티 — 이전 세션에서 차단된 패턴 사전 경고
  const penalties = loadReflexionPenalties();
  if (penalties.length > 0) {
    for (const penalty of penalties) {
      if (
        penalty.error_pattern &&
        new RegExp(
          penalty.error_pattern
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .slice(0, 80),
          "i",
        ).test(command)
      ) {
        const output = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            additionalContext:
              `[reflexion] 이전 세션에서 차단된 패턴과 유사합니다 (${penalty.source}, ${penalty.ts?.slice(0, 10)}). ` +
              `이전 차단 사유: ${penalty.error_pattern?.slice(0, 100)}`,
          },
        };
        process.stdout.write(JSON.stringify(output));
        process.exit(0);
      }
    }
  }

  // 0.5. SSH → Windows(PowerShell) 호스트에만 bash 문법 전달 차단
  // macOS/Linux 대상은 bash/zsh이므로 허용. hosts.json OS로 판별.
  if (
    hasSegmentInvocation(command, [/^\s*ssh\s+/i]) &&
    isSshTargetWindows(command)
  ) {
    const segments = command.split(/\s*(?:&&|;|\|\||\|)\s*/);
    for (const seg of segments) {
      const sshMatch = seg.trim().match(/^ssh\s+\S+\s+(.*)/s);
      if (!sshMatch) continue;
      const sshPayload = sshMatch[1];
      const bashSyntax = BASH_SYNTAX_IN_SSH.find((p) => p.test(sshPayload));
      if (bashSyntax) {
        blockCommand(
          `[safety-guard] SSH 명령에 bash 전용 문법 감지: ${bashSyntax}. ${SSH_POWERSHELL_HINT}`,
          command,
        );
      }
    }
  }

  // 1. BLOCK 체크 — exit 2로 차단
  for (const rule of BLOCK_RULES) {
    if (rule.cleanupBypass && CLEANUP_BYPASS) continue;
    if (rule.skipIfGit && !isPsmuxInvocation(command)) continue;
    if (rule.pattern.test(command)) {
      blockCommand(`[triflux safety-guard] BLOCKED: ${rule.reason}`, command);
    }
  }

  // wt 정리 명령 우회 (TFX_CLEANUP_BYPASS=1 한정). new-tab/split-pane만 차단 유지하려면 아래 조건 세분화.
  if (CLEANUP_BYPASS) {
    // bypass 모드에서는 아래 wt 검사를 이미 통과한 상태. 추가 작업 없음.
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
