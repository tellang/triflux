import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { describe, it } from "node:test";

import {
  buildSlimWrapperPrompt,
  SLIM_WRAPPER_SUBAGENT_TYPE,
  verifySlimWrapperRouteExecution,
} from "../../hub/team/native.mjs";

const slimWrapperPath = new URL(
  "../../.claude/agents/slim-wrapper.md",
  import.meta.url,
);
const setupScriptPath = new URL("../../scripts/setup.mjs", import.meta.url);

const REQUIRED_TOOLS = [
  "Bash",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "SendMessage",
];
const REQUIRED_DISALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Agent",
];

function getFrontmatterBlock(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  assert.ok(match, "YAML frontmatter가 있어야 한다");
  return match[1];
}

function parseFrontmatterList(frontmatter, key) {
  const match = new RegExp(
    `^${key}:\\s*\\r?\\n((?:[ \\t]+- .*\\r?\\n?)+)`,
    "mu",
  ).exec(frontmatter);
  if (!match) return [];
  return Array.from(match[1].matchAll(/^[ \t]+-\s*(.+?)\s*$/gmu), (item) =>
    item[1].trim(),
  );
}

function parseFrontmatterScalar(frontmatter, key) {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mu").exec(frontmatter);
  return match?.[1]?.trim() ?? null;
}

function parsePromptAllowedTools(prompt) {
  const match =
    /\[HARD CONSTRAINT\]\s*허용 도구:\s*([^.\n]+?)만 사용한다\./u.exec(prompt);
  assert.ok(match, "프롬프트 HARD CONSTRAINT에 허용 도구 목록이 있어야 한다");
  return match[1]
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

describe("slim-wrapper 에이전트 정의 검증", () => {
  it("slim-wrapper.md가 존재하고 필수 frontmatter를 포함해야 한다", async () => {
    const content = await fs.readFile(slimWrapperPath, "utf8");
    const frontmatter = getFrontmatterBlock(content);
    const tools = parseFrontmatterList(frontmatter, "tools");
    const disallowedTools = parseFrontmatterList(
      frontmatter,
      "disallowedTools",
    );

    assert.ok(content.length > 0, "slim-wrapper.md가 비어 있으면 안 된다");
    for (const tool of REQUIRED_TOOLS) {
      assert.ok(tools.includes(tool), `tools에 ${tool}이 포함되어야 한다`);
    }
    for (const tool of REQUIRED_DISALLOWED_TOOLS) {
      assert.ok(
        disallowedTools.includes(tool),
        `disallowedTools에 ${tool}이 포함되어야 한다`,
      );
    }
    assert.equal(
      parseFrontmatterScalar(frontmatter, "permissionMode"),
      "dontAsk",
    );
    assert.equal(parseFrontmatterScalar(frontmatter, "name"), "slim-wrapper");
  });
});

describe("slim-wrapper 프롬프트와 정의 일관성 검증", () => {
  it("HARD CONSTRAINT 허용 도구와 slim-wrapper.md tools가 일치해야 한다", async () => {
    const content = await fs.readFile(slimWrapperPath, "utf8");
    const frontmatter = getFrontmatterBlock(content);
    const prompt = buildSlimWrapperPrompt("codex", { subtask: "bypass audit" });

    assert.deepEqual(
      parsePromptAllowedTools(prompt),
      parseFrontmatterList(frontmatter, "tools"),
    );
    assert.match(prompt, /tfx-route\.sh/u);
    assert.equal(SLIM_WRAPPER_SUBAGENT_TYPE, "slim-wrapper");
  });
});

describe("setup.mjs 에이전트 동기화 검증", () => {
  it("agents 동기화 섹션과 소스/대상 경로를 유지해야 한다", async () => {
    const source = await fs.readFile(setupScriptPath, "utf8");

    assert.match(source, /(에이전트 동기화|agents)/u);
    assert.match(
      source,
      /const agentsSrc = join\(PLUGIN_ROOT, "\.claude", "agents"\);/u,
    );
    assert.match(source, /const agentsDst = join\(CLAUDE_DIR, "agents"\);/u);
  });
});

describe("slim-wrapper bypass 탐지 검증", () => {
  const routePrompt = buildSlimWrapperPrompt("codex", {
    subtask: "bypass audit",
  });

  for (const directTool of ["Edit(", "Write(", "Read("]) {
    it(`stdout에 ${directTool} 흔적이 있으면 bypass로 판정해야 한다`, () => {
      const result = verifySlimWrapperRouteExecution({
        promptText: routePrompt,
        stdoutText: `${directTool}file_path="demo"`,
        stderrText: "",
      });

      assert.equal(result.expectedRouteInvocation, true);
      assert.equal(result.sawDirectToolBypass, true);
      assert.equal(result.usedRoute, false);
      assert.equal(result.abnormal, true);
      assert.equal(result.reason, "direct_tool_bypass_detected");
    });
  }

  it("stderr에 tfx-route 로그가 있으면 정상 경유로 판정해야 한다", () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: routePrompt,
      stdoutText: "delegated via wrapper",
      stderrText: "[tfx-route] role=executor cli=codex",
    });

    assert.equal(result.expectedRouteInvocation, true);
    assert.equal(result.sawDirectToolBypass, false);
    assert.equal(result.usedRoute, true);
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });
});
