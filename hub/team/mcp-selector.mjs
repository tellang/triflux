export const MCP_CATALOG = Object.freeze([
  Object.freeze({
    name: "filesystem",
    purpose: "Read and write workspace files",
    taskTypes: Object.freeze(["implement", "review", "qa", "ship"]),
    cli: Object.freeze(["codex", "gemini"]),
  }),
  Object.freeze({
    name: "github",
    purpose: "Inspect PRs, issues, and release state",
    taskTypes: Object.freeze(["review", "ship"]),
    cli: Object.freeze(["codex"]),
  }),
  Object.freeze({
    name: "browser",
    purpose: "Research web pages and verify browser flows",
    taskTypes: Object.freeze(["research", "qa"]),
    cli: Object.freeze(["codex", "gemini"]),
  }),
  Object.freeze({
    name: "context7",
    purpose: "Fetch current SDK and API documentation",
    taskTypes: Object.freeze(["implement", "review", "research"]),
    cli: Object.freeze(["codex", "gemini"]),
  }),
  Object.freeze({
    name: "exa",
    purpose: "Search code examples and repositories",
    taskTypes: Object.freeze(["research", "review"]),
    cli: Object.freeze(["codex", "gemini"]),
  }),
  Object.freeze({
    name: "tavily",
    purpose: "Verify current external facts and search results",
    taskTypes: Object.freeze(["research", "qa"]),
    cli: Object.freeze(["gemini"]),
  }),
  Object.freeze({
    name: "sequential-thinking",
    purpose: "Structured reasoning for audits and review",
    taskTypes: Object.freeze(["review"]),
    cli: Object.freeze(["codex"]),
  }),
  Object.freeze({
    name: "tfx-hub",
    purpose: "Coordinate triflux hub, multi-agent, and swarm work",
    taskTypes: Object.freeze(["ship", "multi", "swarm"]),
    cli: Object.freeze(["codex", "gemini"]),
  }),
]);
