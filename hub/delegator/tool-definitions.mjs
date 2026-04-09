import { readFileSync } from "node:fs";

import { DELEGATOR_SCHEMA_URL } from "./contracts.mjs";

let schemaBundleCache = null;

function deepClone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function loadDelegatorSchemaBundle() {
  if (schemaBundleCache) {
    return schemaBundleCache;
  }

  schemaBundleCache = JSON.parse(readFileSync(DELEGATOR_SCHEMA_URL, "utf8"));
  return schemaBundleCache;
}

export function getDelegatorMcpToolDefinitions() {
  const bundle = loadDelegatorSchemaBundle();
  const defs = bundle.$defs || {};
  const tools = Array.isArray(bundle["x-triflux-mcp-tools"])
    ? bundle["x-triflux-mcp-tools"]
    : [];

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: deepClone(defs[tool.inputSchemaDef]),
    outputSchema: deepClone(defs[tool.outputSchemaDef]),
    pipeAction: tool.pipeAction,
  }));
}
