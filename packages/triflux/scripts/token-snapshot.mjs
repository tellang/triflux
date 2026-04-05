#!/usr/bin/env node
/**
 * cx-auto Token Savings Tracker
 * 스냅샷 기반 Codex/Gemini 토큰 사용량 추적 + Claude 절약액 계산
 *
 * 사용법:
 *   node token-snapshot.mjs snapshot <label>
 *   node token-snapshot.mjs diff <pre> <post> [--agent <agent>] [--cli <cli>] [--id <id>]
 *   node token-snapshot.mjs report <session-id|all>
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const STATE_DIR = join(HOME, ".omc", "state", "cx-auto-tokens");
const SNAPSHOTS_DIR = join(STATE_DIR, "snapshots");
const DIFFS_DIR = join(STATE_DIR, "diffs");
const REPORTS_DIR = join(STATE_DIR, "reports");

// ── 가격 모델 ($/MTok, 비캐시 기준, 보수적 추정) ──
const PRICING = {
  claude_sonnet: { input: 3, output: 15 },
  claude_opus: { input: 15, output: 75 },
  codex: { input: 0, output: 0 },
  gemini_flash: { input: 0.10, output: 0.40 },
};

// Claude 캐시 가격 ($/MTok) — 오케스트레이션 비용 정밀 계산용
const CLAUDE_CACHE_PRICING = {
  claude_sonnet: { cache_write: 3.75, cache_read: 0.30 },
  claude_opus: { cache_write: 18.75, cache_read: 1.50 },
};

// 에이전트 → Claude 대체 모델
const AGENT_CLAUDE_MAP = {
  executor: "claude_sonnet",
  debugger: "claude_sonnet",
  "build-fixer": "claude_sonnet",
  "code-reviewer": "claude_sonnet",
  "security-reviewer": "claude_sonnet",
  "quality-reviewer": "claude_sonnet",
  designer: "claude_sonnet",
  writer: "claude_sonnet",
  scientist: "claude_sonnet",
  "document-specialist": "claude_sonnet",
  "deep-executor": "claude_opus",
  architect: "claude_opus",
  planner: "claude_opus",
  critic: "claude_opus",
  analyst: "claude_opus",
};

// CLI → 실제 비용 모델
const CLI_COST_MAP = {
  codex: "codex",
  gemini: "gemini_flash",
};

// ── 유틸리티 ──
function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try { return JSON.parse(readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) { console.error(`[token-snapshot] 쓰기 실패: ${e.message}`); }
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function formatCost(dollars) {
  if (dollars < 0.01) return "$0.00";
  return `$${dollars.toFixed(2)}`;
}

function calcCost(tokens, pricing) {
  return (tokens.input * pricing.input + tokens.output * pricing.output) / 1_000_000;
}

// ── Codex 세션 스캔 ──
// ~/.codex/sessions/YYYY/MM/DD/*.jsonl 에서 파일별 토큰 합산
function scanCodexSessions() {
  const sessions = {};
  const baseDir = join(HOME, ".codex", "sessions");
  if (!existsSync(baseDir)) return sessions;

  const now = Date.now();
  for (let d = 0; d < 30; d++) {
    const date = new Date(now - d * 86_400_000);
    const dayDir = join(
      baseDir,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    );
    if (!existsSync(dayDir)) continue;

    let files;
    try { files = readdirSync(dayDir).filter(f => f.endsWith(".jsonl")); }
    catch { continue; }

    for (const file of files) {
      const filepath = join(dayDir, file);
      try {
        const stat = statSync(filepath);
        const content = readFileSync(filepath, "utf-8");
        const lines = content.trim().split("\n").reverse();
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            const t = evt?.payload?.info?.total_token_usage;
            if (t) {
              sessions[filepath] = {
                input: t.input_tokens || t.input || 0,
                output: t.output_tokens || t.output || 0,
                total: t.total_tokens || t.total || ((t.input_tokens || t.input || 0) + (t.output_tokens || t.output || 0)),
                timestamp: evt.timestamp || stat.mtimeMs,
              };
              break;
            }
          } catch { /* 라인 파싱 실패 */ }
        }
        // 토큰 이벤트 없는 파일도 기록 (존재 추적용)
        if (!sessions[filepath]) {
          sessions[filepath] = { input: 0, output: 0, total: 0, timestamp: stat.mtimeMs };
        }
      } catch { /* 파일 읽기 실패 */ }
    }
  }
  return sessions;
}

