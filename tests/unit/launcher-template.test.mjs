import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

  it("gemini alias adapter는 agy를 반환해야 한다", () => {
    const adapter = getAdapter("gemini");
    assert.equal(adapter.bin, "agy");
  });

  it("antigravity adapter를 반환해야 한다", () => {
    const adapter = getAdapter("antigravity");
    assert.equal(adapter.bin, "agy");
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

  it("gemini 런처는 agy stdin print 계약을 사용해야 한다", () => {
    const result = buildLauncher({ agent: "gemini", prompt: "test" });
    assert.equal(result.bin, "agy");
    assert.ok(result.command.includes("agy --print"), result.command);
    assert.ok(
      result.command.includes("--dangerously-skip-permissions"),
      result.command,
    );
    assert.ok(!result.command.includes("gemini "), result.command);
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
    const result = buildLauncher({
      agent: "codex",
      prompt: "test",
      profile: "myprof",
    });
    assert.equal(result.env.CODEX_PROFILE, "myprof");
  });

  it("profile이 없으면 codex env는 빈 객체여야 한다", () => {
    const result = buildLauncher({ agent: "codex", prompt: "test" });
    assert.deepEqual(result.env, {});
  });
});

describe("launcher-template: listAgents", () => {
  it("codex, gemini alias, antigravity, claude를 포함해야 한다", () => {
    const agents = listAgents();
    assert.ok(agents.includes("codex"));
    assert.ok(agents.includes("gemini"));
    assert.ok(agents.includes("antigravity"));
    assert.ok(agents.includes("claude"));
  });
});

// ── TFX_DISABLE_* 런처 게이트 ───────────────────────────────────────────────
// policyEnv 로 정책을 밀폐한다. env 에 키가 있으면 리더가 machine profile 파일을
// 읽지 않으므로 이 머신의 실제 프로파일에 좌우되지 않는다.
describe("launcher-template: TFX_DISABLE_* 게이트", () => {
  const ENABLED = { TFX_DISABLE_CODEX: "0", TFX_DISABLE_ANTIGRAVITY: "0" };

  it("codex disabled 면 런처 대신 명시 오류를 던진다", () => {
    let thrown = null;
    try {
      buildLauncher({
        agent: "codex",
        prompt: "fix bug",
        policyEnv: { TFX_DISABLE_CODEX: "1", TFX_DISABLE_ANTIGRAVITY: "0" },
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "차단된 codex 요청은 반드시 던져야 한다");
    assert.equal(thrown.code, "TFX_CLI_DISABLED");
    assert.equal(thrown.cli, "codex");
    assert.match(thrown.message, /TFX_DISABLE_CODEX=1/u);
    assert.match(thrown.message, /TFX_DISABLE_CODEX=0/u);
  });

  it("antigravity disabled 면 antigravity, agy, gemini 전부 던진다", () => {
    const policyEnv = { TFX_DISABLE_CODEX: "0", TFX_DISABLE_ANTIGRAVITY: "1" };
    for (const agent of ["antigravity", "agy", "gemini"]) {
      let thrown = null;
      try {
        buildLauncher({ agent, prompt: "test", policyEnv });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, `${agent} 요청은 반드시 던져야 한다`);
      assert.equal(thrown.code, "TFX_CLI_DISABLED");
      assert.equal(thrown.cli, "antigravity");
      assert.match(thrown.message, /TFX_DISABLE_ANTIGRAVITY=1/u);
    }
  });

  it("codex disabled 여도 claude 런처는 만들어진다", () => {
    const result = buildLauncher({
      agent: "claude",
      prompt: "test",
      policyEnv: { TFX_DISABLE_CODEX: "1", TFX_DISABLE_ANTIGRAVITY: "1" },
    });
    assert.equal(result.bin, "claude");
    assert.ok(result.command.includes("claude -p"), result.command);
  });

  it("둘 다 허용이면 기존 런처와 동일하다", () => {
    const gated = buildLauncher({
      agent: "codex",
      prompt: "fix bug",
      profile: "default",
      policyEnv: ENABLED,
    });
    const ungated = buildLauncher({
      agent: "codex",
      prompt: "fix bug",
      profile: "default",
      cliPolicy: {
        codexDisabled: false,
        antigravityDisabled: false,
        source: { codex: "default", antigravity: "default" },
        profilePath: null,
        warnings: [],
      },
    });
    assert.deepEqual({ ...gated }, { ...ungated });
    assert.equal(gated.bin, "codex");
  });

  it("getAdapter 는 게이트 대상이 아니다 (순수 조회)", () => {
    const original = process.env.TFX_DISABLE_CODEX;
    process.env.TFX_DISABLE_CODEX = "1";
    try {
      assert.equal(getAdapter("codex").bin, "codex");
      assert.ok(listAgents().includes("codex"));
    } finally {
      if (original === undefined) delete process.env.TFX_DISABLE_CODEX;
      else process.env.TFX_DISABLE_CODEX = original;
    }
  });
});
