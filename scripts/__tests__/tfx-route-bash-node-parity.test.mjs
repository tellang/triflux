// tfx-route — bash / node 두 lane 회귀가드.
//
// Phase 0 PoC 의 단일 진입점 약속:
//   1. tfx-route.sh 가 TFX_ROUTE_NODE 게이트웨이 + BYPASS guard 를 보유한다
//   2. Node 진입점은 tfx-route.sh 와 동일한 agent-map.json 을 단일 source of truth 로 쓴다
//   3. node tfx-route.mjs --version / --route-print 가 외부 invocation 으로 동작한다
//
// 직접 CLI spawn (codex/gemini/agy) 은 Phase 1 까지 bash 가 소유하므로 여기서는 검증하지
// 않는다. Phase 1 부터 plan → spawn 까지 Node 가 처리할 때 회귀가드를 확장한다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const BASH_SCRIPT = join(REPO_ROOT, "scripts/tfx-route.sh");
const NODE_SCRIPT = join(REPO_ROOT, "scripts/tfx-route.mjs");
const AGENT_MAP_PATH = join(REPO_ROOT, "hub/team/agent-map.json");
const NODE_ROUTE_TIMEOUT_MS = 5_000;
const BASH_ROUTE_TIMEOUT_MS = 15_000;

describe("tfx-route bash/node parity — Phase 0 회귀가드", () => {
  test("tfx-route.sh 에 TFX_ROUTE_NODE 게이트웨이 + bypass guard 존재", () => {
    const sh = readFileSync(BASH_SCRIPT, "utf8");
    assert.match(sh, /TFX_ROUTE_NODE:-0/, "TFX_ROUTE_NODE 플래그 체크 누락");
    assert.match(sh, /exec node[^\n]*tfx-route\.mjs/, "Node 진입점 exec 누락");
    assert.match(sh, /TFX_ROUTE_NODE_BYPASS/, "bypass guard 누락 (재귀 방지)");
  });

  test("tfx-route.sh hub restart forces worktree and ephemeral contexts to 27888", () => {
    const sh = readFileSync(BASH_SCRIPT, "utf8");
    assert.match(sh, /is_ephemeral_hub_context\(\)/);
    assert.match(sh, /\.claude\/worktrees/);
    assert.match(sh, /\.worktrees/);
    assert.match(sh, /\.codex-swarm\/wt-/);
    assert.match(sh, /TFX_WORKER_SANDBOX_SCOPE/);
    assert.match(sh, /if is_ephemeral_hub_context; then\s+hub_port=27888/s);
  });

  test("Node 진입점이 agent-map.json 의 모든 agent 를 dispatch 한다", async () => {
    const route = await import("../tfx-route.mjs");
    const agentMap = JSON.parse(readFileSync(AGENT_MAP_PATH, "utf8"));

    const EXPECTED_CLI = {
      codex: "codex",
      gemini: "gemini",
      claude: "claude-native",
      antigravity: "antigravity",
    };

    for (const [agent, mappedCli] of Object.entries(agentMap)) {
      const expected = EXPECTED_CLI[mappedCli];
      assert.ok(expected, `agent-map.json 의 CLI 타입 미지원: ${mappedCli}`);

      const plan = route.buildRoutePlan(
        { agent, prompt: "parity-smoke", mcpProfile: "auto" },
        agentMap,
      );
      assert.equal(
        plan.cliType,
        expected,
        `agent=${agent} expected cliType=${expected}, got ${plan.cliType}`,
      );
      assert.ok(plan.adapter, "adapter id 누락");
    }
  });

  test("--version invocation: node lane 정상 출력", () => {
    const out = execFileSync("node", [NODE_SCRIPT, "--version"], {
      encoding: "utf8",
      timeout: NODE_ROUTE_TIMEOUT_MS,
    });
    assert.match(out, /tfx-route\.mjs/);
  });

  test("--route-print invocation: executor 의 JSON plan 추출", () => {
    const out = execFileSync(
      "node",
      [NODE_SCRIPT, "--route-print", "executor", "hello world"],
      { encoding: "utf8", timeout: NODE_ROUTE_TIMEOUT_MS },
    );
    const plan = JSON.parse(out);
    assert.equal(plan.agent, "executor");
    assert.equal(plan.cliType, "codex");
    assert.equal(plan.adapter, "codex");
    assert.equal(plan.effort, "gpt55_high");
    assert.equal(plan.runMode, "fg");
  });

  test("--route-print invocation: designer → antigravity", () => {
    const out = execFileSync(
      "node",
      [NODE_SCRIPT, "--route-print", "designer", "ui sketch"],
      { encoding: "utf8", timeout: NODE_ROUTE_TIMEOUT_MS },
    );
    const plan = JSON.parse(out);
    assert.equal(plan.cliType, "antigravity");
    assert.equal(plan.adapter, "agy");
    assert.equal(plan.effort, "agy_v1");
    assert.equal(plan.stdinMode, "pipe");
  });

  test("--route-print invocation: explore → claude-native (no CLI command)", () => {
    const out = execFileSync(
      "node",
      [NODE_SCRIPT, "--route-print", "explore", "search"],
      { encoding: "utf8", timeout: NODE_ROUTE_TIMEOUT_MS },
    );
    const plan = JSON.parse(out);
    assert.equal(plan.cliType, "claude-native");
    assert.equal(plan.adapter, "claude");
    assert.equal(plan.command, null);
  });

  test("--route-print invocation: antigravity → stdin-pipe", () => {
    const out = execFileSync(
      "node",
      [NODE_SCRIPT, "--route-print", "antigravity", "doc gen"],
      { encoding: "utf8", timeout: NODE_ROUTE_TIMEOUT_MS },
    );
    const plan = JSON.parse(out);
    assert.equal(plan.cliType, "antigravity");
    assert.equal(plan.adapter, "agy");
    assert.equal(plan.stdinMode, "pipe");
    assert.deepEqual(plan.args, ["--print", "--dangerously-skip-permissions"]);
  });

  test("Unknown agent → exit 1 + stderr error", () => {
    let threw = false;
    try {
      execFileSync(
        "node",
        [NODE_SCRIPT, "--route-print", "totally-nonexistent-agent", "x"],
        {
          encoding: "utf8",
          timeout: NODE_ROUTE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
      assert.match(String(err.stderr ?? ""), /Unknown agent type/);
    }
    assert.ok(threw, "unknown agent 인데 throw 안 함");
  });

  test("reserved multi command → actionable tfx multi guidance in node lane", () => {
    let threw = false;
    try {
      execFileSync("node", [NODE_SCRIPT, "--route-print", "multi", "x"], {
        encoding: "utf8",
        timeout: NODE_ROUTE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
      assert.match(String(err.stderr ?? ""), /tfx multi/);
      assert.match(String(err.stderr ?? ""), /not a tfx-route agent/i);
    }
    assert.ok(threw, "reserved multi command should fail with guidance");
  });

  test("TFX_ROUTE_NODE=1 게이트웨이: bash → node 정확히 이관", () => {
    const out = execFileSync(
      "bash",
      [BASH_SCRIPT, "--route-print", "executor", "via-gateway"],
      {
        encoding: "utf8",
        timeout: BASH_ROUTE_TIMEOUT_MS,
        env: { ...process.env, TFX_ROUTE_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const plan = JSON.parse(out);
    assert.equal(plan.adapter, "codex");
    assert.equal(plan.cliType, "codex");
  });

  test("TFX_ROUTE_NODE=0 (default): bash lane 그대로 (게이트웨이 무동작)", () => {
    // bash 단독 호출은 정상 검증을 거쳐 unknown agent 라면 정확한 bash-side 에러를
    // 반환해야 한다. node 진입점이면 메시지가 다름 — 게이트웨이가 동작 안 했다는
    // 직접 증거.
    let stderr = "";
    try {
      execFileSync("bash", [BASH_SCRIPT, "nope-nonexistent-agent", "x"], {
        encoding: "utf8",
        timeout: BASH_ROUTE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      stderr = String(err.stderr ?? "");
    }
    // bash 의 route_agent() L983 에러 메시지 ("알 수 없는 에이전트 타입") 가 나와야
    // bash 가 직접 처리했다는 신호. node 진입점이면 "Unknown agent type" (영어) 가 남는다.
    assert.match(stderr, /알 수 없는 에이전트 타입|Unknown agent type/);
  });

  test("reserved multi command → actionable tfx multi guidance in bash lane", () => {
    let stderr = "";
    let status = 0;
    try {
      execFileSync("bash", [BASH_SCRIPT, "multi", "x"], {
        encoding: "utf8",
        timeout: BASH_ROUTE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      stderr = String(err.stderr ?? "");
    }
    assert.equal(status, 64);
    assert.match(stderr, /tfx multi/);
    assert.match(stderr, /not a tfx-route agent/i);
  });
});