// ── Gemini 세션 스캔 ──
// ~/.gemini/tmp/*/chats/*.json 에서 파일별 토큰 합산
function scanGeminiSessions() {
  const sessions = {};
  const tmpDir = join(HOME, ".gemini", "tmp");
  if (!existsSync(tmpDir)) return sessions;

  try {
    const dirs = readdirSync(tmpDir);
    for (const dir of dirs) {
      const chatsDir = join(tmpDir, dir, "chats");
      if (!existsSync(chatsDir)) continue;

      let files;
      try { files = readdirSync(chatsDir).filter(f => f.endsWith(".json")); }
      catch { continue; }

      for (const file of files) {
        const filepath = join(chatsDir, file);
        try {
          const data = JSON.parse(readFileSync(filepath, "utf-8"));
          let input = 0, output = 0, model = "unknown";
          for (const msg of data.messages || []) {
            if (msg.tokens) {
              input += msg.tokens.input || 0;
              output += msg.tokens.output || 0;
            }
            if (msg.model) model = msg.model;
          }
          sessions[filepath] = {
            input, output, total: input + output,
            model, lastUpdated: data.lastUpdated || null,
          };
        } catch { /* 무시 */ }
      }
    }
  } catch { /* 무시 */ }
  return sessions;
}

// ── Claude 세션 스캔 ──
// ~/.claude/projects/*/*.jsonl 에서 requestId별 마지막 이벤트의 usage 합산
function scanClaudeSessions() {
  const sessions = {};
  const projectsDir = join(HOME, ".claude", "projects");
  if (!existsSync(projectsDir)) return sessions;

  try {
    const projects = readdirSync(projectsDir);
    for (const proj of projects) {
      const projDir = join(projectsDir, proj);
      let stat;
      try { stat = statSync(projDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      let files;
      try { files = readdirSync(projDir).filter(f => f.endsWith(".jsonl")); }
      catch { continue; }

      for (const file of files) {
        const filepath = join(projDir, file);
        try {
          const fileStat = statSync(filepath);
          // 최근 7일 내 파일만 스캔 (성능)
          if (Date.now() - fileStat.mtimeMs > 7 * 86_400_000) continue;

          const content = readFileSync(filepath, "utf-8");
          const lines = content.trim().split("\n");

          // requestId별 마지막 이벤트의 usage만 수집 (중복 방지)
          const reqUsage = {};
          let model = "unknown";

          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (evt.type !== "assistant") continue;
              const msg = evt.message;
              if (!msg?.usage) continue;

              const reqId = evt.requestId || msg.id;
              if (!reqId) continue;
              if (msg.model) model = msg.model;

              reqUsage[reqId] = {
                input: msg.usage.input_tokens || 0,
                output: msg.usage.output_tokens || 0,
                cache_creation: msg.usage.cache_creation_input_tokens || 0,
                cache_read: msg.usage.cache_read_input_tokens || 0,
              };
            } catch { /* 라인 파싱 실패 */ }
          }

          // requestId별 usage 합산
          let input = 0, output = 0, cache_creation = 0, cache_read = 0;
          for (const u of Object.values(reqUsage)) {
            input += u.input;
            output += u.output;
            cache_creation += u.cache_creation;
            cache_read += u.cache_read;
          }

          const total = input + output + cache_creation + cache_read;
          if (total > 0) {
            sessions[filepath] = {
              input, output, cache_creation, cache_read,
              total, model,
              timestamp: fileStat.mtimeMs,
              requests: Object.keys(reqUsage).length,
            };
          }
        } catch { /* 파일 읽기 실패 */ }
      }
    }
  } catch { /* 무시 */ }
  return sessions;
}

