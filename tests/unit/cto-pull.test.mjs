import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readCtoSnapshot } from "../../hub/team/cto-pull.mjs";

function fixtureSnapshot() {
  return {
    schema_version: "cto-lake.v1",
    generated_at: "2026-06-02T00:00:00.000Z",
    repo: { root: "/repo", branch: "feat/cto-t6e", head: "abc123" },
    sources: { git: { available: true, status: "ok" } },
    ledger_tail: [{ event: "collect", summary: "fixture" }],
    live_sessions: [],
    active_shards: [],
  };
}

describe("cto pull helper", () => {
  let sandboxDir;
  let lakeRoot;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-cto-pull-"));
    lakeRoot = join(sandboxDir, ".triflux", "lake");
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("AGENTS.md points agents to the north-star brief and JSON status source", () => {
    const text = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");

    assert.match(text, /\.triflux\/lake\/current\.md/);
    assert.match(text, /tfx cto status --json/);
    assert.match(text, /schema_version/);
    assert.match(text, /active_shards/);
  });

  it("returns null without throwing when the lake is empty", () => {
    assert.doesNotThrow(() => readCtoSnapshot({ lakeRoot }));
    assert.equal(readCtoSnapshot({ lakeRoot }), null);
  });

  it("parses current.json from an injected lakeRoot", () => {
    const snapshot = fixtureSnapshot();
    mkdirSync(lakeRoot, { recursive: true });
    writeFileSync(
      join(lakeRoot, "current.json"),
      JSON.stringify(snapshot),
      "utf8",
    );

    assert.deepEqual(readCtoSnapshot({ lakeRoot }), snapshot);
  });
});
