import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listProbeTargets,
  normalizeAppServerRateLimits,
  probeRateLimitsViaAppServer,
  recordProbe,
} from "../../hud/providers/codex-probe.mjs";

const FIXTURE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 45,
      windowDurationMins: 300,
      resetsAt: 1783767909,
    },
    secondary: {
      usedPercent: 7,
      windowDurationMins: 10080,
      resetsAt: 1784354709,
    },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 45,
        windowDurationMins: 300,
        resetsAt: 1783767909,
      },
      secondary: {
        usedPercent: 7,
        windowDurationMins: 10080,
        resetsAt: 1784354709,
      },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: {
        usedPercent: 3,
        windowDurationMins: 300,
        resetsAt: 1783776279,
      },
      secondary: {
        usedPercent: 1,
        windowDurationMins: 10080,
        resetsAt: 1784363079,
      },
      credits: null,
      individualLimit: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
  },
};

test("normalizeAppServerRateLimits: byLimitId 전체를 snake_case 스냅샷으로 변환", () => {
  const out = normalizeAppServerRateLimits(FIXTURE, "2026-07-11T09:00:00.000Z");
  const codex = out.find((s) => s.limitId === "codex");
  assert.equal(codex.primary.used_percent, 45);
  assert.equal(codex.primary.window_minutes, 300);
  assert.equal(codex.primary.resets_at, 1783767909);
  assert.equal(codex.secondary.window_minutes, 10080);
  assert.equal(codex.timestamp, "2026-07-11T09:00:00.000Z");
  assert.equal(codex.probe, true);
  assert.equal(codex.tokens, null);
  const spark = out.find((s) => s.limitId === "codex_bengalfox");
  assert.equal(spark.primary.used_percent, 3);
});

test("normalizeAppServerRateLimits: byLimitId 없으면 top-level rateLimits 폴백", () => {
  const out = normalizeAppServerRateLimits(
    { rateLimits: FIXTURE.rateLimits },
    "2026-07-11T09:00:00.000Z",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].limitId, "codex");
});

test("normalizeAppServerRateLimits: null/빈 응답은 빈 배열", () => {
  assert.deepEqual(normalizeAppServerRateLimits(null, "t"), []);
  assert.deepEqual(normalizeAppServerRateLimits({}, "t"), []);
});

function writeFakeServer(body) {
  const dir = mkdtempSync(join(tmpdir(), "tfx-probe-test-"));
  const path = join(dir, "fake-app-server.mjs");
  writeFileSync(path, body);
  return path;
}

const FAKE_OK = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { codexHome: process.env.CODEX_HOME || "" } }) + "\\n");
    } else if (msg.method === "account/rateLimits/read") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        rateLimits: { limitId: "codex", limitName: null,
          primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1783767909 },
          secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1784354709 },
          credits: null, individualLimit: null, planType: "pro", rateLimitReachedType: null } } }) + "\\n");
    }
  }
});
`;

test("probeRateLimitsViaAppServer: 정상 왕복 → 정규화 스냅샷", async () => {
  const fake = writeFakeServer(FAKE_OK);
  const out = await probeRateLimitsViaAppServer({
    spawnBin: process.execPath,
    spawnArgs: [fake],
    timeoutMs: 5000,
    now: new Date("2026-07-11T09:00:00.000Z"),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].primary.used_percent, 45);
  assert.equal(out[0].timestamp, "2026-07-11T09:00:00.000Z");
});

test("probeRateLimitsViaAppServer: 타임아웃이면 null (fail-open)", async () => {
  const fake = writeFakeServer("setInterval(() => {}, 1000);");
  const out = await probeRateLimitsViaAppServer({
    spawnBin: process.execPath,
    spawnArgs: [fake],
    timeoutMs: 300,
  });
  assert.equal(out, null);
});

test("probeRateLimitsViaAppServer: 스폰 실패면 null", async () => {
  const out = await probeRateLimitsViaAppServer({
    spawnBin: "/nonexistent/bin/never",
    timeoutMs: 500,
  });
  assert.equal(out, null);
});

function jwtWithExp(expSec) {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: expSec, email: "t@t" })}.x`;
}

function makeAuthDir(root, name, expSec) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: jwtWithExp(expSec),
        id_token: jwtWithExp(expSec),
      },
    }),
  );
  return dir;
}

test("listProbeTargets: 현재 계정 + 브로커 캐시 열거, 만료 임박 제외, TTL 스로틀", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-probe-targets-"));
  const nowMs = Date.parse("2026-07-11T09:00:00Z");
  const okExp = Math.floor(nowMs / 1000) + 3600;
  const nearExp = Math.floor(nowMs / 1000) + 60;
  const codexDir = makeAuthDir(root, "codex-home", okExp);
  const brokerDir = join(root, "broker");
  mkdirSync(brokerDir, { recursive: true });
  writeFileSync(
    join(brokerDir, "codex-auth-alpha.json"),
    JSON.stringify({ tokens: { access_token: jwtWithExp(okExp) } }),
  );
  writeFileSync(
    join(brokerDir, "codex-auth-beta.json"),
    JSON.stringify({ tokens: { access_token: jwtWithExp(nearExp) } }),
  );
  const stateFile = join(root, "probe-state.json");

  const targets = listProbeTargets({
    codexAuthPath: join(codexDir, "auth.json"),
    brokerCacheDir: brokerDir,
    stateFilePath: stateFile,
    ttlMs: 300000,
    nowMs,
  });
  const keys = targets.map((target) => target.key).sort();
  assert.deepEqual(keys, ["alpha", "current"]);
  for (const target of targets) {
    assert.ok(target.codexHome, `codexHome 필요: ${target.key}`);
    const auth = JSON.parse(
      readFileSync(join(target.codexHome, "auth.json"), "utf-8"),
    );
    assert.ok(auth.tokens.access_token);
  }

  recordProbe(stateFile, "alpha", nowMs);
  const second = listProbeTargets({
    codexAuthPath: join(codexDir, "auth.json"),
    brokerCacheDir: brokerDir,
    stateFilePath: stateFile,
    ttlMs: 300000,
    nowMs: nowMs + 1000,
  });
  assert.deepEqual(
    second.map((target) => target.key),
    ["current"],
  );
});
