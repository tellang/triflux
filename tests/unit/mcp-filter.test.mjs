import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMcpPolicy,
  getCodexConfigOverrides,
  resolveMcpProfile,
  resolveSearchToolOrder,
} from "../../scripts/lib/mcp-filter.mjs";

describe("mcp-filter", () => {
  it("auto 프로필은 역할에 따라 role profile로 해석된다", () => {
    assert.equal(resolveMcpProfile("executor", "auto"), "executor");
    assert.equal(resolveMcpProfile("designer", "auto"), "designer");
    assert.equal(resolveMcpProfile("explore", "auto"), "explore");
    assert.equal(resolveMcpProfile("code-reviewer", "auto"), "reviewer");
    assert.equal(resolveMcpProfile("writer", "auto"), "writer");
    assert.equal(resolveMcpProfile("spark", "auto"), "default");
  });

  it("legacy 프로필 별칭은 새 role profile로 정규화된다", () => {
    assert.equal(resolveMcpProfile("executor", "implement"), "executor");
    assert.equal(resolveMcpProfile("analyst", "analyze"), "analyze");
    assert.equal(resolveMcpProfile("code-reviewer", "review"), "reviewer");
    assert.equal(resolveMcpProfile("writer", "docs"), "writer");
    assert.equal(resolveMcpProfile("spark", "minimal"), "default");
  });

  it("explore 프로필은 읽기/검색 계열 서버만 허용하고 playwright는 제외한다", () => {
    const policy = buildMcpPolicy({
      agentType: "explore",
      requestedProfile: "explore",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "playwright",
        "sequential-thinking",
      ],
      workerIndex: 2,
    });

    assert.deepEqual(policy.allowedServers, [
      "context7",
      "brave-search",
      "tavily",
      "exa",
    ]);
    assert.match(policy.hint, /웹 검색 우선순위: tavily, exa, brave-search\./);
    assert.match(
      policy.hint,
      /검색 깊이를 제한하고 읽기 전용 조사에 집중하세요/,
    );
  });

  it("executor 프로필은 코드 구현 문맥에서 context7 + exa로 축소된다", () => {
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "auto",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "playwright",
      ],
      taskText:
        "Implement CLI parser, fix failing unit test, and check the package API docs.",
    });

    assert.deepEqual(policy.allowedServers, ["context7", "exa"]);
    assert.deepStrictEqual(policy.codexConfig.mcp_servers.playwright, { enabled: false });
    assert.deepStrictEqual(policy.codexConfig.mcp_servers.tavily, { enabled: false });
  });

  it("designer 프로필은 브라우저/UI 문맥에서 playwright를 남기고 일반 검색 서버를 줄인다", () => {
    const policy = buildMcpPolicy({
      agentType: "designer",
      requestedProfile: "auto",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "playwright",
      ],
      taskText:
        "Capture a browser screenshot and inspect responsive UI layout regression.",
    });

    assert.deepEqual(policy.allowedServers, ["context7", "playwright"]);
    assert.match(policy.hint, /playwright를 우선 사용하세요/);
  });

  it("reviewer 프로필은 분석용 도구와 문서 조회만 남긴다", () => {
    const policy = buildMcpPolicy({
      agentType: "code-reviewer",
      requestedProfile: "reviewer",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "sequential-thinking",
        "playwright",
      ],
    });

    assert.deepEqual(policy.geminiAllowedServers, [
      "context7",
      "brave-search",
      "sequential-thinking",
    ]);
    assert.deepStrictEqual(policy.codexConfig.mcp_servers.playwright, { enabled: false });
    assert.deepEqual(
      policy.codexConfig.mcp_servers["sequential-thinking"].enabled_tools,
      ["sequentialthinking"],
    );
  });

  it("codex override 플래그는 비허용 서버를 disabled=false가 아닌 enabled=false로 차단한다", () => {
    const overrides = getCodexConfigOverrides({
      agentType: "writer",
      requestedProfile: "writer",
      availableServers: ["context7", "brave-search", "exa", "tavily"],
    });

    assert.ok(overrides.includes("mcp_servers.context7.enabled=true"));
    assert.ok(
      overrides.includes('mcp_servers.exa.enabled_tools=["web_search_exa"]'),
    );
    assert.ok(overrides.includes("mcp_servers.tavily.enabled=false"));
  });

  it("search server top-k 정렬은 inventory tool_count를 tie-break에 사용한다", () => {
    const ordered = resolveSearchToolOrder(
      "",
      undefined,
      ["brave-search", "exa"],
      "search and find the relevant result quickly.",
      {
        inventory: {
          codex: {
            servers: [
              { name: "brave-search", tool_count: 1, domain_tags: ["search"] },
              { name: "exa", tool_count: 7, domain_tags: ["search"] },
            ],
          },
        },
      },
    );

    assert.deepEqual(ordered, ["brave-search", "exa"]);
  });

  it("inventory domain_tags가 과도해도 executor 허용 서버를 불필요하게 넓히지 않아야 한다", () => {
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "auto",
      availableServers: [
        "context7",
        "brave-search",
        "exa",
        "tavily",
        "playwright",
      ],
      taskText:
        "Implement CLI parser, fix failing unit test, and check the package API docs.",
      inventory: {
        codex: {
          servers: [
            {
              name: "playwright",
              tool_count: 5,
              domain_tags: ["code", "docs", "library"],
            },
            { name: "tavily", tool_count: 2, domain_tags: ["code", "docs"] },
          ],
        },
      },
    });

    assert.deepEqual(policy.allowedServers, ["context7", "exa"]);
    assert.deepStrictEqual(policy.codexConfig.mcp_servers.playwright, { enabled: false });
    assert.deepStrictEqual(policy.codexConfig.mcp_servers.tavily, { enabled: false });
  });

  it("hint와 allowed server는 동일한 keyword top-k 결과를 재사용한다", () => {
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "executor",
      availableServers: ["context7", "brave-search", "exa", "tavily"],
      taskText:
        "Verify the latest pricing status and current release announcement.",
    });

    assert.deepEqual(policy.allowedServers, [
      "context7",
      "tavily",
      "brave-search",
    ]);
    assert.match(policy.hint, /웹 검색 우선순위: tavily, brave-search\./);
  });
});

