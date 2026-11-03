import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeMcpRecommendation } from "../../hub/lib/jev-addon.mjs";
import {
  formatMcpRecommendation,
  recommendMcp,
} from "../../hub/lib/mcp-recommendations.mjs";
import { refreshMcpCatalog } from "../../scripts/lib/mcp-recommendation-catalog.mjs";

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "tfx-mcp-quality-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = {
    home,
    env: {
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, "cache"),
      TFX_JEV: "0",
    },
  };
  await refreshMcpCatalog({
    ...options,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        servers: [
          "PostgreSQL",
          "Playwright browser",
          "documentation reference",
          "unrelated metaone metatwo metathree",
        ].flatMap((description, group) =>
          Array.from({ length: 20 }, (_, i) => ({
            server: {
              name: `io.example/group${group}-${i}`,
              version: "1.0.0",
              description,
              remotes: [
                {
                  type: "streamable-http",
                  url: `https://group${group}-${i}.example/mcp`,
                },
              ],
            },
          })),
        ),
        metadata: {},
      }),
    }),
  });
  return options;
}

async function captureCandidates(f, task, extra = {}) {
  let state;
  await recommendMcp(
    { cliType: "codex", cwd: f.home, task, ...extra },
    {
      ...f,
      jevOptions: {
        env: { TFX_JEV_STATS: "0" },
        batchClient: async (request) => {
          state = JSON.parse(request.state);
          return {};
        },
      },
    },
  );
  return state.candidates;
}

test("Original tasks retrieve distinct public candidates without package.json or manual search", async (t) => {
  const f = await fixture(t);
  const db = await captureCandidates(f, "PostgreSQL 스키마를 조회한다");
  const browser = await captureCandidates(
    f,
    "Playwright browser 화면을 확인한다",
  );
  for (const [candidates, expected, excluded] of [
    [db, "group0", "group1"],
    [browser, "group1", "group0"],
  ]) {
    assert.ok(candidates.length <= 12);
    assert.ok(candidates.some((c) => c.id.includes(expected)));
    assert.ok(!candidates.some((c) => c.id.includes(excluded)));
  }
});

test("Task vocabulary outranks auxiliary metadata and does not match word fragments", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.home, "package.json"),
    JSON.stringify({ keywords: ["metaone", "metatwo", "metathree"] }),
  );
  const candidates = await captureCandidates(
    f,
    "이 PostgreSQL 스키마를 조회한다",
    { searchTerms: ["unrelated"] },
  );
  assert.ok(candidates[0].id.includes("group0"));
  const fragments = await captureCandidates(f, "Postgre", { searchTerms: [] });
  assert.ok(!fragments.some((c) => c.id.includes("group0")));
});

test("Public discovery retains local defaults and installed candidates in a bounded pool", async (t) => {
  const f = await fixture(t);
  mkdirSync(f.env.CODEX_HOME, { recursive: true });
  writeFileSync(
    join(f.env.CODEX_HOME, "config.toml"),
    '[mcp_servers.alias]\nurl="https://group3-0.example/mcp"\n',
  );
  const candidates = await captureCandidates(f, "documentation reference");
  assert.equal(candidates.length, 12);
  assert.ok(candidates.some((c) => c.id === "local:context7"));
  assert.ok(
    candidates.some(
      (c) => c.id.startsWith("official:") && c.installationStatus !== "present",
    ),
  );
  assert.ok(candidates.some((c) => c.installationStatus === "present"));
});

test("No lexical signal uses limited defaults and diagnoses the retrieval limit", async (t) => {
  const f = await fixture(t);
  let state;
  const result = await recommendMcp(
    { cliType: "codex", cwd: f.home, task: "없는어휘만요청" },
    {
      ...f,
      jevOptions: {
        env: { TFX_JEV_STATS: "0" },
        batchClient: async (request) => {
          state = JSON.parse(request.state);
          return {};
        },
      },
    },
  );
  assert.ok(state.candidates.length <= 6);
  assert.ok(state.candidates.every((c) => c.id.startsWith("local:")));
  assert.ok(result.diagnostics.includes("search_no_matches"));
});

test("Independent noul judgments accept useful candidates and keep the confidence threshold", async () => {
  const candidates = ["first", "useful", "uncertain"].map((id) => ({ id }));
  let calls = 0;
  const decision = await judgeMcpRecommendation(
    { cli: "codex", task: "browser", project: {}, candidates },
    {
      env: { TFX_JEV_STATS: "0" },
      batchClient: async ({ questions }) => {
        calls++;
        return Object.fromEntries(
          Object.entries(questions).map(([key, question], i) => {
            assert.equal(question.kind, "noul");
            return [key, { noul: [0.05, 0.74, 0.54][i] }];
          }),
        );
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(decision.id, "useful");
  assert.equal(decision.confidence, 0.74);
});

for (const [probabilities, reason] of [
  [[0.1, 0.2], "jev_no_recommendation"],
  [[0.69, 0.54], "low_confidence"],
  [[0.95, null], "batch_partial_response"],
  [[null, null], "batch_invalid_response"],
]) {
  test(`Independent noul ${reason} never forces a recommendation`, async () => {
    const decision = await judgeMcpRecommendation(
      {
        cli: "codex",
        task: "task",
        project: {},
        candidates: [{ id: "a" }, { id: "b" }],
      },
      {
        env: { TFX_JEV_STATS: "0" },
        batchClient: async ({ questions }) =>
          Object.fromEntries(
            Object.keys(questions).map((key, i) => [
              key,
              { noul: probabilities[i] },
            ]),
          ),
      },
    );
    assert.equal(decision.id, undefined);
    assert.deepEqual(decision.diagnostics, [reason]);
  });
}

test("Highest confident positive wins while a threshold-boundary answer remains eligible", async () => {
  for (const [probabilities, expected] of [
    [[0.7, 0.1], "a"],
    [[0.74, 0.94], "b"],
  ]) {
    const decision = await judgeMcpRecommendation(
      {
        cli: "codex",
        task: "task",
        project: {},
        candidates: [{ id: "a" }, { id: "b" }],
      },
      {
        env: { TFX_JEV_STATS: "0" },
        batchClient: async ({ questions }) =>
          Object.fromEntries(
            Object.keys(questions).map((key, i) => [
              key,
              { noul: probabilities[i] },
            ]),
          ),
      },
    );
    assert.equal(decision.id, expected);
  }
});

test("Present recommendations need no installation approval in result or prompt", async (t) => {
  const f = await fixture(t);
  mkdirSync(f.env.CODEX_HOME, { recursive: true });
  writeFileSync(
    join(f.env.CODEX_HOME, "config.toml"),
    '[mcp_servers.docs]\nurl="https://mcp.context7.com/mcp"\n',
  );
  const result = await recommendMcp(
    { cliType: "codex", cwd: f.home, task: "documentation" },
    {
      ...f,
      jevOptions: {
        env: { TFX_JEV_STATS: "0" },
        batchClient: async ({ state, questions }) => {
          const candidates = JSON.parse(state).candidates;
          return Object.fromEntries(
            Object.keys(questions).map((key, i) => [
              key,
              { noul: candidates[i].id === "local:context7" ? 0.95 : 0.05 },
            ]),
          );
        },
      },
    },
  );
  assert.equal(result.status, "recommended");
  assert.equal(result.recommendations[0].requiresApproval, false);
  assert.equal(result.applied, false);
  const prompt = formatMcpRecommendation(result);
  assert.match(prompt, /"requiresApproval":false/);
  assert.match(prompt, /"applied":false/);
});