// ── 스냅샷 캡처 ──
function takeSnapshot(label) {
  const codex = scanCodexSessions();
  const gemini = scanGeminiSessions();
  const claude = scanClaudeSessions();
  const snapshot = {
    label,
    timestamp: new Date().toISOString(),
    codex,
    gemini,
    claude,
    summary: {
      codex_files: Object.keys(codex).length,
      gemini_files: Object.keys(gemini).length,
      claude_files: Object.keys(claude).length,
      codex_total: Object.values(codex).reduce((s, v) => s + v.total, 0),
      gemini_total: Object.values(gemini).reduce((s, v) => s + v.total, 0),
      claude_total: Object.values(claude).reduce((s, v) => s + v.total, 0),
    },
  };

  const outPath = join(SNAPSHOTS_DIR, `${label}.json`);
  writeJsonSafe(outPath, snapshot);
  console.log(`[snapshot] ${label} 저장 완료`);
  console.log(`  Codex: ${snapshot.summary.codex_files}파일, ${formatTokenCount(snapshot.summary.codex_total)} tokens`);
  console.log(`  Gemini: ${snapshot.summary.gemini_files}파일, ${formatTokenCount(snapshot.summary.gemini_total)} tokens`);
  console.log(`  Claude: ${snapshot.summary.claude_files}파일, ${formatTokenCount(snapshot.summary.claude_total)} tokens`);
  return snapshot;
}

// ── 두 스냅샷 간 Diff ──
function computeDiff(preLabel, postLabel, options = {}) {
  const pre = readJson(join(SNAPSHOTS_DIR, `${preLabel}.json`));
  const post = readJson(join(SNAPSHOTS_DIR, `${postLabel}.json`));
  if (!pre || !post) {
    console.error(`[diff] 스냅샷 없음: ${!pre ? preLabel : postLabel}`);
    process.exit(1);
  }

  const delta = { codex: {}, gemini: {}, claude: {}, total: { input: 0, output: 0, total: 0 } };

  // Claude diff — 오케스트레이션 오버헤드 측정
  const preClaude = pre.claude || {};
  const postClaude = post.claude || {};
  const claudeOverhead = { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 };
  for (const [fp, postData] of Object.entries(postClaude)) {
    const preData = preClaude[fp];
    if (!preData) {
      if (postData.total > 0) {
        delta.claude[fp] = { ...postData, type: "new" };
        claudeOverhead.input += postData.input || 0;
        claudeOverhead.output += postData.output || 0;
        claudeOverhead.cache_creation += postData.cache_creation || 0;
        claudeOverhead.cache_read += postData.cache_read || 0;
        claudeOverhead.total += postData.total;
      }
    } else if (postData.total > preData.total) {
      const d = {
        input: (postData.input || 0) - (preData.input || 0),
        output: (postData.output || 0) - (preData.output || 0),
        cache_creation: (postData.cache_creation || 0) - (preData.cache_creation || 0),
        cache_read: (postData.cache_read || 0) - (preData.cache_read || 0),
        total: postData.total - preData.total,
        type: "increased",
      };
      delta.claude[fp] = d;
      claudeOverhead.input += d.input;
      claudeOverhead.output += d.output;
      claudeOverhead.cache_creation += d.cache_creation;
      claudeOverhead.cache_read += d.cache_read;
      claudeOverhead.total += d.total;
    }
  }
  delta.claudeOverhead = claudeOverhead;

  // Codex diff — 새 파일 또는 증가분 감지
  for (const [fp, postData] of Object.entries(post.codex)) {
    const preData = pre.codex[fp];
    if (!preData) {
      if (postData.total > 0) {
        delta.codex[fp] = { ...postData, type: "new" };
        delta.total.input += postData.input;
        delta.total.output += postData.output;
        delta.total.total += postData.total;
      }
    } else if (postData.total > preData.total) {
      const d = {
        input: postData.input - preData.input,
        output: postData.output - preData.output,
        total: postData.total - preData.total,
        type: "increased",
      };
      delta.codex[fp] = d;
      delta.total.input += d.input;
      delta.total.output += d.output;
      delta.total.total += d.total;
    }
  }

  // Gemini diff
  for (const [fp, postData] of Object.entries(post.gemini)) {
    const preData = pre.gemini[fp];
    if (!preData) {
      if (postData.total > 0) {
        delta.gemini[fp] = { ...postData, type: "new" };
        delta.total.input += postData.input;
        delta.total.output += postData.output;
        delta.total.total += postData.total;
      }
    } else if (postData.total > preData.total) {
      const d = {
        input: postData.input - preData.input,
        output: postData.output - preData.output,
        total: postData.total - preData.total,
        model: postData.model,
        type: "increased",
      };
      delta.gemini[fp] = d;
      delta.total.input += d.input;
      delta.total.output += d.output;
      delta.total.total += d.total;
    }
  }

  // 절약 계산 (Claude 오버헤드 반영)
  const agent = options.agent || "executor";
  const cli = options.cli || "codex";
  const savings = estimateSavings(delta.total, agent, cli, claudeOverhead);

  const result = {
    preLabel, postLabel, agent, cli,
    timestamp: new Date().toISOString(),
    delta,
    savings,
  };

  const diffId = options.id || `${preLabel}__${postLabel}`;
  writeJsonSafe(join(DIFFS_DIR, `${diffId}.json`), result);

  // 누적 절약액 업데이트 (HUD ts: 표시용)
  const accPath = join(STATE_DIR, "savings-total.json");
  const acc = readJson(accPath, { totalSaved: 0, totalClaudeCost: 0, totalActualCost: 0, diffCount: 0 });
  acc.totalSaved += savings.saved;
  acc.totalClaudeCost += savings.claudeCost;
  acc.totalActualCost += savings.actualCost;
  acc.diffCount += 1;
  acc.lastUpdated = new Date().toISOString();
  writeJsonSafe(accPath, acc);

  console.log(`[diff] ${preLabel} → ${postLabel}`);
  console.log(`  Agent: ${agent} (${cli})`);
  console.log(`  외부 CLI 토큰: ${formatTokenCount(delta.total.input)} input, ${formatTokenCount(delta.total.output)} output`);
  console.log(`  Claude 오케스트레이션: ${formatTokenCount(claudeOverhead.total)} tokens (오버헤드 ${formatCost(savings.overheadCost)})`);
  console.log(`  Claude-only 비용(추정): ${formatCost(savings.claudeCost)}`);
  console.log(`  실제 비용: ${formatCost(savings.actualCost)} (외부 CLI ${formatCost(savings.cliCost)} + 오케스트레이션 ${formatCost(savings.overheadCost)})`);
  console.log(`  순절약: ${formatCost(savings.saved)}`);
  return result;
}

