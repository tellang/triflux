#!/usr/bin/env node
// session-vault 태그 빈도 기반으로 keyword-rules.json 확장 후보를 제안하는 스크립트

import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);
const RULES_PATH = join(PROJECT_ROOT, "hooks", "keyword-rules.json");
const DEFAULT_DB_PATH = "~/Desktop/Projects/tools/session-vault/sessions_v2.db";
const DEFAULT_THRESHOLD = 3;
const SOURCE_FILTER = "ollama-%";

// 서비스명 → 기본 mcp_route 매핑
const MCP_SERVICE_ROUTE_MAP = {
  notion: "gemini",
  jira: "codex",
  chrome: "gemini",
  playwright: "gemini",
  canva: "gemini",
  calendar: "gemini",
  gmail: "gemini",
  email: "gemini",
  github: "codex",
  figma: "gemini"
};

const MCP_SERVICE_NAMES = new Set([
  ...Object.keys(MCP_SERVICE_ROUTE_MAP),
  "slack",
  "linear",
  "confluence",
  "trello",
  "asana",
  "drive",
  "sheets",
  "docs"
]);

function printUsage() {
  console.log("사용법:");
  console.log("  node scripts/keyword-rules-expander.mjs --dry-run");
  console.log("  node scripts/keyword-rules-expander.mjs --threshold 5");
  console.log("  node scripts/keyword-rules-expander.mjs --apply");
  console.log("  node scripts/keyword-rules-expander.mjs --db-path ./other.db");
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    threshold: DEFAULT_THRESHOLD,
    dbPath: DEFAULT_DB_PATH,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--apply") {
      args.apply = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--threshold") {
      const next = argv[i + 1];
      if (!next) throw new Error("--threshold 값이 필요합니다.");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--threshold는 1 이상의 정수여야 합니다.");
      }
      args.threshold = parsed;
      i += 1;
      continue;
    }

    if (token.startsWith("--threshold=")) {
      const raw = token.slice("--threshold=".length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--threshold는 1 이상의 정수여야 합니다.");
      }
      args.threshold = parsed;
      continue;
    }

    if (token === "--db-path") {
      const next = argv[i + 1];
      if (!next) throw new Error("--db-path 값이 필요합니다.");
      args.dbPath = next;
      i += 1;
      continue;
    }

    if (token.startsWith("--db-path=")) {
      args.dbPath = token.slice("--db-path=".length);
      continue;
    }

    throw new Error(`알 수 없는 옵션: ${token}`);
  }

  if (!args.dryRun && !args.apply) args.dryRun = true;
  if (args.apply) args.dryRun = false;
  return args;
}

