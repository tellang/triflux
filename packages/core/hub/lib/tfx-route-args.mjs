// hub/lib/tfx-route-args.mjs
// Phase 3 Step B — tfx-auto / tfx-route 플래그 파서.
// 설계 문서: .triflux/plans/phase3-lead-codex-ralph-escalate.md
//
// 입력: ARGUMENTS 문자열 또는 토큰 배열.
// 출력: {cli, mode, parallel, retry, isolation, remote, lead, noClaudeNative,
//        maxIterations, task, warnings}.
//
// 기존 플래그 (Phase 2 v10.9.33+):
//   --cli {auto|codex|gemini|claude}
//   --mode {quick|deep|consensus}
//   --parallel {1|N|swarm}
//   --retry {0|1|ralph|auto-escalate}    (Phase 3 에서 ralph/auto-escalate 신규)
//   --isolation {none|worktree}
//   --remote {none|<host>}
//
// Phase 3 신규:
//   --lead {claude|codex}             (tfx-auto-codex 의미 흡수)
//   --no-claude-native                (Claude native sub-agent 경로 disable)
//   --max-iterations <N>              (ralph / auto-escalate 상한, 0=unlimited)

import { hasCodeChange } from "./staged-file-detect.mjs";

export const DEFAULT_OPTIONS = Object.freeze({
  cli: "auto",
  mode: "quick",
  parallel: "1",
  retry: "1",
  isolation: "none",
  remote: "none",
  lead: "claude",
  noClaudeNative: false,
  maxIterations: 0,
});

const VALID_VALUES = Object.freeze({
  cli: ["auto", "codex", "gemini", "claude"],
  mode: ["quick", "deep", "consensus"],
  retry: ["0", "1", "ralph", "auto-escalate"],
  isolation: ["none", "worktree"],
  lead: ["claude", "codex"],
});

const VALUE_FLAGS = new Set([
  "--cli",
  "--mode",
  "--parallel",
  "--retry",
  "--isolation",
  "--remote",
  "--lead",
  "--max-iterations",
]);

const BOOL_FLAGS = new Set(["--no-claude-native"]);

export function parseArgs(input) {
  const tokens = Array.isArray(input)
    ? input.slice()
    : tokenize(String(input || ""));
  const opts = { ...DEFAULT_OPTIONS };
  const warnings = [];
  const taskTokens = [];

  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i];

    if (BOOL_FLAGS.has(raw)) {
      applyBool(opts, raw);
      i += 1;
      continue;
    }

    // --flag=value 지원
    const eqIdx = raw.indexOf("=");
    let flag = raw;
    let value = null;
    if (eqIdx > 0 && raw.startsWith("--")) {
      flag = raw.slice(0, eqIdx);
      value = raw.slice(eqIdx + 1);
    }

    if (VALUE_FLAGS.has(flag)) {
      if (value === null) {
        const next = tokens[i + 1];
        if (next === undefined || next.startsWith("--")) {
          warnings.push(`${flag} needs a value`);
          i += 1;
          continue;
        }
        value = next;
        i += 2;
      } else {
        i += 1;
      }
      applyValue(opts, flag, value, warnings);
      continue;
    }

    if (raw.startsWith("--")) {
      warnings.push(`unknown flag: ${raw}`);
      i += 1;
      continue;
    }

    taskTokens.push(raw);
    i += 1;
  }

  validate(opts, warnings);

  return {
    ...opts,
    task: taskTokens.join(" ").trim(),
    warnings,
  };
}

function tokenize(str) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function applyBool(opts, flag) {
  switch (flag) {
    case "--no-claude-native":
      opts.noClaudeNative = true;
      break;
  }
}

