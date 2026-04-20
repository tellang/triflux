// tests/unit/backend.test.mjs — Backend 인터페이스 단위 테스트

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildGeminiCommand,
  ClaudeBackend,
  CodexBackend,
  GeminiBackend,
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
    const cmd = backend.buildArgs(
      "(Get-Content -Raw '/tmp/p.txt')",
      "/tmp/r.txt",
    );
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

  it("buildArgs — gemini --yolo --prompt ... --output-format text > result 포함", () => {
    const cmd = backend.buildArgs(
      "(Get-Content -Raw '/tmp/p.txt')",
      "/tmp/r.txt",
    );
    assert.ok(
      cmd.includes("gemini --yolo --prompt"),
      `gemini --yolo --prompt 포함: ${cmd}`,
    );
    assert.ok(
      cmd.includes("--output-format text"),
      `--output-format text 포함: ${cmd}`,
    );
    assert.ok(cmd.includes("> '/tmp/r.txt'"), `> result 포함: ${cmd}`);
  });

  it("env() — 빈 객체 반환", () => {
    assert.deepEqual(backend.env(), {});
  });
});

// ========================================================================
// GeminiBackend — buildGeminiCommand pure helper (Windows/Unix 양 분기)
// ========================================================================
describe("buildGeminiCommand: platform-specific formatting", () => {
  const prompt = "(Get-Content -Raw '/tmp/p.txt')";
  const resultFile = "/tmp/r.txt";

  it("Windows 분기 — $null | gemini --yolo --prompt ... (silent-hang 회귀 방지)", () => {
    const cmd = buildGeminiCommand(prompt, resultFile, { isWindows: true });
    assert.ok(
      cmd.startsWith("$null | gemini --yolo --prompt "),
      `Windows 분기 시작 prefix: ${cmd}`,
    );
    assert.ok(
      /\bgemini\s+--yolo\s+--prompt\b/.test(cmd),
      `--yolo 가 --prompt 앞에 위치: ${cmd}`,
    );
    assert.ok(
      cmd.includes(`> '${resultFile}' 2>'${resultFile}.err'`),
      `result/err 리다이렉트: ${cmd}`,
    );
    assert.ok(!cmd.includes("< /dev/null"), `Windows 는 /dev/null 미사용: ${cmd}`);
  });

  it("Unix 분기 — gemini --yolo --prompt ... < /dev/null (silent-hang 회귀 방지)", () => {
    const cmd = buildGeminiCommand(prompt, resultFile, { isWindows: false });
    assert.ok(
      cmd.startsWith("gemini --yolo --prompt "),
      `Unix 분기 시작 prefix: ${cmd}`,
    );
    assert.ok(
      /\bgemini\s+--yolo\s+--prompt\b/.test(cmd),
      `--yolo 가 --prompt 앞에 위치: ${cmd}`,
    );
    assert.ok(cmd.endsWith("< /dev/null"), `stdin redirect suffix: ${cmd}`);
    assert.ok(!cmd.startsWith("$null"), `Unix 는 $null prefix 미사용: ${cmd}`);
  });

  it("양 분기 모두 --yolo 플래그 필수 (미누락 invariant)", () => {
    const win = buildGeminiCommand(prompt, resultFile, { isWindows: true });
    const unix = buildGeminiCommand(prompt, resultFile, { isWindows: false });
    for (const cmd of [win, unix]) {
      assert.ok(
        /\bgemini\s+--yolo\b/.test(cmd),
        `--yolo 플래그 누락: ${cmd}`,
      );
      assert.ok(
        cmd.indexOf("--yolo") < cmd.indexOf("--prompt"),
        `--yolo 는 --prompt 앞: ${cmd}`,
      );
    }
  });

  it("isWindows 생략 시 Unix 분기로 기본 동작", () => {
    const cmd = buildGeminiCommand(prompt, resultFile);
    assert.ok(cmd.startsWith("gemini --yolo"), `기본 Unix 포맷: ${cmd}`);
    assert.ok(cmd.endsWith("< /dev/null"), `기본 /dev/null: ${cmd}`);
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

  it("buildArgs — claude --print ... --output-format text 포함", () => {
    const cmd = backend.buildArgs(
      "(Get-Content -Raw '/tmp/p.txt')",
      "/tmp/r.txt",
    );
    assert.ok(cmd.includes("claude --print"), `claude --print 포함: ${cmd}`);
    assert.ok(
      cmd.includes("--output-format text"),
      `--output-format text 포함: ${cmd}`,
    );
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
    assert.throws(
      () => getBackendForAgent("nonexistent-agent-xyz"),
      /지원하지 않는/,
    );
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
  const agentMap = JSON.parse(
    readFileSync(join(ROOT, "hub/team/agent-map.json"), "utf8"),
  );
  const validCliNames = ["codex", "gemini", "claude"];

  it("agent-map.json의 모든 값이 유효한 CLI 이름", () => {
    for (const [agent, cli] of Object.entries(agentMap)) {
      assert.ok(
        validCliNames.includes(cli),
        `agent-map.json["${agent}"] = "${cli}" — 유효하지 않은 CLI 이름`,
      );
    }
  });

  it("agent-map.json의 모든 에이전트가 getBackendForAgent로 조회 가능", () => {
    for (const agent of Object.keys(agentMap)) {
      const b = getBackendForAgent(agent);
      assert.ok(b, `getBackendForAgent("${agent}") 반환값 있어야 함`);
      assert.ok(
        typeof b.name === "function",
        `"${agent}" 백엔드에 name() 메서드 필요`,
      );
      assert.ok(
        typeof b.buildArgs === "function",
        `"${agent}" 백엔드에 buildArgs() 메서드 필요`,
      );
    }
  });
});
