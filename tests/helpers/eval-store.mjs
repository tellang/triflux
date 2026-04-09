/**
 * Eval result persistence and comparison.
 *
 * EvalCollector accumulates test results, writes them to
 * ~/.claude/cache/tfx-eval/{version}-{branch}-{tier}-{timestamp}.json,
 * prints a summary table, and auto-compares with the previous run.
 *
 * Comparison functions are exported for reuse by eval:compare CLI.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_VERSION = 1;
const DEFAULT_EVAL_DIR = path.join(
  os.homedir(),
  ".claude",
  "cache",
  "tfx-eval",
);

// --- Shared helpers ---

/**
 * 식별된 버그(planted-bug) 테스트의 통과 여부를 판정합니다.
 * 판정 결과가 기준 임계값(Ground Truth)을 충족하는지 확인합니다.
 *
 * @param {{ detection_rate: number, false_positives: number, evidence_quality: number }} judgeResult - 판정 결과 데이터
 * @param {{ minimum_detection: number, max_false_positives: number }} groundTruth - 기준 임계값
 * @returns {boolean} 통과 여부
 */
export function judgePassed(judgeResult, groundTruth) {
  return (
    judgeResult.detection_rate >= groundTruth.minimum_detection &&
    judgeResult.false_positives <= groundTruth.max_false_positives &&
    judgeResult.evidence_quality >= 2
  );
}

// --- Comparison functions (exported for eval:compare CLI) ---

/**
 * 트랜스크립트에서 도구 호출 횟수를 추출하여 요약합니다.
 * 예: { Bash: 8, Read: 3, Write: 1 }.
 *
 * @param {any[]} transcript - 분석할 트랜스크립트 배열
 * @returns {Record<string, number>} 도구별 호출 횟수
 */