// ── 절약액 계산 ──
// claudeOverhead: { input, output, cache_creation, cache_read } — 오케스트레이션에 쓴 Claude 토큰
function estimateSavings(tokens, agent, cli, claudeOverhead = null) {
  const claudeModel = AGENT_CLAUDE_MAP[agent] || "claude_sonnet";
  const claudePricing = PRICING[claudeModel];
  // Claude가 직접 했다면의 추정 비용
  const claudeCost = calcCost(tokens, claudePricing);

  const costModel = CLI_COST_MAP[cli] || "codex";
  const actualPricing = PRICING[costModel];
  // 외부 CLI 실비용
  const cliCost = calcCost(tokens, actualPricing);

  // Claude 오케스트레이션 오버헤드 비용 계산
  let overheadCost = 0;
  if (claudeOverhead && claudeOverhead.total > 0) {
    // 일반 input/output 비용
    overheadCost += calcCost(
      { input: claudeOverhead.input, output: claudeOverhead.output },
      claudePricing,
    );
    // 캐시 비용 (cache_creation은 write 가격, cache_read는 read 가격)
    const cachePricing = CLAUDE_CACHE_PRICING[claudeModel] || CLAUDE_CACHE_PRICING.claude_sonnet;
    overheadCost += (claudeOverhead.cache_creation * cachePricing.cache_write) / 1_000_000;
    overheadCost += (claudeOverhead.cache_read * cachePricing.cache_read) / 1_000_000;
  }

  // 실제 총비용 = 외부 CLI 비용 + Claude 오케스트레이션 비용
  const actualCost = cliCost + overheadCost;

  return {
    claudeModel,
    claudeCost,
    actualModel: costModel,
    cliCost,
    overheadCost,
    actualCost,
    saved: claudeCost - actualCost,
    tokens: { ...tokens },
    orchestration: claudeOverhead ? { ...claudeOverhead } : null,
  };
}