function applyValue(opts, flag, value, warnings) {
  switch (flag) {
    case "--cli":
      opts.cli = value;
      break;
    case "--mode":
      opts.mode = value;
      break;
    case "--parallel":
      opts.parallel = value;
      break;
    case "--retry":
      opts.retry = value;
      break;
    case "--isolation":
      opts.isolation = value;
      break;
    case "--remote":
      opts.remote = value;
      break;
    case "--lead":
      opts.lead = value;
      break;
    case "--max-iterations": {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n < 0) {
        warnings.push(
          `invalid --max-iterations=${value}, expected non-negative integer (0=unlimited)`,
        );
      } else {
        opts.maxIterations = n;
      }
      break;
    }
  }
}

function validate(opts, warnings) {
  for (const key of Object.keys(VALID_VALUES)) {
    if (!VALID_VALUES[key].includes(opts[key])) {
      warnings.push(
        `invalid --${key}=${opts[key]}, expected one of ${VALID_VALUES[key].join("|")}`,
      );
    }
  }
  if (
    opts.parallel !== "1" &&
    opts.parallel !== "swarm" &&
    !/^\d+$/.test(opts.parallel)
  ) {
    warnings.push(`invalid --parallel=${opts.parallel}, expected 1|N|swarm`);
  }
  const parallelOne = opts.parallel === "1" || opts.parallel === 1;
  if (parallelOne && opts.isolation === "worktree") {
    warnings.push(
      "--isolation worktree requires --parallel >=2 or swarm; forcing isolation=none",
    );
    opts.isolation = "none";
  }
  if (opts.remote !== "none" && opts.parallel !== "swarm") {
    warnings.push(
      `--remote ${opts.remote} ignored (requires --parallel swarm)`,
    );
  }
}

export { VALID_VALUES };

/**
 * Decide dispatch mode based on parsed args and current git state.
 *
 * Issue #281: auto router code changes should use isolated swarm dispatch for
 * multi-task work unless the user explicitly selected local parallel mode.
 *
 * @param {object} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Function} [opts.detector]
 * @returns {{
 *   mode: "single" | "multi" | "swarm",
 *   escalated: boolean,
 *   warning: string | null,
 *   reason: string,
 * }}
 */
export function decideDispatchMode(
  args = {},
  { cwd = process.cwd(), detector = hasCodeChange } = {},
) {
  const tasksCount = countTasks(args);
  const parallel = normalizeParallel(args.parallel);
  const hasUserParallel = parallel !== null && parallel !== "1";
  const hasUserSwarm = parallel === "swarm" || args.isolation === "worktree";
  const codeChanged = Boolean(detector({ cwd }));

  if (hasUserSwarm) {
    return {
      mode: "swarm",
      escalated: false,
      warning: null,
      reason: "user-explicit-swarm",
    };
  }

  if (hasUserParallel && codeChanged) {
    return {
      mode: "multi",
      escalated: false,
      warning: `[tfx-auto] WARNING: 코드 변경 감지 (cwd race 위험). --parallel swarm --isolation worktree 권장. 사용자 명시 --parallel=${args.parallel} 존중하여 multi 로 진행.`,
      reason: "user-explicit-multi-with-code-change",
    };
  }

  if (tasksCount >= 2 && codeChanged) {
    return {
      mode: "swarm",
      escalated: true,
      warning: `[tfx-auto] 코드 변경 ${tasksCount}건 태스크 + dirty cwd 감지. swarm dispatch 자동 escalate (--parallel swarm --isolation worktree). Issue #281.`,
      reason: "auto-escalate-code-change",
    };
  }

  if (tasksCount >= 2 || hasUserParallel) {
    return {
      mode: "multi",
      escalated: false,
      warning: null,
      reason: "multi-no-code-change",
    };
  }

  return {
    mode: "single",
    escalated: false,
    warning: null,
    reason: "single-task",
  };
}

function countTasks(args) {
  if (Array.isArray(args.tasks)) return args.tasks.length;
  if (typeof args.tasks === "number") return args.tasks;
  if (typeof args.tasks === "string") return args.tasks.trim() ? 1 : 0;
  if (typeof args.task === "string") return args.task.trim() ? 1 : 0;
  return args.tasks ?? 0;
}

function normalizeParallel(value) {
  if (value == null) return null;
  if (value === "swarm") return value;
  return String(value);
}
