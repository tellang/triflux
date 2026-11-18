#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  homedir,
  platform,
  release,
  totalmem,
} from "node:os";
import { join } from "node:path";
import { redactTraceEntry } from "../hub/lib/spawn-trace.mjs";

const TRIFLUX_DIR = join(homedir(), ".triflux");
const LOGS_DIR = join(TRIFLUX_DIR, "logs");
const DIAG_DIR = join(TRIFLUX_DIR, "diagnostics");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const ONE_HOUR_MS = 60 * 60 * 1000;

function collectSpawnTraces(cutoffMs = ONE_HOUR_MS) {
  if (!existsSync(LOGS_DIR)) return [];

  const now = Date.now();
  const entries = [];

  for (const file of readdirSync(LOGS_DIR)) {
    if (!file.startsWith("spawn-trace-") || !file.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(LOGS_DIR, file), "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = new Date(entry.ts).getTime();
        // 예전 버전 로그에는 프롬프트 원문이 있다. 번들에 넣기 전에 가린다.
        if (now - ts <= cutoffMs) entries.push(redactTraceEntry(entry));
      } catch {}
    }
  }

  return entries;
}

function computeSpawnStats(traces) {
  if (traces.length === 0) {
    return { total: 0, peakRatePerSec: 0, maxConcurrent: 0, blocked: 0 };
  }

  const spawnEvents = traces.filter((t) => t.event === "spawn");
  const exitEvents = traces.filter(
    (t) => t.event === "exit" || t.event === "error",
  );
  const blockedEvents = traces.filter((t) => t.event === "blocked");

  let peakRate = 0;
  for (const evt of spawnEvents) {
    const ts = new Date(evt.ts).getTime();
    const windowEnd = ts + 1000;
    const inWindow = spawnEvents.filter((e) => {
      const t = new Date(e.ts).getTime();
      return t >= ts && t < windowEnd;
    }).length;
    if (inWindow > peakRate) peakRate = inWindow;
  }

  const events = [
    ...spawnEvents.map((e) => ({ ts: new Date(e.ts).getTime(), delta: 1 })),
    ...exitEvents.map((e) => ({ ts: new Date(e.ts).getTime(), delta: -1 })),
  ].sort((a, b) => a.ts - b.ts);

  let concurrent = 0;
  let maxConcurrent = 0;
  for (const e of events) {
    concurrent += e.delta;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
  }

  return {
    total: spawnEvents.length,
    peakRatePerSec: peakRate,
    maxConcurrent,
    blocked: blockedEvents.length,
  };
}

// approval_mode = "approve" 가 있으면 non-TTY codex exec 가 승인 대기로 멈추므로 감지한다 (#66).
function checkCodexMcpApproval() {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { found: false, reason: "config.toml not found" };
  }

  let content;
  try {
    content = readFileSync(CODEX_CONFIG_PATH, "utf8");
  } catch {
    return { found: false, reason: "config.toml unreadable" };
  }

  const badTools = [];
  let inMcpTool = false;
  let currentSection = "";

  for (const line of content.split("\n")) {
    const sectionMatch = line.match(/^\[(.+)\]/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      inMcpTool = /^mcp_servers\..+\.tools\./.test(currentSection);
      continue;
    }
    if (inMcpTool && /^\s*approval_mode\s*=\s*"approve"/.test(line)) {
      badTools.push(currentSection);
    }
  }

  return {
    found: badTools.length > 0,
    tools: badTools,
    fix: 'sed -i \'s/approval_mode = "approve"/approval_mode = "auto"/g\' ~/.codex/config.toml',
  };
}

function collectSystemInfo() {
  const info = {
    platform: platform(),
    release: release(),
    arch: arch(),
    nodeVersion: process.version,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCores: cpus().length,
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    freeMemMB: Math.round(freemem() / 1024 / 1024),
  };

  // wt.exe --version 은 GUI 창을 띄우므로 AppxPackage 로 조회하고, 비Windows 는 설치 누락 오해를 막기 위해 명시적으로 N/A 처리한다.
  if (platform() === "win32") {
    try {
      const wtVer = execSync(
        'powershell.exe -NoProfile -NoLogo -Command "(Get-AppxPackage Microsoft.WindowsTerminal).Version"',
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      ).trim();
      info.wtVersion = wtVer || "not found";
    } catch {
      info.wtVersion = "not found";
    }
  } else {
    info.wtVersion = "N/A (non-Windows)";
  }

  try {
    const pkgPath = join(homedir(), ".triflux", "package.json");
    if (existsSync(pkgPath)) {
      info.trifluxVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    }
  } catch {}

  return info;
}

