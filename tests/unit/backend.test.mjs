// tests/unit/backend.test.mjs — Backend 인터페이스 단위 테스트
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import {
  CodexBackend,
  GeminiBackend,
  ClaudeBackend,
  getBackend,
  getBackendForAgent,
  listBackends,
} from "../../hub/team/backend.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ========================================================================
// 1. 개별 백엔드 buildArgs 검증
// ========================================================================
describe("CodexBackend", () => {
  const backend = new CodexBackend();

  it("name() === 'codex'", () => {
    assert.equal(backend.name(), "codex");
  });

  it("command() === 'codex'", () => {
    assert.equal(backend.command(), "codex");
  });

  it("buildArgs — codex exec ... --color never 포함", () => {
    const cmd = backend.buildArgs("(Get-Content -Raw '/tmp/p.txt')", "/tmp/r.txt");
    assert.ok(cmd.includes("codex exec"), `codex exec 포함: ${cmd}`);
    assert.ok(cmd.includes("--color never"), `--color never 포함: ${cmd}`);
    assert.ok(cmd.includes("/tmp/r.txt"), `resultFile 포함: ${cmd}`);
  });

  it("env() — 빈 객체 반환", () => {
    assert.deepEqual(backend.env(), {});
  });
});

describe("GeminiBackend", () => {
  const backend = new GeminiBackend();

  it("name() === 'gemini'", () => {
    assert.equal(backend.name(), "gemini");
  });

  it("command() === 'gemini'", () => {
    assert.equal(backend.command(), "gemini");
  });

  it("buildArgs — gemini -p ... -o text > result 포함", () => {
    const cmd = backend.buildArgs("(Get-Content -Raw '/tmp/p.txt')", "/tmp/r.txt");
    assert.ok(cmd.includes("gemini -p"), `gemini -p 포함: ${cmd}`);
    assert.ok(cmd.includes("-o text"), `-o text 포함: ${cmd}`);
    assert.ok(cmd.includes("> '/tmp/r.txt'"), `> result 포함: ${cmd}`);
  });

  it("env() — 빈 객체 반환", () => {
    assert.deepEqual(backend.env(), {});
  });
});

describe("ClaudeBackend", () => {
  const backend = new ClaudeBackend();

  it("name() === 'claude'", () => {
    assert.equal(backend.name(), "claude");
  });

  it("command() === 'claude'", () => {
    assert.equal(backend.command(), "claude");
  });

  it("buildArgs — claude -p ... --output-format text 포함", () => {
    const cmd = backend.buildArgs("(Get-Content -Raw '/tmp/p.txt')", "/tmp/r.txt");
    assert.ok(cmd.includes("claude -p"), `claude -p 포함: ${cmd}`);
    assert.ok(cmd.includes("--output-format text"), `--output-format text 포함: ${cmd}`);
    assert.ok(cmd.includes("/tmp/r.txt"), `resultFile 포함: ${cmd}`);
  });

  it("env() — 빈 객체 반환", () => {
    assert.deepEqual(backend.env(), {});
  });
});

// ========================================================================
// 2. 레지스트리 조회 (getBackend)
// ========================================================================
describe("getBackend: 레지스트리 조회", () => {
  it("'codex' → CodexBackend", () => {
    const b = getBackend("codex");
    assert.ok(b instanceof CodexBackend);
    assert.equal(b.name(), "codex");
  });

  it("'gemini' → GeminiBackend", () => {
    const b = getBackend("gemini");
    assert.ok(b instanceof GeminiBackend);
    assert.equal(b.name(), "gemini");
  });

  it("'claude' → ClaudeBackend", () => {
    const b = getBackend("claude");
    assert.ok(b instanceof ClaudeBackend);
    assert.equal(b.name(), "claude");
  });

  it("알 수 없는 이름 → throw (지원하지 않는)", () => {
    assert.throws(() => getBackend("unknown-xyz"), /지원하지 않는/);
  });

  it("빈 문자열 → throw", () => {
    assert.throws(() => getBackend(""), /지원하지 않는/);
  });
});

// ========================================================================
// 3. getBackendForAgent: agent-map.json 연동
// ========================================================================
describe("getBackendForAgent: 에이전트명 → Backend", () => {
  it("'executor' → CodexBackend (codex)", () => {
    const b = getBackendForAgent("executor");
    assert.ok(b instanceof CodexBackend);
  });

  it("'designer' → GeminiBackend (gemini)", () => {
    const b = getBackendForAgent("designer");
    assert.ok(b instanceof GeminiBackend);
  });

  it("'explore' → ClaudeBackend (claude)", () => {
    const b = getBackendForAgent("explore");
    assert.ok(b instanceof ClaudeBackend);
  });

  it("직접 CLI명 'codex' → CodexBackend", () => {
    const b = getBackendForAgent("codex");
    assert.ok(b instanceof CodexBackend);
  });

  it("직접 CLI명 'gemini' → GeminiBackend", () => {
    const b = getBackendForAgent("gemini");
    assert.ok(b instanceof GeminiBackend);
  });

  it("직접 CLI명 'claude' → ClaudeBackend", () => {
    const b = getBackendForAgent("claude");
    assert.ok(b instanceof ClaudeBackend);
  });

  it("알 수 없는 에이전트명 → throw (지원하지 않는)", () => {
    assert.throws(() => getBackendForAgent("nonexistent-agent-xyz"), /지원하지 않는/);
  });
});

// ========================================================================
// 4. listBackends
// ========================================================================
describe("listBackends", () => {
  it("3개 백엔드 반환", () => {
    const list = listBackends();
    assert.equal(list.length, 3);
  });

  it("codex, gemini, claude 모두 포함", () => {
    const names = listBackends().map((b) => b.name());
    assert.ok(names.includes("codex"), "codex 포함");
    assert.ok(names.includes("gemini"), "gemini 포함");
    assert.ok(names.includes("claude"), "claude 포함");
  });
});

// ========================================================================
// 5. agent-map.json 정합성 — 모든 에이전트가 유효한 백엔드로 해석됨
// ========================================================================
describe("agent-map.json 정합성", () => {
  const agentMap = JSON.parse(readFileSync(join(ROOT, "hub/team/agent-map.json"), "utf8"));
  const validCliNames = ["codex", "gemini", "claude"];

  it("agent-map.json의 모든 값이 유효한 CLI 이름", () => {
    for (const [agent, cli] of Object.entries(agentMap)) {
      assert.ok(
        validCliNames.includes(cli),
        `agent-map.json["${agent}"] = "${cli}" — 유효하지 않은 CLI 이름`
      );
    }
  });

  it("agent-map.json의 모든 에이전트가 getBackendForAgent로 조회 가능", () => {
    for (const agent of Object.keys(agentMap)) {
      const b = getBackendForAgent(agent);
      assert.ok(b, `getBackendForAgent("${agent}") 반환값 있어야 함`);
      assert.ok(typeof b.name === "function", `"${agent}" 백엔드에 name() 메서드 필요`);
      assert.ok(typeof b.buildArgs === "function", `"${agent}" 백엔드에 buildArgs() 메서드 필요`);
    }
  });
});
