// Regression guard: codex 0.137 dropped `profile` from the Codex MCP tool
// schema (accepted: prompt/model/cwd/approval-policy/sandbox/config/
// base-instructions/developer-instructions/compact-prompt). Sending `profile`
// hard-fails with "unknown field `profile`". buildCodexArguments must translate
// the effort profile into `model` + `config.model_reasoning_effort` and must
// never emit a `profile` tool argument.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildCodexArguments,
  resolveCodexProfileConfig,
} from "../../hub/workers/codex-mcp.mjs";

const tempDirs = [];
let savedCodexHome;

beforeEach(() => {
  savedCodexHome = process.env.CODEX_HOME;
  const root = mkdtempSync(join(tmpdir(), "triflux-codex-profile-"));
  tempDirs.push(root);
  process.env.CODEX_HOME = root;
  writeFileSync(
    join(root, "gpt55_high.config.toml"),
    'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
  );
  writeFileSync(
    join(root, "gpt55_xhigh.config.toml"),
    'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
  );
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("resolveCodexProfileConfig", () => {
  it("reads model + reasoning effort from the SSOT profile file", () => {
    assert.deepEqual(resolveCodexProfileConfig("gpt55_high"), {
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    assert.deepEqual(resolveCodexProfileConfig("gpt55_xhigh"), {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
  });

  it("tolerates inline comments and single quotes", () => {
    const root = process.env.CODEX_HOME;
    writeFileSync(
      join(root, "gpt55_commented.config.toml"),
      'model = "gpt-5.5"   # pinned\nmodel_reasoning_effort = "high"  # effort lane\n',
    );
    assert.deepEqual(resolveCodexProfileConfig("gpt55_commented"), {
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    writeFileSync(
      join(root, "gpt55_squote.config.toml"),
      "model = 'gpt-5.5'\nmodel_reasoning_effort = 'low'\n",
    );
    assert.deepEqual(resolveCodexProfileConfig("gpt55_squote"), {
      model: "gpt-5.5",
      reasoningEffort: "low",
    });
  });

  it("derives effort from the naming convention when the file is absent", () => {
    // No gpt55_med file written → fallback path.
    assert.deepEqual(resolveCodexProfileConfig("gpt55_med"), {
      model: null,
      reasoningEffort: "medium",
    });
  });

  it("returns nulls for an unknown non-file alias", () => {
    assert.deepEqual(resolveCodexProfileConfig("none"), {
      model: null,
      reasoningEffort: null,
    });
    assert.deepEqual(resolveCodexProfileConfig(""), {
      model: null,
      reasoningEffort: null,
    });
  });
});

describe("buildCodexArguments — codex 0.137 profile regression guard", () => {
  it("never emits a `profile` tool argument", () => {
    const args = buildCodexArguments("hi", {
      profile: "gpt55_high",
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    assert.equal(
      Object.hasOwn(args, "profile"),
      false,
      "args must not carry the 0.137-rejected `profile` field",
    );
  });

  it("maps the effort profile to model + config.model_reasoning_effort", () => {
    const args = buildCodexArguments("hi", { profile: "gpt55_high" });
    assert.equal(args.model, "gpt-5.5");
    assert.equal(args.config?.model_reasoning_effort, "high");
  });

  it("lets an explicit model win over the profile model", () => {
    const args = buildCodexArguments("hi", {
      profile: "gpt55_high",
      model: "gpt-5.5-codex",
    });
    assert.equal(args.model, "gpt-5.5-codex");
    // effort still applied from the profile
    assert.equal(args.config?.model_reasoning_effort, "high");
  });

  it("merges profile effort on top of an explicit config object", () => {
    const args = buildCodexArguments("hi", {
      profile: "gpt55_xhigh",
      config: { foo: "bar" },
    });
    assert.equal(args.config.foo, "bar");
    assert.equal(args.config.model_reasoning_effort, "xhigh");
  });

  it("only sets the accepted Codex tool fields", () => {
    const args = buildCodexArguments("hi", {
      profile: "gpt55_high",
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const accepted = new Set([
      "prompt",
      "model",
      "cwd",
      "approval-policy",
      "sandbox",
      "config",
      "base-instructions",
      "developer-instructions",
      "compact-prompt",
    ]);
    for (const key of Object.keys(args)) {
      assert.ok(accepted.has(key), `unexpected tool field forwarded: ${key}`);
    }
  });
});