describe("mcp-filter — phase-aware filtering (이슈 3)", () => {
  it("T3-01: plan phase는 playwright를 차단해야 한다", () => {
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "executor",
      availableServers: [
        "context7",
        "playwright",
        "brave-search",
        "exa",
        "tavily",
      ],
      phase: "plan",
    });
    assert.ok(
      !policy.allowedServers.includes("playwright"),
      "plan 단계에서 playwright 차단",
    );
    assert.ok(
      !policy.allowedServers.includes("tavily"),
      "plan 단계에서 tavily 차단",
    );
    assert.ok(!policy.allowedServers.includes("exa"), "plan 단계에서 exa 차단");
    assert.equal(policy.resolvedPhase, "plan");
  });

  it("T3-02: exec phase는 프로필 기반 전체 허용해야 한다", () => {
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "executor",
      availableServers: ["context7", "playwright", "brave-search", "exa"],
      phase: "exec",
    });
    // exec phase에는 blockedServers가 없으므로 프로필 기반 결과 그대로
    assert.ok(policy.allowedServers.length > 0);
    assert.equal(policy.resolvedPhase, "exec");
  });

  it("T3-03: verify phase는 playwright를 차단해야 한다", () => {
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "executor",
      availableServers: ["context7", "playwright", "brave-search", "exa"],
      phase: "verify",
    });
    assert.ok(
      !policy.allowedServers.includes("playwright"),
      "verify 단계에서 playwright 차단",
    );
    assert.equal(policy.resolvedPhase, "verify");
  });

  it("T3-04: phase 미지정 시 기존 동작 유지 (회귀 방지)", () => {
    const withPhase = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "executor",
      availableServers: ["context7", "brave-search"],
    });
    assert.equal(withPhase.resolvedPhase, null);
    assert.ok(withPhase.allowedServers.includes("context7"));
  });

  it("T3-05: prd phase는 brave-search를 허용하고 playwright를 차단해야 한다", () => {
    const policy = buildMcpPolicy({
      agentType: "analyst",
      requestedProfile: "analyze",
      availableServers: ["context7", "playwright", "brave-search", "exa"],
      phase: "prd",
    });
    assert.ok(
      !policy.allowedServers.includes("playwright"),
      "prd 단계에서 playwright 차단",
    );
    assert.equal(policy.resolvedPhase, "prd");
  });

  it("잘못된 MCP 프로필은 auto로 graceful fallback한다", () => {
    // --flag 형태는 auto로 폴백 (hard crash 방지)
    const policy = buildMcpPolicy({
      agentType: "executor",
      requestedProfile: "--cli",
    });
    assert.ok(policy, "auto 폴백으로 policy 반환");
  });

  it("--flag 형태 프로필은 auto로 폴백한다", () => {
    const result = resolveMcpProfile("executor", "--verbose");
    assert.ok(result, "auto 폴백으로 결과 반환");
  });

  it("알 수 없는 프로필도 auto로 폴백한다", () => {
    const result = resolveMcpProfile("executor", "nonexistent-profile");
    assert.ok(result, "auto 폴백으로 결과 반환");
  });
});