function generateSummary(stats, sysInfo, traceCount) {
  const lines = [
    "=== triflux diagnostic summary ===",
    `generated: ${new Date().toISOString()}`,
    "",
    "--- System ---",
    `OS:       ${sysInfo.platform} ${sysInfo.release} (${sysInfo.arch})`,
    `Node:     ${sysInfo.nodeVersion}`,
    `CPU:      ${sysInfo.cpuModel} (${sysInfo.cpuCores} cores)`,
    `RAM:      ${sysInfo.freeMemMB}MB free / ${sysInfo.totalMemMB}MB total`,
    `WT:       ${sysInfo.wtVersion}`,
    `triflux:  ${sysInfo.trifluxVersion || "unknown"}`,
    "",
    "--- Spawn Stats (last 1h) ---",
    `total spawns:      ${stats.total}`,
    `peak rate/sec:     ${stats.peakRatePerSec}`,
    `max concurrent:    ${stats.maxConcurrent}`,
    `blocked:           ${stats.blocked}`,
    `trace entries:     ${traceCount}`,
    "",
    "--- Codex MCP Approval Check ---",
  ];

  const mcpCheck = checkCodexMcpApproval();
  if (!mcpCheck.found && mcpCheck.reason) {
    lines.push(`  ${mcpCheck.reason}`);
  } else if (mcpCheck.found) {
    lines.push(
      `  ⚠ ${mcpCheck.tools.length}개 MCP tool에 approval_mode="approve" 감지`,
    );
    lines.push(`    codex exec non-TTY stall 위험 (refs: triflux#66)`);
    for (const tool of mcpCheck.tools) {
      lines.push(`    - [${tool}]`);
    }
    lines.push(`    fix: ${mcpCheck.fix}`);
  } else {
    lines.push("  ✔ MCP tool approval_mode 정상");
  }

  return lines.join("\n");
}

function createZipArchive(bundleDir, zipPath) {
  if (platform() === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path '${bundleDir}\\*' -DestinationPath '${zipPath}' -Force`,
      ],
      { timeout: 30000, windowsHide: true },
    );
    return;
  }

  execFileSync("zip", ["-qr", zipPath, "."], {
    cwd: bundleDir,
    timeout: 30000,
    windowsHide: true,
  });
}

export async function diagnose({ json = false } = {}) {
  mkdirSync(DIAG_DIR, { recursive: true, mode: 0o700 });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundleDir = join(DIAG_DIR, `diag-${timestamp}`);
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

  const traces = collectSpawnTraces();
  writeFileSync(
    join(bundleDir, "blackbox.jsonl"),
    traces.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );

  // 공유용 번들이라 환경변수(API 키 포함), 호스트명, 네트워크 인터페이스, 경로 노출을 피하기 위해 필요한 필드만 남긴다.
  let report;
  try {
    const full = process.report.getReport();
    const { host, networkInterfaces, commandLine, cwd, ...header } =
      full.header;
    report = {
      header,
      javascriptStack: full.javascriptStack,
      javascriptHeap: full.javascriptHeap,
      nativeStack: full.nativeStack,
      resourceUsage: full.resourceUsage,
      uvthreadResourceUsage: full.uvthreadResourceUsage,
      userLimits: full.userLimits,
    };
  } catch {
    report = { error: "report generation failed" };
  }
  writeFileSync(
    join(bundleDir, "process-report.json"),
    JSON.stringify(report, null, 2),
  );

  const stats = computeSpawnStats(traces);
  writeFileSync(
    join(bundleDir, "spawn-stats.json"),
    JSON.stringify(stats, null, 2),
  );

  const sysInfo = collectSystemInfo();
  writeFileSync(
    join(bundleDir, "system-info.json"),
    JSON.stringify(sysInfo, null, 2),
  );

  const summary = generateSummary(stats, sysInfo, traces.length);
  writeFileSync(join(bundleDir, "summary.txt"), summary);

  const zipPath = `${bundleDir}.zip`;
  try {
    createZipArchive(bundleDir, zipPath);
  } catch (err) {
    if (json) {
      return { ok: false, bundleDir, error: `zip failed: ${err.message}` };
    }
    return { ok: false, bundleDir, zipPath: null, error: err.message };
  }

  try {
    const { rmSync } = await import("node:fs");
    rmSync(bundleDir, { recursive: true, force: true });
  } catch {}

  const mcpApprovalCheck = checkCodexMcpApproval();

  const result = {
    ok: true,
    zipPath,
    stats,
    sysInfo,
    traceCount: traces.length,
    codexMcpApproval: mcpApprovalCheck,
  };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }

  return result;
}

const isMain =
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;

if (isMain) {
  const json = process.argv.includes("--json");
  const result = await diagnose({ json });
  if (!json) {
    if (result.ok) {
      console.log(`\n  진단 번들 생성: ${result.zipPath}`);
      console.log(`  spawn 이벤트: ${result.traceCount}건\n`);
    } else {
      console.error(`  진단 실패: ${result.error}`);
      process.exit(1);
    }
  }
}
