import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  checkHub,
  detectCodexAuthState,
  detectCodexPlan,
  resolveDefaultStatusUrl,
} from "../../scripts/lib/env-probe.mjs";

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), "tfx-env-probe-"));
}

function makeJwt(plan = "pro", extra = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-1",
      exp: 1_900_000_000,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: plan,
      },
      ...extra,
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function writeChatgptAuth(homeDir, plan = "pro", extra = {}) {
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  writeFileSync(
    join(homeDir, ".codex", "auth.json"),
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          id_token: makeJwt(plan, extra),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("env-probe detectCodexAuthState", () => {
  it("auth.json이 없으면 no_auth fingerprint를 반환한다", () => {
    const homeDir = makeTempHome();
    try {
      const state = detectCodexAuthState({ homeDir });
      assert.deepEqual(state, {
        plan: "unknown",
        source: "no_auth",
        fingerprint: "no_auth",
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("ChatGPT auth fingerprint는 plan/token 변화에 따라 달라진다", () => {
    const homeDir = makeTempHome();
    try {
      writeChatgptAuth(homeDir, "pro", { sub: "user-1" });
      const first = detectCodexAuthState({ homeDir });

      writeChatgptAuth(homeDir, "plus", { sub: "user-2", exp: 1_900_000_100 });
      const second = detectCodexAuthState({ homeDir });

      assert.equal(first.plan, "pro");
      assert.equal(first.source, "jwt");
      assert.equal(typeof first.fingerprint, "string");
      assert.notEqual(first.fingerprint, "no_auth");
      assert.equal(second.plan, "plus");
      assert.notEqual(first.fingerprint, second.fingerprint);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("detectCodexPlan은 fingerprint 없이 기존 plan/source 표면만 유지한다", () => {
    const homeDir = makeTempHome();
    try {
      writeChatgptAuth(homeDir, "pro");
      const plan = detectCodexPlan({ homeDir });
      assert.deepEqual(plan, { plan: "pro", source: "jwt" });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("env-probe hub port resolution", () => {
  it("resolveDefaultStatusUrl honors TFX_HUB_PORT", () => {
    assert.equal(
      resolveDefaultStatusUrl({ TFX_HUB_PORT: "30123" }),
      "http://127.0.0.1:30123/status",
    );
    assert.equal(
      resolveDefaultStatusUrl({ TFX_HUB_PORT: "not-a-number" }),
      "http://127.0.0.1:27888/status",
    );
  });

  it("checkHub probes and restarts using the env-selected port", () => {
    const originalPort = process.env.TFX_HUB_PORT;
    process.env.TFX_HUB_PORT = "30124";
    const commands = [];
    const spawnCalls = [];
    let attempts = 0;

    try {
      const result = checkHub({
        pkgRoot: makeTempHome(),
        execSyncFn(command) {
          commands.push(command);
          attempts += 1;
          if (attempts === 1) throw new Error("down");
          return JSON.stringify({ hub: { state: "healthy" }, pid: 1234 });
        },
        spawnFn(command, args, options) {
          spawnCalls.push({ command, args, options });
          return { unref() {} };
        },
        existsSyncFn() {
          return true;
        },
        sleepSyncFn() {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.restarted, true);
      assert.ok(commands.every((command) => command.includes(":30124/status")));
      assert.equal(spawnCalls[0]?.options?.env?.TFX_HUB_PORT, "30124");
    } finally {
      if (originalPort === undefined) delete process.env.TFX_HUB_PORT;
      else process.env.TFX_HUB_PORT = originalPort;
    }
  });
});
