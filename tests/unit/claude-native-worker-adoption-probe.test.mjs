import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI_PROBE_TIMEOUT_MS = 10_000;

const claudeAvailable =
  spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: CLI_PROBE_TIMEOUT_MS,
  }).status === 0;
const claudeSkipReason =
  "Claude CLI is unavailable or did not respond to `claude --version` in time";

async function runScenario(scenario) {
  const { default: runProbe } = await import(
    "../../experiments/native-bridge-feasibility/claude-native-worker-adoption-probe.mjs"
  );
  return runProbe({ scenario, cleanup: true });
}

test("hot-roster does not register in the live daemon map", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const report = await runScenario("hot-roster");
  assert.equal(report.afterHas.ok, true);
  assert.equal(report.afterHas.present, false);
  assert.equal(report.afterHas.alive, false);
});

test("startup-legacy adopts a schema-valid pid without PTY as legacy", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const report = await runScenario("startup-legacy");
  assert.equal(report.has.ok, true);
  assert.equal(report.has.present, true);
  assert.equal(report.has.alive, true);
  assert.equal(report.list.jobs[0].legacy, true);
});

test("startup-native adopts fake RV and PTY worker", {
  skip: claudeAvailable ? false : claudeSkipReason,
}, async () => {
  const report = await runScenario("startup-native");
  assert.equal(report.has.ok, true);
  assert.equal(report.has.present, true);
  assert.equal(report.has.alive, true);
  assert.notEqual(report.list.jobs[0].legacy, true);
  assert.equal(
    report.subscribe.some((message) => message.type === "snapshot"),
    true,
  );
  assert.equal(
    report.subscribe.some((message) => message.type === "state"),
    true,
  );
  assert.equal(report.attach.response.ok, true);
  assert.equal(report.attach.response.op, "attach");
  assert.match(
    report.attach.streamText,
    /tfx fake native worker (online|heartbeat)/,
  );
  assert.deepEqual(report.resize, { ok: true, op: "resize" });
  assert.deepEqual(report.kill, { ok: true, op: "kill" });
  assert.equal(
    report.fakeWorkerEvents.some((event) => event.frame?.t === "resize"),
    true,
  );
  assert.equal(
    report.fakeWorkerEvents.some((event) => event.frame?.t === "kill"),
    true,
  );
});
