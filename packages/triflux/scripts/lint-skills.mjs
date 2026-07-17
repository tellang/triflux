#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./lib/skill-template.mjs";

const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MODEL_NAME_RE =
  /\b(?:gpt-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|gemini-\d+(?:\.\d+)?-[a-z0-9][a-z0-9.-]*|(?:opus|sonnet|haiku)-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|claude-(?:opus|sonnet|haiku)-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|o\d(?:-[a-z0-9.]+)?)\b/gi;

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function walkFiles(rootDir, currentDir = rootDir) {
  if (!existsSync(currentDir)) return [];
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      files.push(...walkFiles(rootDir, fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(fullPath);
    }
  }

  return files;
}

function bodyStartLine(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return 1;
  return match[0].split(/\r?\n/).length;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function createProblem({ file, line, code, problem, cause, fix }) {
  return { file, line, code, problem, cause, fix };
}

function lintFrontmatter({ file, data }) {
  const problems = [];

  if (!isNonEmptyString(data.name)) {
    problems.push(
      createProblem({
        file,
        line: 1,
        code: "missing-frontmatter-name",
        problem: "missing required frontmatter name",
        cause:
          "`name:` is the stable English identifier for the skill surface.",
        fix: "Add `name: <english-skill-name>` to the SKILL.md frontmatter.",
      }),
    );
  } else if (!SKILL_NAME_RE.test(data.name.trim())) {
    problems.push(
      createProblem({
        file,
        line: 1,
        code: "invalid-frontmatter-name",
        problem: `frontmatter name must be English lowercase kebab-case: ${data.name}`,
        cause:
          "Skill prose stays Korean, but frontmatter `name:` is the English machine identifier.",
        fix: "Rename `name:` to lowercase English letters, numbers, and hyphens only.",
      }),
    );
  }

  if (!isNonEmptyString(data.description)) {
    problems.push(
      createProblem({
        file,
        line: 1,
        code: "missing-frontmatter-description",
        problem: "missing required frontmatter description",
        cause:
          "Claude Code activates skills from `description:` only; frontmatter triggers are not activation criteria.",
        fix: "Add a Korean `description:` that clearly states when to use this skill.",
      }),
    );
  }

  return problems;
}

function lintBodyModelNames({ file, body, startLine }) {
  const problems = [];
  const lines = body.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    MODEL_NAME_RE.lastIndex = 0;
    const matches = [...line.matchAll(MODEL_NAME_RE)];
    for (const match of matches) {
      problems.push(
        createProblem({
          file,
          line: startLine + index,
          code: "hardcoded-model-name",
          problem: `hardcoded model name in SKILL.md body: ${match[0]}`,
          cause:
            "모델명은 프로필 설정이 SSOT인데, 스킬 본문에 직접 쓰면 라우팅 정책과 drift가 생깁니다.",
          fix: "모델 ID를 제거하고 프로필명이나 프로필 설정 참조로 바꾸세요.",
        }),
      );
    }
  }

  return problems;
}

function lintAgentModels({ file, body, startLine }) {
  const problems = [];
  const callRe = /Agent\s*\(([\s\S]*?)\)/g;
  let match;
  while ((match = callRe.exec(body)) !== null) {
    const call = match[1];
    if (!/\bsubagent_type\s*=/.test(call) || !/\bprompt\s*=/.test(call)) {
      continue;
    }
    if (/\bmodel\s*=/.test(call)) continue;
    const line =
      startLine + body.slice(0, match.index).split(/\r?\n/).length - 1;
    problems.push(
      createProblem({
        file,
        line,
        code: "agent-model-required",
        problem: "executable Agent call is missing model=",
        cause:
          "실행형 Agent 호출은 모델 선택을 명시해야 라우팅 drift를 막을 수 있습니다.",
        fix: "Add model=<resolved-native-model> to the Agent call.",
      }),
    );
  }
  return problems;
}

function lintSkillFile({ file, rootDir }) {
  const content = readFileSync(file, "utf8");
  const { data, body } = parseFrontmatter(content);
  const relativeFile = normalizePath(relative(rootDir, file));

  return [
    ...lintFrontmatter({ file: relativeFile, data }),
    ...lintBodyModelNames({
      file: relativeFile,
      body,
      startLine: bodyStartLine(content),
    }),
    ...lintAgentModels({
      file: relativeFile,
      body,
      startLine: bodyStartLine(content),
    }),
  ];
}

export function lintSkills({ skillsDir, rootDir = dirname(skillsDir) } = {}) {
  if (!skillsDir) throw new Error("skillsDir is required");

  const resolvedSkillsDir = resolve(skillsDir);
  const resolvedRootDir = resolve(rootDir);
  const files = walkFiles(resolvedSkillsDir);
  const problems = files.flatMap((file) =>
    lintSkillFile({ file, rootDir: resolvedRootDir }),
  );

  return {
    ok: problems.length === 0,
    checked: files.length,
    problems,
  };
}

export function formatProblems(problems) {
  return problems
    .map((problem) =>
      [
        `Problem: ${problem.file}:${problem.line} ${problem.problem}`,
        `Cause: ${problem.cause}`,
        `Fix: ${problem.fix}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function runCli() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const skillsDir = join(repoRoot, "skills");
  const result = lintSkills({ skillsDir, rootDir: repoRoot });

  if (!result.ok) {
    console.error(
      `[lint-skills] FAIL: ${result.problems.length} problem(s) in ${result.checked} skill file(s).`,
    );
    console.error(formatProblems(result.problems));
    process.exitCode = 1;
    return;
  }

  console.log(`[lint-skills] PASS: ${result.checked} skill file(s) checked.`);
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[lint-skills] ${message}`);
    process.exitCode = 1;
  }
}
