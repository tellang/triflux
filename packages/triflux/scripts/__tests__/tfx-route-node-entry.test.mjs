// tfx-route.mjs Phase 0 PoC — 단위 테스트.
//
// 검증 범위:
//   1. 4개 CLI 어댑터의 {id, cliType, plan, describe} 계약
//   2. parseArgs — positional + flag 처리, 거부 케이스
//   3. selectAdapter — CLI 타입별 매핑
//   4. buildRoutePlan — agent-map.json 의 모든 agent 가 분기에 도달
//   5. 어댑터별 핵심 속성 (effort, timeout, runMode, stdinMode, opusOversight)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const AGENT_MAP_PATH = join(REPO_ROOT, "hub/team/agent-map.json");

const route = await import("../tfx-route.mjs");
const codexAdapter = await import("../lib/cli-codex.mjs");
const geminiAdapter = await import("../lib/cli-gemini.mjs");
const claudeAdapter = await import("../lib/cli-claude.mjs");
const agyAdapter = await import("../lib/cli-agy.mjs");

const AGENT_MAP = JSON.parse(readFileSync(AGENT_MAP_PATH, "utf8"));

describe("tfx-route.mjs Phase 0 PoC — adapter contract", () => {
  const adapters = [
    ["codex", codexAdapter, "codex", "codex"],
    ["gemini", geminiAdapter, "gemini", "antigravity"],
    ["claude", claudeAdapter, "claude", "claude-native"],
    ["agy", agyAdapter, "agy", "antigravity"],
  ];

  for (const [name, adapter, expectedId, expectedCliType] of adapters) {
    test(`cli-${name}.mjs exports {id, cliType, plan, describe}`, () => {
      assert.equal(adapter.id, expectedId);
      assert.equal(adapter.cliType, expectedCliType);
      assert.equal(typeof adapter.plan, "function");
      assert.equal(typeof adapter.describe, "function");
      const desc = adapter.describe();
      assert.equal(desc.id, expectedId);
      assert.equal(desc.cliType, expectedCliType);
      assert.ok(Array.isArray(desc.agents));
      assert.ok(desc.agents.length > 0, "agents 배열이 비어있음");
    });
  }
});

describe("tfx-route.mjs — parseArgs", () => {
  test("positional: agent + prompt only (mcpProfile=auto default)", () => {
    const r = route.parseArgs(["executor", "implement X"]);
    assert.equal(r.mode, "run");
    assert.equal(r.agent, "executor");
    assert.equal(r.prompt, "implement X");
    assert.equal(r.mcpProfile, "auto");
    assert.equal(r.timeoutSec, undefined);
    assert.equal(r.contextFile, undefined);
  });

  test("positional: agent + prompt + mcp + timeout + context", () => {
    const r = route.parseArgs([
      "executor",
      "implement X",
      "implement",
      "1080",
      "/tmp/ctx.md",
    ]);
    assert.equal(r.agent, "executor");
    assert.equal(r.prompt, "implement X");
    assert.equal(r.mcpProfile, "implement");
    assert.equal(r.timeoutSec, 1080);
    assert.equal(r.contextFile, "/tmp/ctx.md");
  });

  test("--async flag → mode=async, positional 이어서 파싱", () => {
    const r = route.parseArgs([
      "--async",
      "scientist",
      "deep research",
      "auto",
      "1440",
    ]);
    assert.equal(r.mode, "async");
    assert.equal(r.agent, "scientist");
    assert.equal(r.prompt, "deep research");
    assert.equal(r.timeoutSec, 1440);
  });

  test("--job-status <id> → 즉시 반환, agent/prompt 불필요", () => {
    const r = route.parseArgs(["--job-status", "job-abc-123"]);
    assert.equal(r.mode, "job-status");
    assert.equal(r.jobId, "job-abc-123");
    assert.equal(r.agent, undefined);
  });

  test("--job-result <id> → 즉시 반환", () => {
    const r = route.parseArgs(["--job-result", "job-xyz"]);
    assert.equal(r.mode, "job-result");
    assert.equal(r.jobId, "job-xyz");
  });

  test("--version → mode=version, 다른 인자 무시", () => {
    const r = route.parseArgs(["--version"]);
    assert.equal(r.mode, "version");
  });

  test("--help / -h → mode=help", () => {
    assert.equal(route.parseArgs(["--help"]).mode, "help");
    assert.equal(route.parseArgs(["-h"]).mode, "help");
  });

  test("--route-print → dryRun=true, mode=route-print", () => {
    const r = route.parseArgs(["--route-print", "executor", "go"]);
    assert.equal(r.mode, "route-print");
    assert.equal(r.dryRun, true);
    assert.equal(r.agent, "executor");
  });

  test("거부: agent 누락", () => {
    assert.throws(() => route.parseArgs([]), /Agent type required/);
  });

  test("거부: prompt 누락", () => {
    assert.throws(() => route.parseArgs(["executor"]), /Prompt required/);
  });

  test("거부: 3번째 인자(MCP_PROFILE) 자리에 플래그", () => {
    assert.throws(
      () => route.parseArgs(["executor", "go", "--mode"]),
      /cannot be a flag/,
    );
  });

  test("거부: 알 수 없는 플래그", () => {
    assert.throws(
      () => route.parseArgs(["--bogus", "executor", "go"]),
      /Unknown flag/,
    );
  });

  test("거부: timeout_sec 가 숫자 아님", () => {
    assert.throws(
      () => route.parseArgs(["executor", "go", "auto", "abc"]),
      /must be numeric/,
    );
  });
});

