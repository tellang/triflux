#!/usr/bin/env node
// scripts/doctor-diagnose.mjs — 진단 번들 생성기
//
// spawn-trace JSONL + process report + hook timing + spawn stats + system info
// → ~/.triflux/diagnostics/diag-{timestamp}.zip (PowerShell Compress-Archive)

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";

const TRIFLUX_DIR = join(homedir(), ".triflux");
const LOGS_DIR = join(TRIFLUX_DIR, "logs");
const DIAG_DIR = join(TRIFLUX_DIR, "diagnostics");
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
        if (now - ts <= cutoffMs) entries.push(entry);
      } catch { /* skip malformed */ }
    }
  }

  return entries;
}

function computeSpawnStats(traces) {
  if (traces.length === 0) {
    return { total: 0, peakRatePerSec: 0, maxConcurrent: 0, blocked: 0 };
  }

  const spawnEvents = traces.filter((t) => t.event === "spawn");
  const exitEvents = traces.filter((t) => t.event === "exit" || t.event === "error");
  const blockedEvents = traces.filter((t) => t.event === "blocked");

  // peak rate per second
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

  // max concurrent (spawn without matching exit)
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

  // Windows Terminal version
  try {
    const wtVer = execSync("wt.exe --version 2>&1", {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    info.wtVersion = wtVer;
  } catch {
    info.wtVersion = "not found";
  }

  // triflux version
  try {
    const pkgPath = join(homedir(), ".triflux", "package.json");
    if (existsSync(pkgPath)) {
      info.trifluxVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    }
  } catch { /* ignore */ }

  return info;
}

function collectHookTimings() {
  // hook-orchestrator 또는 session-start-fast 로그에서 타이밍 추출
  const hookLogDir = join(TRIFLUX_DIR, "logs");
  if (!existsSync(hookLogDir)) return [];

  const timings = [];
  for (const file of readdirSync(hookLogDir)) {
    if (!file.startsWith("hook-") || !file.endsWith(".jsonl")) continue;
    try {
      const lines = readFileSync(join(hookLogDir, file), "utf8")
        .split("\n")
        .filter(Boolean);
      const now = Date.now();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = new Date(entry.ts || entry.time).getTime();
          if (now - ts <= ONE_HOUR_MS) timings.push(entry);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return timings;
}

function generateSummary(stats, sysInfo, hookTimings, traceCount) {
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
    "--- Hook Timings (last 1h) ---",
  ];

  if (hookTimings.length === 0) {
    lines.push("no hook timing data found");
  } else {
    for (const t of hookTimings.slice(-20)) {
      const hook = t.hook || t.msg || "unknown";
      const dur = t.dur_ms ?? t.duration_ms ?? "?";
      lines.push(`  ${hook}: ${dur}ms`);
    }
  }

  return lines.join("\n");
}

export async function diagnose({ json = false } = {}) {
  mkdirSync(DIAG_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundleDir = join(DIAG_DIR, `diag-${timestamp}`);
  mkdirSync(bundleDir, { recursive: true });

  // 1. spawn-trace JSONL
  const traces = collectSpawnTraces();
  writeFileSync(
    join(bundleDir, "blackbox.jsonl"),
    traces.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );

  // 2. process report
  try {
    const reportPath = process.report.writeReport(join(bundleDir, "process-report.json"));
    // writeReport returns the path it wrote to
    if (reportPath && reportPath !== join(bundleDir, "process-report.json")) {
      // move if written elsewhere
      const { renameSync } = await import("node:fs");
      try { renameSync(reportPath, join(bundleDir, "process-report.json")); } catch { /* ignore */ }
    }
  } catch {
    writeFileSync(join(bundleDir, "process-report.json"), JSON.stringify({ error: "report generation failed" }));
  }

  // 3. hook timings
  const hookTimings = collectHookTimings();
  writeFileSync(
    join(bundleDir, "hook-timings.jsonl"),
    hookTimings.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );

  // 4. spawn stats
  const stats = computeSpawnStats(traces);
  writeFileSync(join(bundleDir, "spawn-stats.json"), JSON.stringify(stats, null, 2));

  // 5. system info
  const sysInfo = collectSystemInfo();
  writeFileSync(join(bundleDir, "system-info.json"), JSON.stringify(sysInfo, null, 2));

  // 6. summary
  const summary = generateSummary(stats, sysInfo, hookTimings, traces.length);
  writeFileSync(join(bundleDir, "summary.txt"), summary);

  // 7. zip via PowerShell Compress-Archive
  const zipPath = `${bundleDir}.zip`;
  try {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -Path '${bundleDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { timeout: 30000, windowsHide: true });
  } catch (err) {
    // fallback: leave the directory unzipped
    if (json) {
      return { ok: false, bundleDir, error: `zip failed: ${err.message}` };
    }
    return { ok: false, bundleDir, zipPath: null, error: err.message };
  }

  // cleanup temp directory
  try {
    const { rmSync } = await import("node:fs");
    rmSync(bundleDir, { recursive: true, force: true });
  } catch { /* leave it */ }

  const result = {
    ok: true,
    zipPath,
    stats,
    sysInfo,
    traceCount: traces.length,
    hookTimingCount: hookTimings.length,
  };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }

  return result;
}

// CLI direct execution
const isMain =
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` ||
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;

if (isMain) {
  const json = process.argv.includes("--json");
  const result = await diagnose({ json });
  if (!json) {
    if (result.ok) {
      console.log(`\n  진단 번들 생성: ${result.zipPath}`);
      console.log(`  spawn 이벤트: ${result.traceCount}건, 훅 타이밍: ${result.hookTimingCount}건\n`);
    } else {
      console.error(`  진단 실패: ${result.error}`);
      process.exit(1);
    }
  }
}
