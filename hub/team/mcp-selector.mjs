const TASK_TYPES = Object.freeze([
  "implement",
  "review",
  "research",
  "qa",
  "ship",
  "multi",
  "swarm",
]);

const CLI_TYPES = Object.freeze(["codex", "gemini"]);

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

function uniqueStrings(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function assertOneOf(label, value, allowed) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

export function selectMcpServers(opts = {}) {
  const taskType = String(opts.taskType ?? "").trim();
  const cli = String(opts.cli ?? "").trim();
  assertOneOf("taskType", taskType, TASK_TYPES);
  assertOneOf("cli", cli, CLI_TYPES);

  const allCatalogNames = MCP_CATALOG.map((server) => server.name);
  const available = new Set(
    uniqueStrings(opts.available?.length ? opts.available : allCatalogNames),
  );
  const exclude = new Set(uniqueStrings(opts.exclude));
  const force = uniqueStrings(opts.force);

  const taskMatched = MCP_CATALOG.filter((server) =>
    server.taskTypes.includes(taskType),
  );
  const compatible = taskMatched.filter((server) => server.cli.includes(cli));
  const incompatible = taskMatched.filter(
    (server) => !server.cli.includes(cli),
  );

  const selected = uniqueStrings([
    ...compatible
      .map((server) => server.name)
      .filter((name) => available.has(name) && !exclude.has(name)),
    ...force.filter((name) => available.has(name) && !exclude.has(name)),
  ]);

  const reasonParts = [
    `task=${taskType}`,
    `cli=${cli}`,
    `selected=${selected.length ? selected.join(", ") : "none"}`,
  ];
  if (incompatible.length) {
    reasonParts.push(
      `cli-filtered=${incompatible.map((server) => server.name).join(", ")}`,
    );
  }
  if (force.length) reasonParts.push(`forced=${force.join(", ")}`);
  if (exclude.size) reasonParts.push(`excluded=${[...exclude].join(", ")}`);
  if (opts.available?.length) {
    reasonParts.push(`available=${[...available].join(", ")}`);
  }

  return {
    selected,
    reason: reasonParts.join(" | "),
  };
}

export function buildMcpArgs(servers = [], cli) {
  const resolvedCli = String(cli ?? "").trim();
  assertOneOf("cli", resolvedCli, CLI_TYPES);

  const selected = uniqueStrings(servers);
  if (!selected.length) return [];

  if (resolvedCli === "codex") {
    return selected.flatMap((server) => [
      "-c",
      `mcp_servers.${server}.enabled=true`,
    ]);
  }

  return ["--allowed-mcp-server-names", ...selected];
}
