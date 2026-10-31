#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./lib/skill-template.mjs";

const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MODEL_NAME_RE =
  /\b(?:gpt-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|gemini-\d+(?:\.\d+)?-[a-z0-9][a-z0-9.-]*|(?:opus|sonnet|haiku)-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|claude-(?:opus|sonnet|haiku)-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|o\d(?:-[a-z0-9.]+)?)\b/gi;

const MAX_BODY_LINES = 500;
const TOC_THRESHOLD_LINES = 100;
const TOC_SEARCH_LINES = 30;
const TOC_RE = /^##\s+(?:목차|Contents)\s*$/m;
const RULES_REF_RE = /\.claude\/rules\/([\w-]+\.md)/g;
// setup.mjs 가 스킬 옆에 복사해 설치본에서도 보이는 rules 문서. 배포를 늘릴 때 여기만 고친다.
export const DISTRIBUTED_RULES = new Set(["tfx-routing.md", "tfx-psmux.md"]);

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
  const agentStartRe = /\bAgent\s*\(/g;
  let match;
  while ((match = agentStartRe.exec(body)) !== null) {
    const openParenIndex = match.index + match[0].lastIndexOf("(");
    let quote = null;
    let depth = 1;
    let closeParenIndex = -1;

    for (let index = openParenIndex + 1; index < body.length; index += 1) {
      const character = body[index];

      if (quote) {
        if (character === "\\") {
          index += 1;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }

      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          closeParenIndex = index;
          break;
        }
      }
    }

    if (closeParenIndex === -1) continue;

    const call = body.slice(openParenIndex + 1, closeParenIndex);
    agentStartRe.lastIndex = closeParenIndex + 1;
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

function walkReferences(dir, current = dir) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".")) files.push(...walkReferences(dir, full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !(current === dir && entry.name === "SKILL.md")
    ) {
      files.push(full);
    }
  }
  return files;
}

function lintBodyLength({ file, body, startLine }) {
  const count = body.split(/\r?\n/).length;
  if (count <= MAX_BODY_LINES) return [];
  return [
    createProblem({
      file,
      line: startLine,
      code: "skill-body-too-long",
      problem: `SKILL.md body is ${count} lines (limit ${MAX_BODY_LINES})`,
      cause:
        "본문이 길면 활성화될 때마다 컨텍스트를 많이 먹고, 필요한 부분을 찾기 어렵습니다.",
      fix: "상세 내용을 references/*.md 로 옮기고 SKILL.md 에서 한 단계로 연결하세요.",
    }),
  ];
}

function lintRulesReferences({ file, body, startLine }) {
  const problems = [];
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(RULES_REF_RE)) {
      if (DISTRIBUTED_RULES.has(match[1])) continue;
      problems.push(
        createProblem({
          file,
          line: startLine + index,
          code: "undistributed-rules-reference",
          problem: `SKILL.md points to .claude/rules/${match[1]}, which the install does not ship`,
          cause:
            "설치본에는 배포 허용 목록의 rules 문서만 복사되므로 triflux 밖에서는 없는 파일입니다.",
          fix: "필요한 내용을 스킬의 references/ 로 옮기거나, 배포 허용 목록과 setup 복사에 문서를 추가하세요.",
        }),
      );
    }
  }
  return problems;
}

function lintReferences({ skillFile, skillContent, rootDir }) {
  const problems = [];
  const refs = walkReferences(dirname(skillFile)).map((path) => ({
    path,
    name: basename(path),
    content: readFileSync(path, "utf8"),
  }));

  for (const ref of refs) {
    const file = normalizePath(relative(rootDir, ref.path));
    const lineCount = ref.content.split(/\r?\n/).length;
    const head = ref.content.split(/\r?\n/).slice(0, TOC_SEARCH_LINES);
    if (lineCount > TOC_THRESHOLD_LINES && !TOC_RE.test(head.join("\n"))) {
      problems.push(
        createProblem({
          file,
          line: 1,
          code: "reference-missing-toc",
          problem: `reference is ${lineCount} lines without a table of contents in the first ${TOC_SEARCH_LINES} lines`,
          cause:
            "긴 reference 는 일부만 읽히는 경우가 많아 목차가 없으면 전체 구조를 알 수 없습니다.",
          fix: "맨 위에 `## 목차` 또는 `## Contents` 절을 추가하세요.",
        }),
      );
    }
    if (!skillContent.includes(ref.name)) {
      problems.push(
        createProblem({
          file,
          line: 1,
          code: "reference-not-linked",
          problem: `reference ${ref.name} is not mentioned in SKILL.md`,
          cause: "SKILL.md 가 가리키지 않는 reference 는 읽힐 경로가 없습니다.",
          fix: "SKILL.md 에서 이 파일을 직접 가리키거나 파일을 지우세요.",
        }),
      );
    }
    const nested = refs.find(
      (other) => other !== ref && ref.content.includes(other.name),
    );
    if (nested) {
      problems.push(
        createProblem({
          file,
          line: 1,
          code: "reference-nested-link",
          problem: `reference points to another reference: ${nested.name}`,
          cause:
            "reference 가 다른 reference 를 거치면 일부만 읽혀 내용이 빠지기 쉽습니다.",
          fix: "SKILL.md 에서 두 파일을 각각 직접 가리키고 reference 간 연결은 지우세요.",
        }),
      );
    }
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
    ...lintBodyLength({
      file: relativeFile,
      body,
      startLine: bodyStartLine(content),
    }),
    ...lintRulesReferences({
      file: relativeFile,
      body,
      startLine: bodyStartLine(content),
    }),
    ...lintReferences({ skillFile: file, skillContent: content, rootDir }),
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
