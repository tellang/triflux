import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMcpArgs,
  selectMcpServers,
} from "../../hub/team/mcp-selector.mjs";

describe("selectMcpServers", () => {
  it("implement/codex는 구현용 서버를 고른다", () => {
    const result = selectMcpServers({ taskType: "implement", cli: "codex" });
    assert.deepEqual(result.selected, ["filesystem", "context7"]);
    assert.match(result.reason, /task=implement/);
  });

  it("review/codex는 리뷰 전용 서버를 포함한다", () => {
    const result = selectMcpServers({ taskType: "review", cli: "codex" });
    assert.deepEqual(result.selected, [
      "filesystem",
      "github",
      "context7",
      "exa",
      "sequential-thinking",
    ]);
  });

  it("review/gemini는 codex 전용 서버를 제외한다", () => {
    const result = selectMcpServers({ taskType: "review", cli: "gemini" });
    assert.deepEqual(result.selected, ["filesystem", "context7", "exa"]);
    assert.match(result.reason, /cli-filtered=github, sequential-thinking/);
  });

  it("research/gemini는 조사용 검색 및 브라우저 서버를 고른다", () => {
    const result = selectMcpServers({ taskType: "research", cli: "gemini" });
    assert.deepEqual(result.selected, ["browser", "context7", "exa", "tavily"]);
  });

  it("qa/gemini는 브라우저와 검증 서버를 고른다", () => {
    const result = selectMcpServers({ taskType: "qa", cli: "gemini" });
    assert.deepEqual(result.selected, ["filesystem", "browser", "tavily"]);
  });

  it("ship/codex는 배포 관련 서버를 고른다", () => {
    const result = selectMcpServers({ taskType: "ship", cli: "codex" });
    assert.deepEqual(result.selected, ["filesystem", "github", "tfx-hub"]);
  });

  it("multi/swarm은 허브 서버를 고른다", () => {
    assert.deepEqual(
      selectMcpServers({ taskType: "multi", cli: "codex" }).selected,
      ["tfx-hub"],
    );
    assert.deepEqual(
      selectMcpServers({ taskType: "swarm", cli: "gemini" }).selected,
      ["tfx-hub"],
    );
  });

  it("available 교차와 force/exclude를 함께 적용한다", () => {
    const result = selectMcpServers({
      taskType: "implement",
      cli: "gemini",
      available: ["filesystem", "github", "exa", "tfx-hub"],
      force: ["github", "tfx-hub"],
      exclude: ["filesystem"],
    });

    assert.deepEqual(result.selected, ["github", "tfx-hub"]);
    assert.match(result.reason, /forced=github, tfx-hub/);
    assert.match(result.reason, /excluded=filesystem/);
  });
});

describe("buildMcpArgs", () => {
  it("codex 인자 포맷으로 변환한다", () => {
    assert.deepEqual(buildMcpArgs(["filesystem", "context7"], "codex"), [
      "-c",
      "mcp_servers.filesystem.enabled=true",
      "-c",
      "mcp_servers.context7.enabled=true",
    ]);
  });

  it("gemini 인자 포맷으로 변환한다", () => {
    assert.deepEqual(buildMcpArgs(["browser", "tfx-hub"], "gemini"), [
      "--allowed-mcp-server-names",
      "browser",
      "tfx-hub",
    ]);
  });
});