function expandHomePath(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function toDisplayPath(pathValue) {
  const homePath = homedir();
  if (pathValue.toLowerCase().startsWith(homePath.toLowerCase())) {
    let rest = pathValue.slice(homePath.length).replace(/\\/g, "/");
    if (rest && !rest.startsWith("/")) rest = `/${rest}`;
    return `~${rest}`;
  }
  return pathValue;
}

function normalizeKeyword(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function slugifyKeyword(value) {
  const base = normalizeKeyword(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return base || "keyword";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitSources(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function fetchTagFrequencyRows(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const stmt = db.prepare(`
      SELECT
        t.tag AS tag,
        COUNT(*) AS frequency,
        GROUP_CONCAT(DISTINCT tt.source) AS sources
      FROM turn_tags tt
      INNER JOIN tags t ON t.id = tt.tag_id
      WHERE tt.source LIKE ?
        AND t.tag IS NOT NULL
        AND TRIM(t.tag) <> ''
      GROUP BY t.tag
      ORDER BY frequency DESC, t.tag ASC
    `);

    return stmt.all(SOURCE_FILTER);
  } finally {
    db.close();
  }
}

function aggregateByNormalizedTag(rows) {
  const map = new Map();

  for (const row of rows) {
    const tag = typeof row.tag === "string" ? row.tag.trim() : "";
    if (!tag) continue;

    const normalized = normalizeKeyword(tag);
    if (!normalized) continue;

    if (!map.has(normalized)) {
      map.set(normalized, {
        keyword: tag,
        normalized,
        frequency: 0,
        variants: new Set(),
        sources: new Set()
      });
    }

    const current = map.get(normalized);
    current.frequency += Number(row.frequency) || 0;
    current.variants.add(tag);
    for (const source of splitSources(row.sources)) {
      current.sources.add(source);
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.keyword.localeCompare(b.keyword);
  });
}

function readRulesDocument(rulesPath) {
  const raw = readFileSync(rulesPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error("keyword-rules.json 형식이 올바르지 않습니다.");
  }
  return parsed;
}

function extractLiteralWords(patternSource) {
  const words = patternSource.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) || [];
  return words.filter((word) => !["true", "false", "null", "route", "skill"].includes(word));
}

function buildRuleIndex(rules) {
  const indexed = [];

  for (const rule of rules) {
    const aliases = new Set();
    const regexes = [];

    const ruleId = typeof rule.id === "string" ? rule.id.trim() : "";
    const skill = typeof rule.skill === "string" ? rule.skill.trim() : "";
    const route = typeof rule.mcp_route === "string" ? rule.mcp_route.trim() : "";

    if (ruleId) aliases.add(normalizeKeyword(ruleId));
    if (ruleId.endsWith("-route")) aliases.add(normalizeKeyword(ruleId.slice(0, -"-route".length)));
    if (ruleId.endsWith("-skill")) aliases.add(normalizeKeyword(ruleId.slice(0, -"-skill".length)));
    if (skill) aliases.add(normalizeKeyword(skill));
    if (route) aliases.add(normalizeKeyword(route));

    for (const pattern of Array.isArray(rule.patterns) ? rule.patterns : []) {
      if (!pattern || typeof pattern.source !== "string" || typeof pattern.flags !== "string") continue;
      try {
        regexes.push(new RegExp(pattern.source, pattern.flags));
      } catch {
        // 잘못된 정규식은 건너뛴다.
      }

      for (const token of extractLiteralWords(pattern.source)) {
        aliases.add(normalizeKeyword(token));
      }
    }

    indexed.push({
      id: ruleId || "(unknown-rule)",
      aliases,
      regexes
    });
  }

  return indexed;
}

function findCoveringRule(keyword, ruleIndex) {
  const normalized = normalizeKeyword(keyword);
  const keywordWithSpace = normalized.replace(/[-_]+/g, " ");

  for (const rule of ruleIndex) {
    if (rule.aliases.has(normalized)) return rule.id;

    for (const regex of rule.regexes) {
      regex.lastIndex = 0;
      if (regex.test(normalized)) return rule.id;
      regex.lastIndex = 0;
      if (regex.test(keywordWithSpace)) return rule.id;
    }
  }

  return null;
}

function classifyCandidate(keyword) {
  const normalized = normalizeKeyword(keyword).replace(/_/g, "-");

  if (/^tfx-[a-z0-9][a-z0-9-]*$/i.test(normalized)) {
    return {
      type: "skill",
      label: "skill 규칙 후보",
      skill: normalized,
      mcpRoute: null
    };
  }

  if (MCP_SERVICE_NAMES.has(normalized)) {
    return {
      type: "mcp_route",
      label: "mcp_route 규칙 후보",
      skill: null,
      mcpRoute: MCP_SERVICE_ROUTE_MAP[normalized] || "gemini"
    };
  }

  return {
    type: "general",
    label: "분류 미정",
    skill: null,
    mcpRoute: null
  };
}

function createPatternSource(keyword) {
  const tokens = normalizeKeyword(keyword)
    .split(/[\s_-]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => escapeRegExp(item));

  if (tokens.length === 0) return "\\bkeyword\\b";
  if (tokens.length === 1) return `\\b${tokens[0]}\\b`;
  return `\\b${tokens.join("[\\s_-]?")}\\b`;
}

function uniqueRuleId(baseId, existingIds) {
  if (!existingIds.has(baseId)) return baseId;
  let index = 2;
  while (existingIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

function buildRuleFromCandidate(candidate, existingIds) {
  const slug = slugifyKeyword(candidate.keyword);

  if (candidate.classification.type === "skill") {
    const ruleId = uniqueRuleId(`${slug}-skill`, existingIds);
    existingIds.add(ruleId);
    return {
      id: ruleId,
      patterns: [
        {
          source: createPatternSource(candidate.keyword),
          flags: "i"
        }
      ],
      skill: candidate.classification.skill,
      priority: 20,
      supersedes: [],
      exclusive: false,
      state: null,
      mcp_route: null
    };
  }

  if (candidate.classification.type === "mcp_route") {
    const ruleId = uniqueRuleId(`${slug}-route`, existingIds);
    existingIds.add(ruleId);
    return {
      id: ruleId,
      patterns: [
        {
          source: createPatternSource(candidate.keyword),
          flags: "i"
        }
      ],
      skill: null,
      priority: 20,
      supersedes: [],
      exclusive: false,
      state: null,
      mcp_route: candidate.classification.mcpRoute
    };
  }

  return null;
}

function formatSources(allTags) {
  const sourceSet = new Set();
  for (const tag of allTags) {
    for (const source of tag.sources) sourceSet.add(source);
  }
  const sorted = [...sourceSet].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) return "(없음)";
  return sorted.join(", ");
}

function printAnalysis({
  dbPathDisplay,
  sourceDisplay,
  totalTags,
  coveredCount,
  threshold,
  candidates,
  covered
}) {
  console.log("=== keyword-rules-expander 분석 결과 ===");
  console.log("");
  console.log(`DB: ${dbPathDisplay}`);
  console.log(`추출 소스: ${sourceDisplay}`);
  console.log(`총 태그: ${totalTags}개, 기존 규칙 매칭: ${coveredCount}개`);
  console.log("");

  console.log(`--- 새 규칙 후보 (threshold: ${threshold}) ---`);
  if (candidates.length === 0) {
    console.log("  (없음)");
  } else {
    for (const item of candidates) {
      console.log(`  ${item.keyword} (${item.frequency}회) → ${item.classification.label}`);
    }
  }

  console.log("");
  console.log("--- 이미 커버됨 (스킵) ---");
  if (covered.length === 0) {
    console.log("  (없음)");
  } else {
    for (const item of covered) {
      console.log(`  ${item.keyword} (${item.frequency}회) → ${item.ruleId} 규칙 있음`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const resolvedDbPath = resolve(expandHomePath(args.dbPath));
  const rulesDoc = readRulesDocument(RULES_PATH);
  const ruleIndex = buildRuleIndex(rulesDoc.rules);

  const rawRows = fetchTagFrequencyRows(resolvedDbPath);
  const tags = aggregateByNormalizedTag(rawRows);

  const covered = [];
  const candidates = [];

  for (const tag of tags) {
    const matchedRuleId = findCoveringRule(tag.keyword, ruleIndex);

    if (matchedRuleId) {
      covered.push({
        keyword: tag.keyword,
        frequency: tag.frequency,
        ruleId: matchedRuleId
      });
      continue;
    }

    if (tag.frequency < args.threshold) continue;

    candidates.push({
      keyword: tag.keyword,
      normalized: tag.normalized,
      frequency: tag.frequency,
      classification: classifyCandidate(tag.keyword)
    });
  }

  printAnalysis({
    dbPathDisplay: toDisplayPath(resolvedDbPath),
    sourceDisplay: formatSources(tags),
    totalTags: tags.length,
    coveredCount: covered.length,
    threshold: args.threshold,
    candidates,
    covered
  });

  if (!args.apply) return;

  const existingIds = new Set(
    rulesDoc.rules
      .map((rule) => (typeof rule.id === "string" ? rule.id.trim() : ""))
      .filter(Boolean)
  );

  const autoApplicable = candidates.filter((item) => item.classification.type !== "general");
  const manualReviewCount = candidates.length - autoApplicable.length;

  const newRules = autoApplicable
    .map((candidate) => buildRuleFromCandidate(candidate, existingIds))
    .filter(Boolean);

  if (newRules.length > 0) {
    rulesDoc.rules.push(...newRules);
    writeFileSync(RULES_PATH, `${JSON.stringify(rulesDoc, null, 2)}\n`, "utf8");
  }

  console.log("");
  console.log("--- 적용 결과 ---");
  console.log(`  추가된 규칙: ${newRules.length}개`);
  if (manualReviewCount > 0) {
    console.log(`  분류 미정(수동 검토): ${manualReviewCount}개`);
  }
  console.log(`  저장 파일: ${RULES_PATH}`);
}

try {
  main();
} catch (error) {
  console.error(`[keyword-rules-expander] 오류: ${error.message}`);
  process.exit(1);
}

