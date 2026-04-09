#!/usr/bin/env node
// mcp-gateway-start.mjs — supergateway MCP SSE 영속 서비스 관리
// Usage: node mcp-gateway-start.mjs          # 시작
//        node mcp-gateway-start.mjs --stop   # 중지
//        node mcp-gateway-start.mjs --status # 상태 확인

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isServerEnabled } from "./lib/mcp-manifest.mjs";

const PID_FILE = join(tmpdir(), "tfx-gateway-pids.json");
const STARTUP_WAIT_MS = 8000;
const POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 3000;

const SERVERS = [
  {
    name: "context7",
    port: 8100,
    cmd: "npx -y @upstash/context7-mcp@latest",
    envVars: [],
  },
  {
    name: "brave-search",
    port: 8101,
    cmd: "npx -y @brave/brave-search-mcp-server",
    envVars: ["BRAVE_API_KEY"],
  },
  {
    name: "exa",
    port: 8102,
    cmd: "npx -y exa-mcp-server",
    envVars: ["EXA_API_KEY"],
  },
  {
    name: "tavily",
    port: 8103,
    cmd: "npx -y tavily-mcp@latest",
    envVars: ["TAVILY_API_KEY"],
  },
  {
    name: "jira",
    port: 8104,
    cmd: "npx -y mcp-jira-cloud@latest",
    envVars: ["JIRA_API_TOKEN", "JIRA_EMAIL", "JIRA_INSTANCE_URL"],
  },
  {
    name: "serena",
    port: 8105,
    cmd: "uvx --from git+https://github.com/oraios/serena serena start-mcp-server",
    envVars: [],
  },
  {
    name: "notion",
    port: 8106,
    cmd: "npx -y @notionhq/notion-mcp-server",
    envVars: ["NOTION_TOKEN"],
  },
  {
    name: "notion-guest",
    port: 8107,
    cmd: "npx -y @notionhq/notion-mcp-server",
    envVars: ["NOTION_TOKEN"],
  },
];

export { SERVERS };

// ── 유틸리티 ──

function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 시작 ──

function spawnGateway(srv) {
  // 임시 .cmd 파일로 quoting 문제 회피
  const cmdContent = `@echo off\nnpx -y supergateway --stdio "${srv.cmd}" --port ${srv.port} --outputTransport sse --healthEndpoint /healthz --cors "http://localhost"`;
  const cmdFile = join(tmpdir(), `tfx-sg-${srv.name}.cmd`);
  writeFileSync(cmdFile, cmdContent);

  // PowerShell Start-Process: Windows Job Object에서 벗어나 부모 종료 후 생존
  execSync(
    `powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c','${cmdFile.replaceAll("'", "''")}'"`,
    { stdio: "ignore", timeout: 10000 },
  );
}

function ensureFirewallRule() {
  if (process.platform !== "win32") return;
  const ports = SERVERS.map((s) => s.port).join(",");
  const ruleName = "TFX-MCP-Gateway-Block-External";
  try {
    // 기존 규칙 있으면 스킵
    const check = execSync(
      `netsh advfirewall firewall show rule name="${ruleName}" 2>&1`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    );
    if (check.includes(ruleName)) return;
  } catch {
    /* 규칙 없음 — 생성 */
  }

  try {
    execSync(
      `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=block protocol=tcp localport=${ports} remoteip=any profile=any`,
      { stdio: "ignore", timeout: 5000 },
    );
    console.log(
      `[SEC] Firewall rule added: block external access to ports ${ports}`,
    );
  } catch {
    console.log(
      `[SEC] WARNING: Could not add firewall rule — run as admin or manually block ports ${ports}`,
    );
  }
}

async function startAll() {
  ensureFirewallRule();
  const launched = [];

  for (const srv of SERVERS) {
    // 포트 사용 중이면 스킵
    if (await isPortInUse(srv.port)) {
      console.log(`[SKIP] ${srv.name} already running on :${srv.port}`);
      continue;
    }

    // 매니페스트 체크 (위저드에서 비활성화한 서버)
    if (!isServerEnabled(srv.name)) {
      console.log(`[SKIP] ${srv.name} — manifest에서 비활성`);
      continue;
    }

    // 필수 환경변수 체크
    const missing = srv.envVars.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.log(
        `[WARN] ${srv.name} skipped — missing env: ${missing.join(", ")}`,
      );
      continue;
    }

    spawnGateway(srv);
    launched.push(srv);
    console.log(`[START] ${srv.name} on :${srv.port}`);
  }

  if (launched.length === 0) {
    console.log("\n[gateway] No servers started (all running or skipped)");
    return;
  }

  // 헬스체크 대기
  console.log(`\n[gateway] Waiting for ${launched.length} servers...`);
  const deadline = Date.now() + STARTUP_WAIT_MS;
  const pending = new Set(launched.map((s) => s.port));

  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    for (const port of [...pending]) {
      if (await checkHealth(port)) pending.delete(port);
    }
  }

  // 결과 출력
  console.log("\nHealth Check");
  console.log("=".repeat(50));
  const pidEntries = [];
  for (const srv of launched) {
    const healthy = !pending.has(srv.port);
    const mark = healthy ? "\u2713" : "\u2717";
    const status = healthy ? "ok" : "down";
    console.log(`  ${srv.name.padEnd(16)} :${srv.port}  ${mark} ${status}`);
    if (healthy) pidEntries.push({ name: srv.name, port: srv.port });
  }

  // PID 파일 대신 포트 매니페스트 저장 (프로세스 찾기는 포트 기반)
  const existing = loadManifest();
  const merged = [
    ...existing.filter((e) => !pidEntries.some((p) => p.port === e.port)),
    ...pidEntries,
  ];
  writeFileSync(PID_FILE, JSON.stringify(merged, null, 2));
  console.log(
    `\n[gateway] ${launched.length - pending.size}/${launched.length} healthy. Manifest: ${PID_FILE}`,
  );
}

// ── 중지 ──

function stopAll() {
  // supergateway + 하위 MCP 프로세스를 포트 기반으로 찾아 종료
  try {
    // temp .ps1 파일로 bash/cmd 쿼팅 충돌 회피
    const psFile = join(tmpdir(), "tfx-sg-stop.ps1");
    writeFileSync(
      psFile,
      [
        `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |`,
        `  Where-Object { $_.CommandLine -match 'supergateway' } |`,
        `  ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null; Write-Output "[STOP] PID $($_.ProcessId)" }`,
      ].join("\n"),
    );
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
      {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    if (output.trim()) console.log(output.trim());
    else console.log("[gateway] No supergateway processes found");
  } catch {
    console.log("[gateway] No supergateway processes found");
  }

  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
    console.log("[gateway] Manifest removed");
  }
}

// ── 상태 ──

async function showStatus() {
  const manifest = loadManifest();
  if (manifest.length === 0) {
    console.log("[gateway] No manifest — checking all ports...");
  }

  console.log("\nMCP Gateway Status");
  console.log("=".repeat(50));
  for (const srv of SERVERS) {
    const healthy = await checkHealth(srv.port);
    const mark = healthy ? "\u2713" : "\u2717";
    const status = healthy ? "ok" : "down";
    console.log(`  ${srv.name.padEnd(16)} :${srv.port}  ${mark} ${status}`);
  }
}

function loadManifest() {
  if (!existsSync(PID_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return [];
  }
}

// ── main ──

const flag = process.argv[2];
if (flag === "--stop") {
  stopAll();
} else if (flag === "--status") {
  await showStatus();
} else {
  await startAll();
}
