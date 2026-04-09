// tests/unit/swarm-planner.test.mjs — swarm-planner 유닛 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFileLeaseMap,
  buildMcpManifest,
  computeMergeOrder,
  parseShards,
  planSwarm,
} from "../../hub/team/swarm-planner.mjs";

const SAMPLE_PRD = `
# Swarm Test PRD

## Shard: api-routes
- agent: codex
- files: src/routes/api.mjs, src/routes/health.mjs
- mcp: context7
- depends:
- critical: true
- prompt: |
    Implement REST API routes for /api/v1 endpoints.
    Include health check at /health.

## Shard: auth-middleware
- agent: gemini
- files: src/middleware/auth.mjs
- mcp: tavily
- depends: api-routes
- critical: false
- prompt: Add JWT authentication middleware.

## Shard: database-layer
- agent: codex
- files: src/db/schema.mjs, src/db/queries.mjs
- depends:
- prompt: Create database schema and query layer.
`;

describe("swarm-planner", () => {
  describe("parseShards", () => {
    it("parses all shards from PRD", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.equal(shards.length, 3);
    });

    it("extracts shard names correctly", () => {
      const shards = parseShards(SAMPLE_PRD);
      const names = shards.map((s) => s.name);
      assert.deepEqual(names, [
        "api-routes",
        "auth-middleware",
        "database-layer",
      ]);
    });

    it("parses agent field", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.equal(shards[0].agent, "codex");
      assert.equal(shards[1].agent, "gemini");
    });

    it("parses files as array", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.deepEqual(shards[0].files, [
        "src/routes/api.mjs",
        "src/routes/health.mjs",
      ]);
      assert.deepEqual(shards[1].files, ["src/middleware/auth.mjs"]);
    });

    it("parses MCP servers", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.deepEqual(shards[0].mcp, ["context7"]);
      assert.deepEqual(shards[1].mcp, ["tavily"]);
    });

    it("parses dependencies", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.deepEqual(shards[0].depends, []);
      assert.deepEqual(shards[1].depends, ["api-routes"]);
    });

    it("parses critical flag", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.equal(shards[0].critical, true);
      assert.equal(shards[1].critical, false);
    });

    it("parses multi-line prompt", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.ok(shards[0].prompt.includes("REST API routes"));
      assert.ok(shards[0].prompt.includes("health check"));
    });

    it("parses single-line prompt", () => {
      const shards = parseShards(SAMPLE_PRD);
      assert.equal(shards[1].prompt, "Add JWT authentication middleware.");
    });

    it("returns empty array for empty content", () => {
      const shards = parseShards("# No shards here");
      assert.equal(shards.length, 0);
    });

    it("applies defaults for missing fields", () => {
      const shards = parseShards("## Shard: minimal\n- prompt: do stuff");
      assert.equal(shards.length, 1);
      assert.equal(shards[0].agent, "codex");
      assert.deepEqual(shards[0].files, []);
      assert.deepEqual(shards[0].mcp, []);
      assert.equal(shards[0].critical, false);
    });
  });

  describe("buildFileLeaseMap", () => {
    it("maps shard names to their files", () => {
      const shards = parseShards(SAMPLE_PRD);
      const { leaseMap } = buildFileLeaseMap(shards);

      assert.deepEqual(leaseMap.get("api-routes"), [
        "src/routes/api.mjs",
        "src/routes/health.mjs",
      ]);
      assert.deepEqual(leaseMap.get("auth-middleware"), [
        "src/middleware/auth.mjs",
      ]);
    });

    it("detects file conflicts across shards", () => {
      const shards = [
        { name: "a", files: ["shared.mjs"] },
        { name: "b", files: ["shared.mjs"] },
      ];
      const { conflicts } = buildFileLeaseMap(shards);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].file, "shared.mjs");
      assert.deepEqual(conflicts[0].shards, ["a", "b"]);
    });

    it("returns no conflicts when files are disjoint", () => {
      const shards = parseShards(SAMPLE_PRD);
      const { conflicts } = buildFileLeaseMap(shards);
      assert.equal(conflicts.length, 0);
    });
  });

  describe("buildMcpManifest", () => {
    it("maps shard names to MCP servers", () => {
      const shards = parseShards(SAMPLE_PRD);
      const manifest = buildMcpManifest(shards);

      assert.deepEqual(manifest.get("api-routes"), ["context7"]);
      assert.deepEqual(manifest.get("database-layer"), []);
    });
  });

  describe("computeMergeOrder", () => {
    it("produces valid topological order", () => {
      const shards = parseShards(SAMPLE_PRD);
      const { order, cycles } = computeMergeOrder(shards);

      assert.equal(cycles.length, 0);
      assert.equal(order.length, 3);

      // api-routes must come before auth-middleware
      const apiIdx = order.indexOf("api-routes");
      const authIdx = order.indexOf("auth-middleware");
      assert.ok(apiIdx < authIdx, "api-routes should precede auth-middleware");
    });

    it("detects dependency cycles", () => {
      const shards = [
        { name: "a", depends: ["b"], files: [], mcp: [] },
        { name: "b", depends: ["a"], files: [], mcp: [] },
      ];
      const { cycles } = computeMergeOrder(shards);
      assert.ok(cycles.length > 0);
    });

    it("handles shards with no dependencies", () => {
      const shards = [
        { name: "x", depends: [], files: [], mcp: [] },
        { name: "y", depends: [], files: [], mcp: [] },
      ];
      const { order, cycles } = computeMergeOrder(shards);
      assert.equal(cycles.length, 0);
      assert.equal(order.length, 2);
    });
  });

  describe("planSwarm", () => {
    it("produces a complete plan from PRD content", () => {
      const plan = planSwarm(null, { content: SAMPLE_PRD });

      assert.equal(plan.shards.length, 3);
      assert.ok(plan.leaseMap instanceof Map);
      assert.ok(plan.mcpManifest instanceof Map);
      assert.equal(plan.mergeOrder.length, 3);
      assert.deepEqual(plan.criticalShards, ["api-routes"]);
      assert.equal(plan.conflicts.length, 0);
    });

    it("throws on empty PRD", () => {
      assert.throws(
        () => planSwarm(null, { content: "# Empty" }),
        /No shards found/,
      );
    });

    it("throws on dependency cycles", () => {
      const cyclicPrd = `
## Shard: a
- depends: b
- prompt: do a

## Shard: b
- depends: a
- prompt: do b
`;
      assert.throws(() => planSwarm(null, { content: cyclicPrd }), /cycle/i);
    });
  });
});
