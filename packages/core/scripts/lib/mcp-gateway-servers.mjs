const SERVER_DEFINITIONS = Object.freeze([
  {
    name: "context7",
    port: 8100,
    stdioCmd: "npx -y @upstash/context7-mcp@latest",
    envVars: [],
  },
  {
    name: "brave-search",
    port: 8101,
    stdioCmd: "npx -y @brave/brave-search-mcp-server",
    envVars: ["BRAVE_API_KEY"],
  },
  {
    name: "exa",
    port: 8102,
    stdioCmd: "npx -y exa-mcp-server",
    envVars: ["EXA_API_KEY"],
  },
  {
    name: "tavily",
    port: 8103,
    stdioCmd: "npx -y tavily-mcp@latest",
    envVars: ["TAVILY_API_KEY"],
  },
  {
    name: "jira",
    port: 8104,
    stdioCmd: "npx -y mcp-jira-cloud@latest",
    envVars: ["JIRA_API_TOKEN", "JIRA_EMAIL", "JIRA_INSTANCE_URL"],
  },
  {
    name: "serena",
    port: 8105,
    stdioCmd:
      "uvx --from git+https://github.com/oraios/serena serena start-mcp-server",
    envVars: [],
  },
  {
    name: "notion",
    port: 8106,
    stdioCmd: "npx -y @notionhq/notion-mcp-server",
    envVars: ["NOTION_TOKEN"],
  },
  {
    name: "notion-guest",
    port: 8107,
    stdioCmd: "npx -y @notionhq/notion-mcp-server",
    envVars: ["NOTION_TOKEN"],
  },
]);

export const SERVERS = SERVER_DEFINITIONS.map((server) => ({
  name: server.name,
  port: server.port,
  cmd: server.stdioCmd,
  envVars: [...server.envVars],
}));

export const GATEWAY_SERVERS = SERVER_DEFINITIONS.map((server) => ({
  name: server.name,
  port: server.port,
  stdioCmd: server.stdioCmd,
}));

export function serversWithSatisfiedEnv(env = process.env) {
  return SERVERS.filter((server) =>
    server.envVars.every((envName) => Boolean(env[envName])),
  );
}