describe("tfx-route.mjs — selectAdapter", () => {
  test("codex → codex adapter", () => {
    assert.equal(route.selectAdapter("codex").id, "codex");
  });
  test("gemini → agy adapter compatibility alias", () => {
    assert.equal(route.selectAdapter("gemini").id, "agy");
  });
  test("claude-native → claude adapter", () => {
    assert.equal(route.selectAdapter("claude-native").id, "claude");
  });
  test("claude (raw) → claude adapter (alias)", () => {
    assert.equal(route.selectAdapter("claude").id, "claude");
  });
  test("antigravity → agy adapter", () => {
    assert.equal(route.selectAdapter("antigravity").id, "agy");
  });
  test("agy → agy adapter (alias)", () => {
    assert.equal(route.selectAdapter("agy").id, "agy");
  });
  test("unknown CLI type throws", () => {
    assert.throws(
      () => route.selectAdapter("totally-nonexistent"),
      /No adapter registered/,
    );
  });
});

describe("tfx-route.mjs — resolveCliTypeForAgent", () => {
  test("claude raw → claude-native (parity with tfx-route.sh L990)", () => {
    assert.equal(
      route.resolveCliTypeForAgent("explore", AGENT_MAP),
      "claude-native",
    );
    assert.equal(
      route.resolveCliTypeForAgent("claude", AGENT_MAP),
      "claude-native",
    );
  });
  test("codex raw 그대로 유지", () => {
    assert.equal(route.resolveCliTypeForAgent("executor", AGENT_MAP), "codex");
  });
  test("antigravity raw 그대로 유지", () => {
    assert.equal(
      route.resolveCliTypeForAgent("antigravity", AGENT_MAP),
      "antigravity",
    );
    assert.equal(route.resolveCliTypeForAgent("agy", AGENT_MAP), "antigravity");
  });
  test("unknown agent throws", () => {
    assert.throws(
      () => route.resolveCliTypeForAgent("nope-not-real", AGENT_MAP),
      /Unknown agent type/,
    );
  });
});

describe("tfx-route.mjs — buildRoutePlan (agent-map.json 전수)", () => {
  const EXPECTED_CLI = {
    codex: "codex",
    gemini: "gemini",
    claude: "claude-native",
    antigravity: "antigravity",
  };

  for (const [agent, mappedCli] of Object.entries(AGENT_MAP)) {
    const expectedCliType = EXPECTED_CLI[mappedCli];
    test(`agent=${agent} → cliType=${expectedCliType}`, () => {
      const plan = route.buildRoutePlan(
        { agent, prompt: "hello", mcpProfile: "auto" },
        AGENT_MAP,
      );
      assert.equal(plan.agent, agent);
      assert.equal(plan.cliType, expectedCliType);
      assert.ok(
        typeof plan.timeoutMs === "number" && plan.timeoutMs > 0,
        `timeoutMs invalid: ${plan.timeoutMs}`,
      );
      assert.ok(
        plan.runMode === "fg" || plan.runMode === "bg",
        `runMode invalid: ${plan.runMode}`,
      );
    });
  }
});

