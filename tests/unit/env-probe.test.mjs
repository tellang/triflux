import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  detectCodexAuthState,
  detectCodexPlan,
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
