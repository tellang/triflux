import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildLauncher,
  getAdapter,
  listAgents,
} from "../../hub/team/launcher-template.mjs";

describe("launcher-template: getAdapter", () => {
  it("codex adapter를 반환해야 한다", () => {
    const adapter = getAdapter("codex");
    assert.equal(adapter.bin, "codex");
    assert.equal(typeof adapter.buildArgs, "function");
    assert.equal(typeof adapter.env, "function");
  });

  it("gemini adapter를 반환해야 한다", () => {
    const adapter = getAdapter("gemini");
    assert.equal(adapter.bin, "gemini");
  });

  it("claude adapter를 반환해야 한다", () => {
    const adapter = getAdapter("claude");
    assert.equal(adapter.bin, "claude");
  });

  it("알 수 없는 agent는 에러를 던져야 한다", () => {
    assert.throws(() => getAdapter("unknown"), /Unknown agent/);
  });
});

describe("launcher-template: buildLauncher", () => {
  it("codex 런처는 결정론적이어야 한다 (동일 입력 → 동일 출력)", () => {
    const opts = { agent: "codex", prompt: "fix bug", profile: "default" };
    const a = buildLauncher(opts);
    const b = buildLauncher(opts);
    assert.equal(a.command, b.command);
    assert.equal(a.bin, b.bin);
    assert.deepEqual(a.env, b.env);
  });

  it("codex 런처에 --dangerously-bypass가 포함되어야 한다 (F1 해결)", () => {
    const result = buildLauncher({ agent: "codex", prompt: "test" });
    assert.ok(
      result.command.includes("--dangerously-bypass"),
      `expected --dangerously-bypass in: ${result.command}`,
    );
  });

  it("gemini 런처에 --yolo가 포함되어야 한다", () => {
    const result = buildLauncher({ agent: "gemini", prompt: "test" });
    assert.ok(
      result.command.includes("--yolo"),
      `expected --yolo in: ${result.command}`,
    );
  });

  it("claude 런처에 -p 플래그가 포함되어야 한다", () => {
    const result = buildLauncher({ agent: "claude", prompt: "hello" });
    assert.ok(
      result.command.includes("-p"),
      `expected -p in: ${result.command}`,
    );
  });

  it("agent 없으면 에러를 던져야 한다", () => {
    assert.throws(() => buildLauncher({ prompt: "test" }), /agent is required/);
  });

  it("반환 객체는 frozen이어야 한다", () => {
    const result = buildLauncher({ agent: "codex", prompt: "test" });
    assert.ok(Object.isFrozen(result));
  });

  it("profile이 있으면 codex env에 CODEX_PROFILE이 포함되어야 한다", () => {
    const result = buildLauncher({ agent: "codex", prompt: "test", profile: "myprof" });
    assert.equal(result.env.CODEX_PROFILE, "myprof");
  });

  it("profile이 없으면 codex env는 빈 객체여야 한다", () => {
    const result = buildLauncher({ agent: "codex", prompt: "test" });
    assert.deepEqual(result.env, {});
  });
});

describe("launcher-template: listAgents", () => {
  it("codex, gemini, claude를 포함해야 한다", () => {
    const agents = listAgents();
    assert.ok(agents.includes("codex"));
    assert.ok(agents.includes("gemini"));
    assert.ok(agents.includes("claude"));
  });
});