describe("cli-codex.mjs — 핵심 매핑", () => {
  test("executor → gpt55_high / 1080s / fg / mcp=implement", () => {
    const p = codexAdapter.plan({
      agent: "executor",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.effort, "gpt55_high");
    assert.equal(p.profile, "gpt55_high");
    assert.equal(p.timeoutMs, 1_080_000);
    assert.equal(p.runMode, "fg");
    assert.equal(p.opusOversight, false);
    assert.equal(p.mcpProfile, "implement");
    assert.equal(p.subcommand, "exec");
  });

  test("architect → gpt55_xhigh / 3600s / bg / opus oversight", () => {
    const p = codexAdapter.plan({
      agent: "architect",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.effort, "gpt55_xhigh");
    assert.equal(p.timeoutMs, 3_600_000);
    assert.equal(p.runMode, "bg");
    assert.equal(p.opusOversight, true);
    assert.equal(p.mcpProfile, "analyze");
  });

  test("security-reviewer → review 서브커맨드 + opus oversight", () => {
    const p = codexAdapter.plan({
      agent: "security-reviewer",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.subcommand, "review");
    assert.equal(p.mcpProfile, "review");
    assert.equal(p.opusOversight, true);
  });

  test("명시 mcpProfile 는 agent hint 를 override", () => {
    const p = codexAdapter.plan({
      agent: "executor",
      prompt: "x",
      mcpProfile: "review",
    });
    assert.equal(p.mcpProfile, "review");
  });

  test("명시 timeoutSec 는 agent default 를 override", () => {
    const p = codexAdapter.plan({
      agent: "executor",
      prompt: "x",
      mcpProfile: "auto",
      timeoutSec: 30,
    });
    assert.equal(p.timeoutMs, 30_000);
  });

  test("미등록 agent → executor default 로 폴백", () => {
    const p = codexAdapter.plan({
      agent: "unmapped-future-agent",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.effort, "gpt55_high");
    assert.equal(p.timeoutMs, 1_080_000);
  });

  test("agent 누락 시 throw", () => {
    assert.throws(() => codexAdapter.plan({}), /agent required/);
  });
});

describe("cli-gemini.mjs — Antigravity compatibility alias", () => {
  test("designer → agy_v1 / 900s / bg / stdin pipe", () => {
    const p = geminiAdapter.plan({
      agent: "designer",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.effort, "agy_v1");
    assert.equal(p.timeoutMs, 900_000);
    assert.equal(p.runMode, "bg");
    assert.equal(p.mcpProfile, "docs");
    assert.equal(p.stdinMode, "pipe");
    assert.deepEqual(p.args, ["--print", "--dangerously-skip-permissions"]);
  });

  test("writer → agy_v1 stdin pipe", () => {
    const p = geminiAdapter.plan({
      agent: "writer",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.effort, "agy_v1");
    assert.equal(p.stdinMode, "pipe");
    assert.deepEqual(p.args, ["--print", "--dangerously-skip-permissions"]);
  });
});

describe("cli-claude.mjs — native (no CLI command)", () => {
  test("explore → command=null, model=haiku", () => {
    const p = claudeAdapter.plan({
      agent: "explore",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.command, null);
    assert.equal(p.model, "haiku");
    assert.equal(p.profile, "claude-native");
    assert.equal(p.effort, "n/a");
    assert.equal(p.mcpProfile, null);
    assert.match(p.note, /Claude native/);
  });

  test("verifier (override 경로) → model=sonnet, fg", () => {
    const p = claudeAdapter.plan({
      agent: "verifier",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.model, "sonnet");
    assert.equal(p.runMode, "fg");
  });
});

describe("cli-agy.mjs — stdin-pipe 계약", () => {
  test("antigravity → stdinMode=pipe + --print --dangerously-skip-permissions", () => {
    const p = agyAdapter.plan({
      agent: "antigravity",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.stdinMode, "pipe");
    assert.deepEqual(p.args, ["--print", "--dangerously-skip-permissions"]);
    assert.equal(p.command, "agy");
    assert.equal(p.effort, "agy_v1");
    assert.equal(p.mcpProfile, "docs");
  });

  test("agy (alias) → 동일한 plan", () => {
    const p = agyAdapter.plan({
      agent: "agy",
      prompt: "x",
      mcpProfile: "auto",
    });
    assert.equal(p.stdinMode, "pipe");
    assert.equal(p.command, "agy");
  });
});

describe("preflightNodeVersion", () => {
  test("v18+ 통과", () => {
    assert.equal(route.preflightNodeVersion("18.0.0"), 18);
    assert.equal(route.preflightNodeVersion("20.10.5"), 20);
    assert.equal(route.preflightNodeVersion("26.0.0"), 26);
  });

  test("v16 거부", () => {
    assert.throws(
      () => route.preflightNodeVersion("16.20.0"),
      /Node\.js v18\+/,
    );
  });

  test("실행 환경 자체는 통과해야 함", () => {
    assert.doesNotThrow(() => route.preflightNodeVersion());
  });
});