// ── 종합 보고서 ──
function generateReport(sessionId) {
  if (!existsSync(DIFFS_DIR)) {
    console.error("[report] diff 데이터 없음");
    process.exit(1);
  }

  const files = readdirSync(DIFFS_DIR).filter(f => f.endsWith(".json"));
  const diffs = [];
  for (const file of files) {
    const data = readJson(join(DIFFS_DIR, file));
    if (!data) continue;
    if (sessionId === "all" || file.includes(sessionId)) {
      diffs.push(data);
    }
  }

  if (diffs.length === 0) {
    console.log(`[report] ${sessionId}에 해당하는 diff 없음`);
    return null;
  }

  let totalClaudeCost = 0, totalActualCost = 0, totalSaved = 0, totalOverhead = 0;
  const rows = diffs.map((d, i) => {
    const s = d.savings;
    totalClaudeCost += s.claudeCost;
    totalActualCost += s.actualCost;
    totalSaved += s.saved;
    totalOverhead += s.overheadCost || 0;
    const overhead = s.overheadCost ? formatCost(s.overheadCost) : "-";
    return `| ${i + 1} | ${d.preLabel}→${d.postLabel} | ${d.agent} | ${d.cli} | ${formatTokenCount(s.tokens.input)} | ${formatTokenCount(s.tokens.output)} | ${formatCost(s.claudeCost)} | ${overhead} | ${formatCost(s.actualCost)} | ${formatCost(s.saved)} |`;
  });

  const report = [
    "### Token Savings Report",
    "",
    "| # | 서브태스크 | Agent | CLI | Input | Output | Claude-only(추정) | 오케스트레이션 | 실제 비용 | 순절약 |",
    "|---|----------|-------|-----|-------|--------|------------------|-------------|---------|--------|",
    ...rows,
    "",
    `**순절약: ${formatCost(totalSaved)}** (Claude-only 추정 ${formatCost(totalClaudeCost)}, 실제 ${formatCost(totalActualCost)}, 오케스트레이션 ${formatCost(totalOverhead)})`,
  ].join("\n");

  console.log(report);

  const reportData = {
    sessionId,
    timestamp: new Date().toISOString(),
    diffs: diffs.map(d => ({
      ...d.savings, agent: d.agent, cli: d.cli,
      labels: `${d.preLabel}→${d.postLabel}`,
    })),
    totals: { claudeCost: totalClaudeCost, actualCost: totalActualCost, saved: totalSaved },
    markdown: report,
  };
  writeJsonSafe(join(REPORTS_DIR, `${sessionId}.json`), reportData);
  return reportData;
}

// ── Named exports (파이프라인 벤치마크 훅용) ──
export { takeSnapshot, computeDiff, estimateSavings, formatTokenCount, formatCost, DIFFS_DIR, STATE_DIR };

// ── CLI 핸들러 (직접 실행 시에만) ──
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && join(dirname(process.argv[1])) === dirname(__filename)
  && process.argv[1].endsWith("token-snapshot.mjs");

if (!isDirectRun) {
  // imported as module — skip CLI
} else {

const [,, command, ...args] = process.argv;

switch (command) {
  case "snapshot": {
    const label = args[0];
    if (!label) { console.error("사용법: token-snapshot.mjs snapshot <label>"); process.exit(1); }
    takeSnapshot(label);
    break;
  }
  case "diff": {
    const [preLabel, postLabel, ...rest] = args;
    if (!preLabel || !postLabel) {
      console.error("사용법: token-snapshot.mjs diff <pre> <post> [--agent X] [--cli Y] [--id Z]");
      process.exit(1);
    }
    const options = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--agent" && rest[i + 1]) options.agent = rest[++i];
      else if (rest[i] === "--cli" && rest[i + 1]) options.cli = rest[++i];
      else if (rest[i] === "--id" && rest[i + 1]) options.id = rest[++i];
    }
    computeDiff(preLabel, postLabel, options);
    break;
  }
  case "report": {
    const sessionId = args[0] || "all";
    generateReport(sessionId);
    break;
  }
  default:
    console.log(`cx-auto Token Savings Tracker

사용법:
  node token-snapshot.mjs snapshot <label>     스냅샷 캡처
  node token-snapshot.mjs diff <pre> <post>    두 스냅샷 비교
    [--agent <agent>] [--cli <cli>] [--id <id>]
  node token-snapshot.mjs report <session-id>  종합 보고서 생성
    (session-id 대신 "all"로 전체 보고서)`);
}

} // end isDirectRun guard
