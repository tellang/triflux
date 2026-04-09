import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findAllClaudeMdPaths } from "./claudemd-scanner.mjs";

function runCommand(command, cwd, executor = execSync) {
  try {
    const output = executor(command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return String(output || "").trimEnd();
  } catch {
    return "";
  }
}

function parseStatusLines(statusText) {
  const lines = String(statusText || "")
    .split(/\r?\n/u)
    .filter(Boolean);
  const changedFiles = [];
  const status = [];

  for (const line of lines) {
    const normalized = line.trimEnd();
    if (!normalized) continue;

    const rawStatus = normalized.slice(0, 2).trim() || "??";
    const rawPath = normalized.slice(3).trim();
    const filePath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1)?.trim()
      : rawPath;
    if (!filePath) continue;

    changedFiles.push(filePath);
    status.push({ path: filePath, status: rawStatus });
  }

  return {
    changedFiles: Array.from(new Set(changedFiles)),
    status,
  };
}

function normalizeDecisionLine(line) {
  return String(line || "")
    .trim()
    .replace(/^[-*]\s+/u, "")
    .trim();
}

function parseDecisionFile(decisionFile) {
  if (!decisionFile) return [];
  const absolute = resolve(decisionFile);
  if (!existsSync(absolute)) return [];

  const raw = readFileSync(absolute, "utf8");
  return raw
    .split(/\r?\n/u)
    .map(normalizeDecisionLine)
    .filter((line) => line.length > 0);
}

function normalizeDecisions(decisions, decisionFile) {
  const merged = [
    ...(Array.isArray(decisions) ? decisions : []),
    ...parseDecisionFile(decisionFile),
  ]
    .map(normalizeDecisionLine)
    .filter(Boolean);

  return Array.from(new Set(merged));
}

function formatAheadBehind(value) {
  if (!value) return null;
  const [behindRaw, aheadRaw] = value.split(/\s+/u);
  const behind = Number.parseInt(behindRaw, 10);
  const ahead = Number.parseInt(aheadRaw, 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { ahead, behind };
}

export function collectHandoffContext(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const executor =
    typeof options.commandRunner === "function"
      ? options.commandRunner
      : execSync;
  const target = options.target === "local" ? "local" : "remote";
  const decisions = normalizeDecisions(options.decisions, options.decisionFile);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const claudeMdPaths = Array.isArray(options.claudeMdPaths)
    ? options.claudeMdPaths
    : findAllClaudeMdPaths({
        cwd,
        homeDir: options.homeDir,
      });

  const gitRoot = runCommand("git rev-parse --show-toplevel", cwd, executor);
  const branch =
    runCommand("git rev-parse --abbrev-ref HEAD", cwd, executor) || null;
  const shortStatus = runCommand("git status --short", cwd, executor);
  const diffStat = runCommand("git diff --stat --no-color", cwd, executor);
  const upstreamRaw = runCommand(
    "git rev-list --left-right --count @{upstream}...HEAD",
    cwd,
    executor,
  );
  const parsedStatus = parseStatusLines(shortStatus);

  return {
    generatedAt,
    target,
    cwd,
    gitRoot: gitRoot || null,
    repository: gitRoot ? basename(gitRoot) : basename(cwd),
    branch,
    upstream: formatAheadBehind(upstreamRaw),
    changedFiles: parsedStatus.changedFiles,
    fileStatus: parsedStatus.status,
    diffStat,
    decisions,
    claudeMdPaths,
  };
}

export function buildHandoffPrompt(context) {
  const safeContext = context || collectHandoffContext();
  const branch = safeContext.branch || "unknown";
  const upstream = safeContext.upstream
    ? `ahead ${safeContext.upstream.ahead}, behind ${safeContext.upstream.behind}`
    : "unknown";
  const changedFiles =
    safeContext.changedFiles.length > 0
      ? safeContext.changedFiles.map((file) => `- ${file}`).join("\n")
      : "- 변경 파일 없음";
  const decisions =
    safeContext.decisions.length > 0
      ? safeContext.decisions.map((decision) => `- ${decision}`).join("\n")
      : "- 명시된 결정사항 없음";
  const claudeMdList =
    Array.isArray(safeContext.claudeMdPaths) &&
    safeContext.claudeMdPaths.length > 0
      ? safeContext.claudeMdPaths.map((path) => `- ${path}`).join("\n")
      : "- 자동 탐지된 CLAUDE.md 없음";
  const diffStat = safeContext.diffStat || "(diff stat 없음)";

  return [
    "## TFX Remote Handoff",
    `- generated_at: ${safeContext.generatedAt}`,
    `- target: ${safeContext.target}`,
    `- repository: ${safeContext.repository}`,
    `- branch: ${branch} (${upstream})`,
    `- cwd: ${safeContext.cwd}`,
    "",
    "### 변경 파일",
    changedFiles,
    "",
    "### 변경 요약 (git diff --stat)",
    "```",
    diffStat,
    "```",
    "",
    "### 결정사항",
    decisions,
    "",
    "### CLAUDE.md 참조",
    claudeMdList,
    "",
    "### 다음 세션 지시",
    "- 위 변경사항을 먼저 검토하고 누락된 테스트를 확인하세요.",
    "- 필요 시 CLAUDE.md 지침을 재확인한 뒤 작업을 이어가세요.",
    "- 작업 완료 후 변경 파일과 검증 결과를 요약하세요.",
  ].join("\n");
}

export function serializeHandoff(options = {}) {
  const context = collectHandoffContext(options);
  return {
    ...context,
    prompt: buildHandoffPrompt(context),
  };
}
