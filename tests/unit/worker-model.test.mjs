import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const home = mkdtempSync(join(tmpdir(), "worker-model-"));
after(() => rmSync(home, { recursive: true, force: true }));
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  TMPDIR: home,
  TFX_JEV: "0",
};

test("worker-model CLI는 세션과 설정을 만들지 않고 역할 기본값을 반환한다", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "bin/triflux.mjs"),
      "judge",
      "worker-model",
      "--task",
      "작업 요약",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const selected = JSON.parse(result.stdout);
  assert.equal(selected.family, "sol");
  assert.ok(selected.model);
  assert.equal(selected.effort, "high");
  assert.equal(selected.source, "rule");
  assert.equal(selected.fallbackReason, "jev_disabled");
  // CLI가 import할 때 만드는 빈 private tmp 디렉터리 이외의 설정과 세션은 없다.
  assert.deepEqual(
    readdirSync(home, { recursive: true }).filter(
      (name) => !String(name).startsWith("triflux-"),
    ),
    [],
  );
});

test("worker-model CLI는 잘못된 옵션과 누락된 값을 거절한다", () => {
  for (const args of [
    ["--cli", "unknown"],
    ["--agent", "unknown"],
    ["--typo", "codex"],
    ["--agent"],
    ["--task", "--cli", "codex"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        join(root, "bin/triflux.mjs"),
        "judge",
        "worker-model",
        "--task",
        "task",
        ...args,
      ],
      { env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, result.stdout);
  }
});

test("역할 등급 조정과 명시 입력은 조회와 실행에서 같은 정책을 따른다", async () => {
  const { resolveWorkerModel } = await import(
    "../../scripts/lib/agent-route-policy.mjs"
  );
  assert.equal(typeof resolveWorkerModel, "function");
  const options = {
    env,
    home,
    routing: {
      tierShift: "lower",
      modelDecision: { confidence: 0.9, reason: "accepted" },
    },
  };
  const lowered = await resolveWorkerModel(
    { task: "작업", agent: "debugger" },
    options,
  );
  assert.equal(lowered.profile, "sol_high");
  assert.equal(lowered.source, "jev");
  const security = await resolveWorkerModel(
    { task: "작업", agent: "security-reviewer" },
    options,
  );
  assert.equal(security.profile, "astra_xhigh");
  assert.equal(security.source, "rule");
  for (const explicit of [{ model: "custom-model" }, { effort: "low" }]) {
    const selected = await resolveWorkerModel(
      { task: "작업", ...explicit },
      options,
    );
    assert.equal(selected.source, "explicit");
    assert.equal(selected.model, explicit.model ?? null);
    assert.equal(selected.effort, explicit.effort ?? null);
  }
  const nested = await resolveWorkerModel(
    { task: "작업", agent: "deep-executor", profile: "ultra", nested: true },
    options,
  );
  assert.equal(nested.profile, "astra_max");
  assert.equal(nested.effort, "max");
});

test("Jev 0.85 경계와 오류는 역할 기본값과 폴백 이유를 보존한다", async () => {
  const { resolveWorkerModel } = await import(
    "../../scripts/lib/agent-route-policy.mjs"
  );
  const options = (confidence) => ({
    env: { ...env, TFX_JEV: "1" },
    home,
    batchClient: async () => ({
      complexity: { choice: "deep", confidence: 0.99 },
      execution_mode: { choice: "workspace_auto", confidence: 0.99 },
      mcp_profile: { choice: "none", confidence: 0.99 },
      tier_shift: { choice: "lower", confidence },
    }),
  });
  const low = await resolveWorkerModel(
    { task: "원 작업", agent: "debugger" },
    options(0.849),
  );
  assert.equal(low.profile, "astra_xhigh");
  assert.equal(low.confidence, 0.849);
  assert.equal(low.fallbackReason, "low_confidence");
  const high = await resolveWorkerModel(
    { task: "원 작업", agent: "debugger" },
    options(0.85),
  );
  assert.equal(high.profile, "sol_high");
  const error = await resolveWorkerModel(
    { task: "원 작업" },
    {
      ...options(1),
      batchClient: async () => {
        throw new Error("offline");
      },
    },
  );
  assert.equal(error.profile, "sol_high");
  assert.equal(error.source, "rule");
  assert.ok(error.fallbackReason);
});

test("Claude 직접 워커는 같은 정책을 쓰고 route 워커는 부모에서 조회하지 않는다", async () => {
  const { prepareHeadlessWorkerModel, buildHeadlessCommand } = await import(
    "../../hub/team/headless.mjs"
  );
  const options = {
    env: { ...env, TFX_JEV: "1" },
    home,
    batchClient: async ({ state }) => {
      assert.ok(state.includes("원 작업"));
      assert.ok(!state.includes("prior_context"));
      return { complexity: { choice: "deep", confidence: 0.9 } };
    },
  };
  const selected = await prepareHeadlessWorkerModel(
    { cli: "claude", prompt: "원 작업" },
    options,
  );
  assert.equal(selected.model, "opus");
  assert.equal(selected.effort, "high");
  const command = buildHeadlessCommand(
    "claude",
    "원 작업",
    join(home, "claude-result"),
    { workerModel: selected },
  );
  assert.match(command, /--model 'opus' --effort 'high'/);
  assert.equal(
    await prepareHeadlessWorkerModel(
      { cli: "codex", prompt: "원 작업" },
      options,
    ),
    null,
  );
  assert.equal(
    await prepareHeadlessWorkerModel(
      { cli: "claude", role: "code-reviewer", prompt: "원 작업" },
      options,
    ),
    null,
  );
});

test("리뷰와 retry 정책을 자동 추천으로 덮어쓰지 않는다", async () => {
  const { resolveWorkerModel } = await import(
    "../../scripts/lib/agent-route-policy.mjs"
  );
  const options = {
    env,
    home,
    routing: {
      tierShift: "lower",
      codexProfile: "luna_low",
      modelDecision: { confidence: 0.99, reason: "accepted" },
    },
  };
  const review = await resolveWorkerModel(
    { task: "검토", agent: "code-reviewer" },
    options,
  );
  assert.equal(review.profile, "sol_high");
  assert.equal(review.source, "review");
  const retry = await resolveWorkerModel(
    { task: "재시도", protectedPolicy: "retry", profile: "astra_max" },
    options,
  );
  assert.equal(retry.profile, "astra_max");
  assert.equal(retry.source, "retry");
});

test("배정은 워커별 명시 model/effort와 공통 입력을 보존한다", async () => {
  const { buildHeadlessAssignments } = await import(
    "../../hub/team/cli/commands/start/start-headless.mjs"
  );
  const { parseTeamArgs } = await import(
    "../../hub/team/cli/commands/start/parse-args.mjs"
  );
  const parsed = parseTeamArgs([
    "--teammate-mode",
    "headless",
    "--effort",
    "high",
    "task",
  ]);
  assert.equal(parsed.effort, "high");
  const assignments = buildHeadlessAssignments({
    assigns: [
      { cli: "codex", prompt: "a", model: "worker-model", effort: "low" },
      { cli: "codex", prompt: "b" },
    ],
    model: "common-model",
    effort: "high",
  });
  assert.deepEqual(
    assignments.map(({ model, effort }) => ({ model, effort })),
    [
      { model: "worker-model", effort: "low" },
      { model: "common-model", effort: "high" },
    ],
  );
});

test("명시 ultra는 CLI와 역할, 중첩 제한을 따른다", async () => {
  const { resolveWorkerModel } = await import(
    "../../scripts/lib/agent-route-policy.mjs"
  );
  for (const [cli, agent, nested, expected] of [
    ["codex", "executor", false, "max"],
    ["codex", "deep-executor", false, "ultra"],
    ["codex", "scientist-deep", false, "ultra"],
    ["codex", "deep-executor", true, "max"],
    ["claude", "deep-executor", false, "max"],
  ]) {
    const result = await resolveWorkerModel(
      { cli, agent, nested, effort: "ultra" },
      { env },
    );
    assert.equal(result.effort, expected, `${cli}/${agent}/${nested}`);
    assert.equal(result.model, null);
  }
});

test("모델 판정 사유는 실제 threshold와 허용 선택지를 따른다", async () => {
  const { resolveWorkerModel } = await import(
    "../../scripts/lib/agent-route-policy.mjs"
  );
  for (const [choice, confidence, reason] of [
    ["deep", 0.9, "low_confidence"],
    ["outside-options", 0.99, "invalid_response"],
  ]) {
    const result = await resolveWorkerModel(
      { task: "원 작업" },
      {
        env: { ...env, TFX_JEV: "1" },
        minConfidence: 0.95,
        batchClient: async () => ({ complexity: { choice, confidence } }),
      },
    );
    assert.equal(result.profile, "sol_high");
    assert.equal(
      result.confidence,
      reason === "invalid_response" ? null : confidence,
    );
    assert.equal(result.fallbackReason, reason);
  }
});

test("worker-model은 --로 시작하는 task와 headless 전역 max 예외를 보존한다", () => {
  for (const profile of ["max", "ultra"]) {
    const result = spawnSync(
      process.execPath,
      [
        join(root, "bin/triflux.mjs"),
        "judge",
        "worker-model",
        "--task",
        "---\nfront matter",
      ],
      {
        env: { ...env, TFX_CODEX_PROFILE: profile },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const selected = JSON.parse(result.stdout);
    assert.equal(selected.profile, "astra_max");
    assert.equal(selected.effort, "max");
    assert.equal(selected.source, "explicit");
  }
});
