// tests/unit/backend.test.mjs — Backend 인터페이스 단위 테스트

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AntigravityBackend,
  buildAntigravityCommand,
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

  it("command() === 'agy' (legacy alias)", () => {
    assert.equal(backend.command(), "agy");
  });

  it("buildArgs — agy --print stdin 계약으로 실행", () => {
    const cmd = backend.buildArgs(
      "(Get-Content -Raw '/tmp/p.txt')",
      "/tmp/r.txt",
    );
    assert.ok(cmd.includes("agy --print"), `agy --print 포함: ${cmd}`);
    assert.ok(
      cmd.includes("--dangerously-skip-permissions"),
      `dangerously flag 포함: ${cmd}`,
    );
    assert.ok(!cmd.includes("gemini --"), `gemini 직접 호출 금지: ${cmd}`);
    assert.ok(cmd.includes("> '/tmp/r.txt'"), `> result 포함: ${cmd}`);
  });

  it("env() — 빈 객체 반환", () => {
    assert.deepEqual(backend.env(), {});
  });
});

// ========================================================================
// GeminiBackend — legacy alias helper (Windows/Unix 양 분기)
// ========================================================================
describe("buildGeminiCommand: platform-specific formatting", () => {
  const prompt = "(Get-Content -Raw '/tmp/p.txt')";
  const resultFile = "/tmp/r.txt";

  it("Windows 분기 — prompt file을 agy stdin으로 전달", () => {
    const cmd = buildGeminiCommand(prompt, resultFile, { isWindows: true });
    assert.ok(
      cmd.startsWith(`Get-Content -Raw '${resultFile}.prompt' | agy --print `),
      `Windows 분기 시작 prefix: ${cmd}`,
    );
    assert.ok(
      cmd.includes(`> '${resultFile}' 2>'${resultFile}.err'`),
      `result/err 리다이렉트: ${cmd}`,
    );
    assert.ok(!cmd.includes("gemini --"), `gemini 직접 호출 금지: ${cmd}`);
  });

  it("Unix 분기 — prompt file redirect로 agy stdin 전달", () => {
    const cmd = buildGeminiCommand(prompt, resultFile, { isWindows: false });
    assert.ok(
      cmd.startsWith(
        `agy --print --dangerously-skip-permissions < '${resultFile}.prompt' `,
      ),
      `Unix 분기 시작 prefix: ${cmd}`,
    );
    assert.ok(cmd.includes(`> '${resultFile}'`), `result redirect: ${cmd}`);
    assert.ok(!cmd.includes("gemini --"), `gemini 직접 호출 금지: ${cmd}`);
  });

  it("양 분기 모두 agy print 계약 필수", () => {
    const win = buildGeminiCommand(prompt, resultFile, { isWindows: true });
    const unix = buildGeminiCommand(prompt, resultFile, { isWindows: false });
    for (const cmd of [win, unix]) {
      assert.ok(
        /\bagy\s+--print\b/.test(cmd),
        `agy --print 플래그 누락: ${cmd}`,
      );
      assert.ok(cmd.includes("--dangerously-skip-permissions"), cmd);
    }
  });

  it("isWindows 생략 시 Unix 분기로 기본 동작", () => {
    const cmd = buildGeminiCommand(prompt, resultFile);
    assert.ok(cmd.startsWith("agy --print"), `기본 Unix 포맷: ${cmd}`);
    assert.ok(cmd.includes(`< '${resultFile}.prompt'`), `기본 stdin: ${cmd}`);
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

describe("AntigravityBackend", () => {
  const backend = new AntigravityBackend();

  it("name() === 'antigravity'", () => {
    assert.equal(backend.name(), "antigravity");
  });

  it("command() === 'agy'", () => {
    assert.equal(backend.command(), "agy");
  });

  it("buildArgs — agy --print stdin pipe 계약을 사용한다", () => {
    const cmd = backend.buildArgs(
      "(Get-Content -Raw '/tmp/p.txt')",
      "/tmp/r.txt",
    );
    assert.ok(cmd.includes("agy --print"), `agy --print 포함: ${cmd}`);
    assert.ok(
      cmd.includes("--dangerously-skip-permissions"),
      `dangerously flag 포함: ${cmd}`,
    );
    assert.ok(cmd.includes("> '/tmp/r.txt'"), `> result 포함: ${cmd}`);
  });

  it("env() — 빈 객체 반환", () => {
    assert.deepEqual(backend.env(), {});
  });
});

describe("buildAntigravityCommand: platform-specific formatting", () => {
  const prompt = "(Get-Content -Raw '/tmp/p.txt')";
  const resultFile = "/tmp/r.txt";

  it("Windows 분기 — prompt file을 PowerShell pipeline으로 stdin 전달", () => {
    const cmd = buildAntigravityCommand(prompt, resultFile, {
      isWindows: true,
    });
    assert.equal(readFileSync(`${resultFile}.prompt`, "utf8"), prompt);
    assert.ok(
      cmd.startsWith(`Get-Content -Raw '${resultFile}.prompt' | agy --print `),
      cmd,
    );
    assert.ok(cmd.includes("--dangerously-skip-permissions"), cmd);
    assert.ok(!cmd.includes(prompt), cmd);
  });

  it("Unix 분기 — prompt file redirect로 stdin 전달", () => {
    const cmd = buildAntigravityCommand(prompt, resultFile, {
      isWindows: false,
    });
    assert.ok(
      cmd.startsWith(
        `agy --print --dangerously-skip-permissions < '${resultFile}.prompt' `,
      ),
      cmd,
    );
    assert.equal(readFileSync(`${resultFile}.prompt`, "utf8"), prompt);
    assert.ok(cmd.includes(`> '${resultFile}'`), cmd);
    assert.ok(!cmd.includes(prompt), cmd);
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

  it("'gemini' → GeminiBackend alias", () => {
    const b = getBackend("gemini");
    assert.ok(b instanceof GeminiBackend);
    assert.equal(b.name(), "gemini");
    assert.equal(b.command(), "agy");
  });

  it("'claude' → ClaudeBackend", () => {
    const b = getBackend("claude");
    assert.ok(b instanceof ClaudeBackend);
    assert.equal(b.name(), "claude");
  });

  it("'antigravity' → AntigravityBackend", () => {
    const b = getBackend("antigravity");
    assert.ok(b instanceof AntigravityBackend);
    assert.equal(b.name(), "antigravity");
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

  it("'designer' → AntigravityBackend", () => {
    const b = getBackendForAgent("designer");
    assert.ok(b instanceof AntigravityBackend);
  });

  it("'explore' → ClaudeBackend (claude)", () => {
    const b = getBackendForAgent("explore");
    assert.ok(b instanceof ClaudeBackend);
  });

  it("직접 CLI명 'codex' → CodexBackend", () => {
    const b = getBackendForAgent("codex");
    assert.ok(b instanceof CodexBackend);
  });

  it("직접 CLI명 'gemini' → AntigravityBackend (agent-map alias)", () => {
    const b = getBackendForAgent("gemini");
    assert.ok(b instanceof AntigravityBackend);
    assert.equal(b.command(), "agy");
  });

  it("직접 CLI명 'claude' → ClaudeBackend", () => {
    const b = getBackendForAgent("claude");
    assert.ok(b instanceof ClaudeBackend);
  });

  it("직접 CLI명 'antigravity' → AntigravityBackend", () => {
    const b = getBackendForAgent("antigravity");
    assert.ok(b instanceof AntigravityBackend);
  });

  it("alias 'agy' → AntigravityBackend", () => {
    const b = getBackendForAgent("agy");
    assert.ok(b instanceof AntigravityBackend);
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
  it("4개 백엔드 반환", () => {
    const list = listBackends();
    assert.equal(list.length, 4);
  });

  it("codex, gemini alias, claude, antigravity 모두 포함", () => {
    const names = listBackends().map((b) => b.name());
    assert.ok(names.includes("codex"), "codex 포함");
    assert.ok(names.includes("gemini"), "gemini 포함");
    assert.ok(names.includes("claude"), "claude 포함");
    assert.ok(names.includes("antigravity"), "antigravity 포함");
  });
});

// ========================================================================
// 5. packages/remote mirror contract — 원격 실행 패키지도 동일 invariant
//    (세션 15: 세션 14 #140 mirror 누락 회귀가 실제 발생했으므로 contract
//    test 로 재발 방지)
// ========================================================================
describe("packages/remote/hub/team/backend.mjs — mirror contract", () => {
  const REMOTE_BACKEND = readFileSync(
    join(ROOT, "packages/remote/hub/team/backend.mjs"),
    "utf8",
  );

  it("buildGeminiCommand helper 가 export 되어야 한다", () => {
    assert.ok(
      /export\s+function\s+buildGeminiCommand\s*\(/.test(REMOTE_BACKEND),
      "buildGeminiCommand export 누락 (root backend.mjs 와 sync)",
    );
  });

  it("Windows 분기에 agy stdin print 포함", () => {
    assert.ok(
      /Get-Content\s+-Raw\s+'\$\{promptFile\}'\s*\|\s*agy\s+--print/.test(
        REMOTE_BACKEND,
      ),
      "Windows 분기 agy stdin 누락",
    );
  });

  it("Unix 분기에 agy stdin print 포함", () => {
    assert.ok(
      /agy\s+--print\s+--dangerously-skip-permissions\s+<\s+'\$\{promptFile\}'/s.test(
        REMOTE_BACKEND,
      ),
      "Unix 분기 agy stdin 누락",
    );
  });

  it("GeminiBackend.buildArgs 가 buildGeminiCommand alias 를 호출", () => {
    const geminiClass = REMOTE_BACKEND.match(
      /class\s+GeminiBackend[\s\S]*?^\}/m,
    );
    assert.ok(geminiClass, "GeminiBackend class 누락");
    assert.ok(
      /buildGeminiCommand\s*\(/.test(geminiClass[0]),
      "GeminiBackend.buildArgs 가 buildGeminiCommand alias 호출 안 함",
    );
  });

  it("CodexBackend / ClaudeBackend 존재 (registry 계약 유지)", () => {
    assert.ok(
      /class\s+CodexBackend\b/.test(REMOTE_BACKEND),
      "CodexBackend class 누락",
    );
    assert.ok(
      /class\s+ClaudeBackend\b/.test(REMOTE_BACKEND),
      "ClaudeBackend class 누락",
    );
    assert.ok(
      /class\s+AntigravityBackend\b/.test(REMOTE_BACKEND),
      "AntigravityBackend class 누락",
    );
  });
});

// ========================================================================
// 6. agent-map.json 정합성 — 모든 에이전트가 유효한 백엔드로 해석됨
// ========================================================================
describe("agent-map.json 정합성", () => {
  const agentMap = JSON.parse(
    readFileSync(join(ROOT, "hub/team/agent-map.json"), "utf8"),
  );
  const validCliNames = ["codex", "gemini", "claude", "antigravity"];

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
