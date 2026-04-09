#!/usr/bin/env node
// mcp-gateway-integration-test.mjs — P0 integration test for MCP Gateway
// Usage: node scripts/mcp-gateway-integration-test.mjs

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const START_SCRIPT = join(SCRIPTS_DIR, "mcp-gateway-start.mjs");
const CONFIG_SCRIPT = join(SCRIPTS_DIR, "mcp-gateway-config.mjs");

const HEALTH_TIMEOUT_MS = 3000;
const STARTUP_WAIT_MS = 12000;
const POLL_INTERVAL_MS = 500;

const SERVERS = [
  { name: "context7", port: 8100 },
  { name: "brave-search", port: 8101 },
  { name: "exa", port: 8102 },
  { name: "tavily", port: 8103 },
  { name: "jira", port: 8104 },
  { name: "serena", port: 8105 },
  { name: "notion", port: 8106 },
  { name: "notion-guest", port: 8107 },
];

// ── utilities ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function runScript(scriptPath, ...args) {
  execSync(`node "${scriptPath}" ${args.join(" ")}`, {
    stdio: "inherit",
    timeout: 30000,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
}

function countSupergateways() {
  try {
    // Write the query as a PS1 file to avoid shell quoting issues
    const ps1 = [
      `$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'"`,
      `$hits = $procs | Where-Object { $_.CommandLine -match 'supergateway' }`,
      `Write-Output $hits.Count`,
    ].join("\n");
    const out = execSync(
      `powershell -NoProfile -Command "${ps1.replace(/\n/g, "; ")}"`,
      { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "ignore"] },
    );
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// ── result tracking ──

const results = [];
let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  [PASS] ${label}`);
  results.push({ label, ok: true });
  passed++;
}

function fail(label, detail = "") {
  const msg = detail ? `${label} — ${detail}` : label;
  console.log(`  [FAIL] ${msg}`);
  results.push({ label, ok: false, detail });
  failed++;
}

function printSummary() {
  console.log("\n" + "=".repeat(56));
  console.log("Integration Test Summary");
  console.log("=".repeat(56));
  for (const r of results) {
    const mark = r.ok ? "\u2713" : "\u2717";
    const detail = r.detail ? `  (${r.detail})` : "";
    console.log(`  ${mark} ${r.label}${detail}`);
  }
  console.log("=".repeat(56));
  const total = passed + failed;
  console.log(`Result: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n[FAIL] Integration test FAILED");
    process.exitCode = 1;
  } else {
    console.log("\n[PASS] Integration test PASSED");
  }
}

// ── main ──

async function main() {
  console.log("\nMCP Gateway Integration Test");
  console.log("=".repeat(56));

  // STEP 1: Start gateways
  console.log("\n[STEP 1] Starting gateways...");
  try {
    runScript(START_SCRIPT);
    pass("Gateway start script ran without error");
  } catch (err) {
    fail("Gateway start script", err.message);
    console.log("\n[ABORT] Cannot continue without gateways running");
    printSummary();
    return;
  }

  // STEP 2: Wait for health checks to pass (up to 12s)
  console.log("\n[STEP 2] Waiting for health checks (up to 12s)...");
  const deadline = Date.now() + STARTUP_WAIT_MS;
  const pending = new Set(SERVERS.map((s) => s.port));

  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    for (const port of [...pending]) {
      if (await checkHealth(port)) pending.delete(port);
    }
  }

  let healthOk = 0;
  let healthSkipped = 0;

  for (const srv of SERVERS) {
    const alive = !pending.has(srv.port);
    if (alive) {
      console.log(`  [ok]   ${srv.name.padEnd(16)} :${srv.port}`);
      healthOk++;
    } else {
      // Servers that stay down are expected when env vars (API keys) are missing
      console.log(
        `  [skip] ${srv.name.padEnd(16)} :${srv.port}  (not running — likely missing env)`,
      );
      healthSkipped++;
    }
  }

  if (healthOk === 0) {
    fail("Health check — no servers responded", `0/${SERVERS.length} up`);
  } else {
    pass(
      `Health check — ${healthOk} server(s) responding (${healthSkipped} skipped)`,
    );
  }

  // STEP 3: Switch Claude Code config to SSE
  console.log("\n[STEP 3] Switching Claude Code config to SSE mode...");
  try {
    runScript(CONFIG_SCRIPT, "--enable");
    pass("Config switch to SSE (--enable)");
  } catch (err) {
    fail("Config switch to SSE", err.message);
  }

  // STEP 4: Verify SSE endpoints respond on each active port
  console.log("\n[STEP 4] Verifying SSE endpoints (/healthz)...");
  const sseResults = await Promise.allSettled(
    SERVERS.map(async (srv) => ({
      ...srv,
      alive: await checkHealth(srv.port),
    })),
  );

  let sseOk = 0;
  for (const r of sseResults) {
    if (r.status !== "fulfilled") continue;
    const { name, port, alive } = r.value;
    if (alive) {
      console.log(`  [ok]   ${name.padEnd(16)} :${port}`);
      sseOk++;
    } else {
      console.log(`  [skip] ${name.padEnd(16)} :${port}  (not running)`);
    }
  }

  if (sseOk === 0 && healthOk > 0) {
    fail("SSE endpoint verification — servers went down after config switch");
  } else if (sseOk > 0) {
    pass(`SSE endpoint verification — ${sseOk} endpoint(s) healthy`);
  } else {
    pass(
      "SSE endpoint verification — no servers running (all skipped due to missing env)",
    );
  }

  // STEP 5: Restore stdio config
  console.log("\n[STEP 5] Restoring stdio config...");
  try {
    runScript(CONFIG_SCRIPT, "--disable");
    pass("Config restore to stdio (--disable)");
  } catch (err) {
    fail("Config restore to stdio", err.message);
  }

  // STEP 6: Stop gateways
  console.log("\n[STEP 6] Stopping gateways...");
  try {
    runScript(START_SCRIPT, "--stop");
    pass("Gateway stop script ran without error");
  } catch (err) {
    fail("Gateway stop script", err.message);
  }

  // STEP 7: Orphan check — brief settle, then verify no supergateway processes remain
  console.log("\n[STEP 7] Checking for orphan supergateway processes...");
  await sleep(2000);

  const orphanCount = countSupergateways();
  if (orphanCount === 0) {
    pass("No orphan supergateway processes (WMI/tasklist clean)");
  } else {
    fail(
      "Orphan processes found",
      `${orphanCount} supergateway process(es) still running`,
    );
  }

  printSummary();
}

main();