export function extractToolSummary(transcript) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const event of transcript) {
    if (event.type === "assistant") {
      const content = event.message?.content || [];
      for (const item of content) {
        if (item.type === "tool_use") {
          const name = item.name || "unknown";
          counts[name] = (counts[name] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

/**
 * 비교 분석을 위해 가장 최근의 이전 평가(eval) 파일을 찾습니다.
 * 가급적 동일한 브랜치를 선호하며, 없는 경우 다른 브랜치의 최신 파일을 선택합니다.
 *
 * @param {string} evalDir - 평가 결과 파일들이 저장된 디렉토리
 * @param {string} tier - 평가 티어 (e2e, llm-judge 등)
 * @param {string} branch - 현재 브랜치 이름
 * @param {string} excludeFile - 검색에서 제외할 현재 파일 경로
 * @returns {string | null} 이전 평가 파일 경로 또는 없는 경우 null
 */
export function findPreviousRun(evalDir, tier, branch, excludeFile) {
  let files;
  try {
    files = fs.readdirSync(evalDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null; // dir doesn't exist
  }

  // Parse top-level fields from each file (cheap — no full tests array needed)
  /** @type {Array<{ file: string, branch: string, timestamp: string }>} */
  const entries = [];
  for (const file of files) {
    if (file === path.basename(excludeFile)) continue;
    const fullPath = path.join(evalDir, file);
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const data = JSON.parse(raw);
      if (data.tier !== tier) continue;
      entries.push({
        file: fullPath,
        branch: data.branch || "",
        timestamp: data.timestamp || "",
      });
    } catch {}
  }

  if (entries.length === 0) return null;

  // Sort by timestamp descending
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Prefer same branch
  const sameBranch = entries.find((e) => e.branch === branch);
  if (sameBranch) return sameBranch.file;

  // Fallback: any branch
  return entries[0].file;
}

/**
 * 두 평가 결과를 비교 분석합니다. 테스트 이름을 기준으로 매칭을 수행합니다.
 *
 * @param {object} before - 이전 평가 데이터
 * @param {object} after - 현재 평가 데이터
 * @param {string} beforeFile - 이전 평가 파일 경로
 * @param {string} afterFile - 현재 평가 파일 경로
 * @returns {object} 개선, 퇴보, 비용 변화 등을 포함한 비교 결과 객체
 */
export function compareEvalResults(before, after, beforeFile, afterFile) {
  /** @type {object[]} */
  const deltas = [];
  let improved = 0,
    regressed = 0,
    unchanged = 0;
  let toolCountBefore = 0,
    toolCountAfter = 0;

  // Index before tests by name
  const beforeMap = new Map();
  for (const t of before.tests) {
    beforeMap.set(t.name, t);
  }

  // Walk after tests, match by name
  for (const afterTest of after.tests) {
    const beforeTest = beforeMap.get(afterTest.name);
    const beforeToolSummary = beforeTest?.transcript
      ? extractToolSummary(beforeTest.transcript)
      : {};
    const afterToolSummary = afterTest.transcript
      ? extractToolSummary(afterTest.transcript)
      : {};

    const beforeToolCount = Object.values(beforeToolSummary).reduce(
      (a, b) => a + b,
      0,
    );
    const afterToolCount = Object.values(afterToolSummary).reduce(
      (a, b) => a + b,
      0,
    );
    toolCountBefore += beforeToolCount;
    toolCountAfter += afterToolCount;

    let statusChange = "unchanged";
    if (beforeTest) {
      if (!beforeTest.passed && afterTest.passed) {
        statusChange = "improved";
        improved++;
      } else if (beforeTest.passed && !afterTest.passed) {
        statusChange = "regressed";
        regressed++;
      } else {
        unchanged++;
      }
    } else {
      // New test — treat as unchanged (no prior data)
      unchanged++;
    }

    deltas.push({
      name: afterTest.name,
      before: {
        passed: beforeTest?.passed ?? false,
        cost_usd: beforeTest?.cost_usd ?? 0,
        turns_used: beforeTest?.turns_used,
        duration_ms: beforeTest?.duration_ms,
        detection_rate: beforeTest?.detection_rate,
        tool_summary: beforeToolSummary,
      },
      after: {
        passed: afterTest.passed,
        cost_usd: afterTest.cost_usd,
        turns_used: afterTest.turns_used,
        duration_ms: afterTest.duration_ms,
        detection_rate: afterTest.detection_rate,
        tool_summary: afterToolSummary,
      },
      status_change: statusChange,
    });

    beforeMap.delete(afterTest.name);
  }

  // Tests that were in before but not in after (removed tests)
  for (const [name, beforeTest] of beforeMap) {
    const beforeToolSummary = beforeTest.transcript
      ? extractToolSummary(beforeTest.transcript)
      : {};
    const beforeToolCount = Object.values(beforeToolSummary).reduce(
      (a, b) => a + b,
      0,
    );
    toolCountBefore += beforeToolCount;
    unchanged++;
    deltas.push({
      name: `${name} (removed)`,
      before: {
        passed: beforeTest.passed,
        cost_usd: beforeTest.cost_usd,
        turns_used: beforeTest.turns_used,
        duration_ms: beforeTest.duration_ms,
        detection_rate: beforeTest.detection_rate,
        tool_summary: beforeToolSummary,
      },
      after: { passed: false, cost_usd: 0, tool_summary: {} },
      status_change: "unchanged",
    });
  }

  return {
    before_file: beforeFile,
    after_file: afterFile,
    before_branch: before.branch,
    after_branch: after.branch,
    before_timestamp: before.timestamp,
    after_timestamp: after.timestamp,
    deltas,
    total_cost_delta: after.total_cost_usd - before.total_cost_usd,
    total_duration_delta: after.total_duration_ms - before.total_duration_ms,
    improved,
    regressed,
    unchanged,
    tool_count_before: toolCountBefore,
    tool_count_after: toolCountAfter,
  };
}

/**
 * 비교 분석 결과(ComparisonResult)를 사람이 읽기 좋은 형식의 문자열로 변환합니다.
 *
 * @param {object} c - 비교 결과 객체
 * @returns {string} 포맷팅된 결과 문자열
 */
export function formatComparison(c) {
  const lines = [];
  const ts = c.before_timestamp
    ? c.before_timestamp.replace("T", " ").slice(0, 16)
    : "unknown";
  lines.push(
    `\nvs previous: ${c.before_branch}/${c.deltas.length ? "eval" : ""} (${ts})`,
  );
  lines.push("─".repeat(70));

  // Per-test deltas
  for (const d of c.deltas) {
    const arrow =
      d.status_change === "improved"
        ? "↑"
        : d.status_change === "regressed"
          ? "↓"
          : "=";
    const beforeStatus = d.before.passed ? "PASS" : "FAIL";
    const afterStatus = d.after.passed ? "PASS" : "FAIL";

    // Turns delta
    let turnsDelta = "";
    if (d.before.turns_used !== undefined && d.after.turns_used !== undefined) {
      const td = d.after.turns_used - d.before.turns_used;
      turnsDelta = ` ${d.before.turns_used}→${d.after.turns_used}t`;
      if (td !== 0) turnsDelta += `(${td > 0 ? "+" : ""}${td})`;
    } else if (d.after.turns_used !== undefined) {
      turnsDelta = ` ${d.after.turns_used}t`;
    }

    // Duration delta
    let durDelta = "";
    if (
      d.before.duration_ms !== undefined &&
      d.after.duration_ms !== undefined
    ) {
      const bs = Math.round(d.before.duration_ms / 1000);
      const as_ = Math.round(d.after.duration_ms / 1000);
      const dd = as_ - bs;
      durDelta = ` ${bs}→${as_}s`;
      if (dd !== 0) durDelta += `(${dd > 0 ? "+" : ""}${dd})`;
    } else if (d.after.duration_ms !== undefined) {
      durDelta = ` ${Math.round(d.after.duration_ms / 1000)}s`;
    }

    let detail = "";
    if (
      d.before.detection_rate !== undefined ||
      d.after.detection_rate !== undefined
    ) {
      detail = ` ${d.before.detection_rate ?? "?"}→${d.after.detection_rate ?? "?"} det`;
    } else {
      const costBefore = d.before.cost_usd.toFixed(2);
      const costAfter = d.after.cost_usd.toFixed(2);
      detail = ` $${costBefore}→$${costAfter}`;
    }

    const name =
      d.name.length > 30 ? d.name.slice(0, 27) + "..." : d.name.padEnd(30);
    lines.push(
      `  ${name}  ${beforeStatus.padEnd(5)} → ${afterStatus.padEnd(5)}  ${arrow}${detail}${turnsDelta}${durDelta}`,
    );
  }

  lines.push("─".repeat(70));

  // Totals
  const parts = [];
  if (c.improved > 0) parts.push(`${c.improved} improved`);
  if (c.regressed > 0) parts.push(`${c.regressed} regressed`);
  if (c.unchanged > 0) parts.push(`${c.unchanged} unchanged`);
  lines.push(`  Status: ${parts.join(", ")}`);

  const costSign = c.total_cost_delta >= 0 ? "+" : "";
  lines.push(`  Cost:   ${costSign}$${c.total_cost_delta.toFixed(2)}`);

  const durDelta = Math.round(c.total_duration_delta / 1000);
  const durSign = durDelta >= 0 ? "+" : "";
  lines.push(`  Duration: ${durSign}${durDelta}s`);

  const toolDelta = c.tool_count_after - c.tool_count_before;
  const toolSign = toolDelta >= 0 ? "+" : "";
  lines.push(
    `  Tool calls: ${c.tool_count_before} → ${c.tool_count_after} (${toolSign}${toolDelta})`,
  );

  // Tool breakdown (show tools that changed)
  const allTools = new Set();
  for (const d of c.deltas) {
    for (const t of Object.keys(d.before.tool_summary || {})) allTools.add(t);
    for (const t of Object.keys(d.after.tool_summary || {})) allTools.add(t);
  }

  if (allTools.size > 0) {
    // Aggregate tool counts across all tests
    /** @type {Record<string, number>} */
    const totalBefore = {};
    /** @type {Record<string, number>} */
    const totalAfter = {};
    for (const d of c.deltas) {
      for (const [t, n] of Object.entries(d.before.tool_summary || {})) {
        totalBefore[t] = (totalBefore[t] || 0) + n;
      }
      for (const [t, n] of Object.entries(d.after.tool_summary || {})) {
        totalAfter[t] = (totalAfter[t] || 0) + n;
      }
    }

    for (const tool of [...allTools].sort()) {
      const b = totalBefore[tool] || 0;
      const a = totalAfter[tool] || 0;
      if (b !== a) {
        const d = a - b;
        lines.push(`    ${tool}: ${b} → ${a} (${d >= 0 ? "+" : ""}${d})`);
      }
    }
  }

  // Commentary — interpret what the deltas mean
  const commentary = generateCommentary(c);
  if (commentary.length > 0) {
    lines.push("");
    lines.push("  Takeaway:");
    for (const line of commentary) {
      lines.push(`    ${line}`);
    }
  }

  return lines.join("\n");
}

/**
 * 비교 분석 결과의 수치 데이터를 해석하여 사람이 이해하기 쉬운 논평(Commentary)을 생성합니다.
 * 퇴보(Regression), 수정(Fixed), 효율성 변화 등을 요약하여 제공합니다.
 *
 * @param {object} c - 비교 결과 객체
 * @returns {string[]} 해석된 논평 문장들의 배열
 */
export function generateCommentary(c) {
  const notes = [];

  // 1. Regressions are the most important signal — call them out first
  const regressions = c.deltas.filter((d) => d.status_change === "regressed");
  if (regressions.length > 0) {
    for (const d of regressions) {
      notes.push(
        `REGRESSION: "${d.name}" was passing, now fails. Investigate immediately.`,
      );
    }
  }

  // 2. Improvements
  const improvements = c.deltas.filter((d) => d.status_change === "improved");
  for (const d of improvements) {
    notes.push(`Fixed: "${d.name}" now passes.`);
  }

  // 3. Per-test efficiency changes (only for unchanged-status tests)
  const stable = c.deltas.filter(
    (d) => d.status_change === "unchanged" && d.after.passed,
  );
  for (const d of stable) {
    const insights = [];

    // Turns
    if (
      d.before.turns_used !== undefined &&
      d.after.turns_used !== undefined &&
      d.before.turns_used > 0
    ) {
      const turnsDelta = d.after.turns_used - d.before.turns_used;
      const turnsPct = Math.round((turnsDelta / d.before.turns_used) * 100);
      if (Math.abs(turnsPct) >= 20 && Math.abs(turnsDelta) >= 2) {
        if (turnsDelta < 0) {
          insights.push(
            `${Math.abs(turnsDelta)} fewer turns (${Math.abs(turnsPct)}% more efficient)`,
          );
        } else {
          insights.push(
            `${turnsDelta} more turns (${turnsPct}% less efficient)`,
          );
        }
      }
    }

    // Duration
    if (
      d.before.duration_ms !== undefined &&
      d.after.duration_ms !== undefined &&
      d.before.duration_ms > 0
    ) {
      const durDelta = d.after.duration_ms - d.before.duration_ms;
      const durPct = Math.round((durDelta / d.before.duration_ms) * 100);
      if (Math.abs(durPct) >= 20 && Math.abs(durDelta) >= 5000) {
        if (durDelta < 0) {
          insights.push(`${Math.round(Math.abs(durDelta) / 1000)}s faster`);
        } else {
          insights.push(`${Math.round(durDelta / 1000)}s slower`);
        }
      }
    }

    // Detection rate
    if (
      d.before.detection_rate !== undefined &&
      d.after.detection_rate !== undefined
    ) {
      const detDelta = d.after.detection_rate - d.before.detection_rate;
      if (detDelta !== 0) {
        if (detDelta > 0) {
          insights.push(
            `detecting ${detDelta} more bug${detDelta > 1 ? "s" : ""}`,
          );
        } else {
          insights.push(
            `detecting ${Math.abs(detDelta)} fewer bug${Math.abs(detDelta) > 1 ? "s" : ""} — check prompt quality`,
          );
        }
      }
    }

    // Cost
    if (d.before.cost_usd > 0) {
      const costDelta = d.after.cost_usd - d.before.cost_usd;
      const costPct = Math.round((costDelta / d.before.cost_usd) * 100);
      if (Math.abs(costPct) >= 30 && Math.abs(costDelta) >= 0.05) {
        if (costDelta < 0) {
          insights.push(`${Math.abs(costPct)}% cheaper`);
        } else {
          insights.push(`${costPct}% more expensive`);
        }
      }
    }

    if (insights.length > 0) {
      notes.push(`"${d.name}": ${insights.join(", ")}.`);
    }
  }

  // 4. Overall summary
  if (c.deltas.length >= 3 && regressions.length === 0) {
    const overallParts = [];

    // Total cost
    const totalBefore = c.deltas.reduce((s, d) => s + d.before.cost_usd, 0);
    if (totalBefore > 0) {
      const costPct = Math.round((c.total_cost_delta / totalBefore) * 100);
      if (Math.abs(costPct) >= 10) {
        overallParts.push(
          `${Math.abs(costPct)}% ${costPct < 0 ? "cheaper" : "more expensive"} overall`,
        );
      }
    }

    // Total duration
    const totalDurBefore = c.deltas.reduce(
      (s, d) => s + (d.before.duration_ms || 0),
      0,
    );
    if (totalDurBefore > 0) {
      const durPct = Math.round(
        (c.total_duration_delta / totalDurBefore) * 100,
      );
      if (Math.abs(durPct) >= 10) {
        overallParts.push(
          `${Math.abs(durPct)}% ${durPct < 0 ? "faster" : "slower"}`,
        );
      }
    }

    // Total turns
    const turnsBefore = c.deltas.reduce(
      (s, d) => s + (d.before.turns_used || 0),
      0,
    );
    const turnsAfter = c.deltas.reduce(
      (s, d) => s + (d.after.turns_used || 0),
      0,
    );
    if (turnsBefore > 0) {
      const turnsPct = Math.round(
        ((turnsAfter - turnsBefore) / turnsBefore) * 100,
      );
      if (Math.abs(turnsPct) >= 10) {
        overallParts.push(
          `${Math.abs(turnsPct)}% ${turnsPct < 0 ? "fewer" : "more"} turns`,
        );
      }
    }

    if (overallParts.length > 0) {
      notes.push(
        `Overall: ${overallParts.join(", ")}. ${regressions.length === 0 ? "No regressions." : ""}`,
      );
    } else if (regressions.length === 0) {
      notes.push(
        "Stable run — no significant efficiency changes, no regressions.",
      );
    }
  }

  return notes;
}

// --- EvalCollector ---

/**
 * @returns {{ branch: string, sha: string }}
 */
function getGitInfo() {
  try {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: "pipe",
      timeout: 5000,
    });
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      stdio: "pipe",
      timeout: 5000,
    });
    return {
      branch: branch.stdout?.toString().trim() || "unknown",
      sha: sha.stdout?.toString().trim() || "unknown",
    };
  } catch {
    return { branch: "unknown", sha: "unknown" };
  }
}

/**
 * @returns {string}
 */
function getVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * @returns {string}
 */
function _getProjectName() {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.name || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 테스트 결과를 수집하고 파일로 저장하며, 이전 실행 결과와 비교 분석을 수행하는 클래스입니다.
 */
export class EvalCollector {
  /** @type {'e2e' | 'llm-judge'} */
  #tier;
  /** @type {object[]} */
  #tests = [];
  /** @type {boolean} */
  #finalized = false;
  /** @type {string} */
  #evalDir;
  /** @type {number} */
  #createdAt = Date.now();

  /**
   * EvalCollector 인스턴스를 생성합니다.
   *
   * @param {'e2e' | 'llm-judge'} tier - 평가 티어
   * @param {string} [evalDir] - 결과 저장 디렉토리
   */
  constructor(tier, evalDir) {
    this.#tier = tier;
    this.#evalDir = evalDir || DEFAULT_EVAL_DIR;
  }

  /**
   * 완료된 테스트 항목을 추가하고 중간 결과를 저장합니다.
   *
   * @param {object} entry - 테스트 항목 결과 데이터
   */
  addTest(entry) {
    this.#tests.push(entry);
    this.savePartial();
  }

  /**
   * 중간 결과를 파일로 저장합니다. 테스트가 진행되는 동안 점진적으로 기록됩니다.
   * 원자적(atomic) 쓰기를 수행하며 실패 시에도 무시됩니다.
   */
  savePartial() {
    try {
      const git = getGitInfo();
      const version = getVersion();
      const totalCost = this.#tests.reduce((s, t) => s + t.cost_usd, 0);
      const totalDuration = this.#tests.reduce((s, t) => s + t.duration_ms, 0);
      const passed = this.#tests.filter((t) => t.passed).length;

      const partial = {
        schema_version: SCHEMA_VERSION,
        version,
        branch: git.branch,
        git_sha: git.sha,
        timestamp: new Date().toISOString(),
        hostname: os.hostname(),
        tier: this.#tier,
        total_tests: this.#tests.length,
        passed,
        failed: this.#tests.length - passed,
        total_cost_usd: Math.round(totalCost * 100) / 100,
        total_duration_ms: totalDuration,
        tests: this.#tests,
        _partial: true,
      };

      fs.mkdirSync(this.#evalDir, { recursive: true });
      const partialPath = path.join(this.#evalDir, "_partial-e2e.json");
      const tmp = partialPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(partial, null, 2) + "\n");
      fs.renameSync(tmp, partialPath);
    } catch {
      /* non-fatal — partial saves are best-effort */
    }
  }

  /**
   * 전체 평가 과정을 마무리하고 최종 결과 파일을 생성합니다.
   * 결과 요약표를 출력하고 이전 실행 결과와의 자동 비교 분석을 수행합니다.
   *
   * @returns {Promise<string>} 생성된 최종 결과 파일 경로
   */
  async finalize() {
    if (this.#finalized) return "";
    this.#finalized = true;

    const git = getGitInfo();
    const version = getVersion();
    const timestamp = new Date().toISOString();
    const totalCost = this.#tests.reduce((s, t) => s + t.cost_usd, 0);
    const totalDuration = this.#tests.reduce((s, t) => s + t.duration_ms, 0);
    const passed = this.#tests.filter((t) => t.passed).length;

    const result = {
      schema_version: SCHEMA_VERSION,
      version,
      branch: git.branch,
      git_sha: git.sha,
      timestamp,
      hostname: os.hostname(),
      tier: this.#tier,
      total_tests: this.#tests.length,
      passed,
      failed: this.#tests.length - passed,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      total_duration_ms: totalDuration,
      wall_clock_ms: Date.now() - this.#createdAt,
      tests: this.#tests,
    };

    // Write eval file
    fs.mkdirSync(this.#evalDir, { recursive: true });
    const dateStr = timestamp
      .replace(/[:.]/g, "")
      .replace("T", "-")
      .slice(0, 15);
    const safeBranch = git.branch.replace(/[^a-zA-Z0-9._-]/g, "-");
    const filename = `${version}-${safeBranch}-${this.#tier}-${dateStr}.json`;
    const filepath = path.join(this.#evalDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2) + "\n");

    // Print summary table
    this.#printSummary(result, filepath, git);

    // Auto-compare with previous run
    try {
      const prevFile = findPreviousRun(
        this.#evalDir,
        this.#tier,
        git.branch,
        filepath,
      );
      if (prevFile) {
        const prevResult = JSON.parse(fs.readFileSync(prevFile, "utf-8"));
        const comparison = compareEvalResults(
          prevResult,
          result,
          prevFile,
          filepath,
        );
        process.stderr.write(formatComparison(comparison) + "\n");
      } else {
        process.stderr.write("\nFirst run — no comparison available.\n");
      }
    } catch (err) {
      process.stderr.write(`\nCompare error: ${err.message}\n`);
    }

    return filepath;
  }

  /**
   * @param {object} result
   * @param {string} filepath
   * @param {{ branch: string, sha: string }} git
   */
  #printSummary(result, filepath, git) {
    const lines = [];
    lines.push("");
    lines.push(
      `Eval Results — v${result.version} @ ${git.branch} (${git.sha}) — ${this.#tier}`,
    );
    lines.push("═".repeat(70));

    for (const t of this.#tests) {
      const status = t.passed ? " PASS " : " FAIL ";
      const cost = `$${t.cost_usd.toFixed(2)}`;
      const dur = t.duration_ms ? `${Math.round(t.duration_ms / 1000)}s` : "";
      const turns = t.turns_used !== undefined ? `${t.turns_used}t` : "";

      let detail = "";
      if (t.detection_rate !== undefined) {
        detail = `${t.detection_rate}/${(t.detected_bugs?.length || 0) + (t.missed_bugs?.length || 0)} det`;
      } else if (t.judge_scores) {
        const scores = Object.entries(t.judge_scores)
          .map(([k, v]) => `${k[0]}:${v}`)
          .join(" ");
        detail = scores;
      }

      const name =
        t.name.length > 35 ? t.name.slice(0, 32) + "..." : t.name.padEnd(35);
      lines.push(
        `  ${name}  ${status}  ${cost.padStart(6)}  ${turns.padStart(4)}  ${dur.padStart(5)}  ${detail}`,
      );
    }

    lines.push("─".repeat(70));
    const totalCost = `$${result.total_cost_usd.toFixed(2)}`;
    const totalDur = `${Math.round(result.total_duration_ms / 1000)}s`;
    lines.push(
      `  Total: ${result.passed}/${result.total_tests} passed${" ".repeat(20)}${totalCost.padStart(6)}  ${totalDur}`,
    );
    lines.push(`Saved: ${filepath}`);

    process.stderr.write(lines.join("\n") + "\n");
  }
}
