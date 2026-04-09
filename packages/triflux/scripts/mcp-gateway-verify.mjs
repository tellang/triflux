#!/usr/bin/env node
// mcp-gateway-verify.mjs — supergateway SSE 엔드포인트 헬스체크

import { readManifest } from "./lib/mcp-manifest.mjs";

const ALL_ENDPOINTS = [
  { name: "context7", port: 8100 },
  { name: "brave-search", port: 8101 },
  { name: "exa", port: 8102 },
  { name: "tavily", port: 8103 },
  { name: "jira", port: 8104 },
  { name: "serena", port: 8105 },
  { name: "notion", port: 8106 },
  { name: "notion-guest", port: 8107 },
];

const manifest = readManifest();
if (!manifest) {
  console.log("gateway: not configured (no manifest)");
  process.exit(0);
}
const enabled = new Set(manifest.enabled || []);
const ENDPOINTS = ALL_ENDPOINTS.filter((e) => enabled.has(e.name));
if (ENDPOINTS.length === 0) {
  console.log("gateway: no enabled servers");
  process.exit(0);
}

async function checkHealth(name, port) {
  const start = Date.now();
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - start;
    return res.ok
      ? { name, port, status: "ok", latencyMs, error: null }
      : { name, port, status: "down", latencyMs, error: `HTTP ${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err?.cause?.code || err?.message || "unknown";
    return { name, port, status: "down", latencyMs, error: message };
  }
}

async function main() {
  const results = await Promise.allSettled(
    ENDPOINTS.map(({ name, port }) => checkHealth(name, port)),
  );

  const entries = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { name: "?", port: 0, status: "down", error: r.reason },
  );

  console.log("\nMCP Gateway Health Check");
  console.log("=".repeat(56));

  let downCount = 0;
  for (const e of entries) {
    const mark = e.status === "ok" ? "\u2713" : "\u2717";
    const detail = e.status === "ok" ? `(${e.latencyMs}ms)` : `(${e.error})`;
    const line = `  ${e.name.padEnd(16)} :${String(e.port).padEnd(6)} ${mark} ${e.status.padEnd(6)} ${detail}`;
    console.log(line);
    if (e.status !== "ok") downCount++;
  }

  console.log("=".repeat(56));
  console.log(
    downCount === 0
      ? `All ${entries.length} gateways healthy`
      : `${downCount}/${entries.length} gateways down`,
  );

  process.exitCode = downCount > 0 ? 1 : 0;
}

main();
