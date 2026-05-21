#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.tellang.mcp-gateway";
const TASK_NAME = "MCP Gateway";
const SYSTEMD_UNIT = "mcp-gateway.service";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = dirname(SCRIPT_DIR);

function realRun(command, args = []) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
}

const realFs = {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
};

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    dryRun: args.has("--dry-run"),
    help: args.has("--help") || args.has("-h"),
    uninstall: args.has("--uninstall"),
  };
}

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function assertNoShellMetacharacters(value, label) {
  if (/[$`;&|\r\n]/.test(String(value))) {
    throw new Error(`${label} contains unsafe shell metacharacter`);
  }
}

function systemdQuote(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function makePaths({ home, nodePath, platform, projectRoot }) {
  const p = pathApiFor(platform);
  const gatewayScript = p.join(projectRoot, "scripts", "mcp-gateway-start.mjs");

  if (platform === "win32") {
    const appData = process.env.APPDATA || p.join(home, "AppData", "Roaming");
    return {
      appData,
      gatewayScript,
      linkPath: p.join(
        appData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "MCP Gateway.lnk",
      ),
      nodePath,
      projectRoot,
    };
  }

  return {
    gatewayScript,
    launchAgentsDir: p.join(home, "Library", "LaunchAgents"),
    logDir: p.join(home, ".local", "state", "triflux"),
    nodePath,
    plistPath: p.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    projectRoot,
    systemdDir: p.join(home, ".config", "systemd", "user"),
    systemdPath: p.join(home, ".config", "systemd", "user", SYSTEMD_UNIT),
    wrapperDir: p.join(home, ".local", "bin"),
    wrapperPath: p.join(home, ".local", "bin", "mcp-gateway-wrapper.sh"),
  };
}

function makeStepRecorder({ dryRun, stdout }) {
  const plannedCommands = [];
  function plan(command, args = [], note = "") {
    plannedCommands.push({ args, command, note });
    if (dryRun) {
      const line = args.length > 0 ? `${command} ${args.join(" ")}` : command;
      stdout.write(`[dry-run] ${line}${note ? ` # ${note}` : ""}\n`);
    }
  }
  return { plan, plannedCommands };
}

function commandOk(run, command, args = []) {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

function writeFileSafe(fs, filePath, body, stdout) {
  try {
    fs.writeFileSync(filePath, body, "utf8");
    return true;
  } catch (error) {
    stdout.write(`[manual] Could not write ${filePath}: ${error.message}\n`);
    stdout.write("[manual] Write the file content shown below, then run:\n");
    stdout.write(`launchctl load -w ${shellQuote(filePath)}\n`);
    stdout.write("----- file content -----\n");
    stdout.write(`${body}\n`);
    stdout.write("----- end file content -----\n");
    return false;
  }
}

function buildDarwinWrapper({ gatewayScript, nodePath }) {
  assertNoShellMetacharacters(nodePath, "nodePath");
  assertNoShellMetacharacters(gatewayScript, "gatewayScript");

  return `#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

for env_file in "$HOME/.config/triflux/mcp-gateway.env" "$HOME/.config/tfx/mcp-gateway.env" "$HOME/.mcp-gateway.env"; do
  if [ -f "$env_file" ]; then
    set -a
    . "$env_file"
    set +a
  fi
done

exec ${shellQuote(nodePath)} ${shellQuote(gatewayScript)}
`;
}

function buildPlist({ logDir, wrapperPath }) {
  const escapedLabel = xmlEscape(LABEL);
  const escapedWrapper = xmlEscape(wrapperPath);
  const stdoutPath = xmlEscape(path.posix.join(logDir, "mcp-gateway.out.log"));
  const stderrPath = xmlEscape(path.posix.join(logDir, "mcp-gateway.err.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapedLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${escapedWrapper}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;
}

function installDarwin({ dryRun, fs, paths, plan, run, stdout }) {
  const wrapper = buildDarwinWrapper(paths);
  const plist = buildPlist(paths);

  plan("mkdir -p", [paths.wrapperDir, paths.launchAgentsDir, paths.logDir]);
  if (!dryRun) {
    fs.mkdirSync(paths.wrapperDir, { recursive: true });
    fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
    fs.mkdirSync(paths.logDir, { recursive: true });
  }

  plan("write wrapper", [paths.wrapperPath]);
  if (!dryRun) fs.writeFileSync(paths.wrapperPath, wrapper, "utf8");

  plan("chmod 700", [paths.wrapperPath]);
  if (!dryRun && typeof fs.chmodSync === "function") {
    fs.chmodSync(paths.wrapperPath, 0o700);
  }

  plan("write plist", [paths.plistPath]);
  if (!dryRun && !writeFileSafe(fs, paths.plistPath, plist, stdout)) {
    return { code: 1, platform: "darwin", registered: false, verified: false };
  }

  const alreadyLoaded = !dryRun && commandOk(run, "launchctl", ["list", LABEL]);
  plan("launchctl load -w", [paths.plistPath]);
  if (!dryRun && !alreadyLoaded) {
    run("launchctl", ["load", "-w", paths.plistPath]);
  }

  plan("launchctl list", [LABEL]);
  const verified = dryRun || commandOk(run, "launchctl", ["list", LABEL]);
  return {
    code: verified ? 0 : 1,
    method: "launchd",
    platform: "darwin",
    registered: alreadyLoaded,
    verified,
  };
}

function uninstallDarwin({ dryRun, fs, paths, plan, run }) {
  plan("launchctl unload -w", [paths.plistPath]);
  if (!dryRun) commandOk(run, "launchctl", ["unload", "-w", paths.plistPath]);

  plan("remove plist", [paths.plistPath]);
  plan("remove wrapper", [paths.wrapperPath]);
  if (!dryRun) {
    fs.rmSync(paths.plistPath, { force: true });
    fs.rmSync(paths.wrapperPath, { force: true });
  }

  return { action: "uninstall", code: 0, platform: "darwin", verified: true };
}

function windowsTaskCommand({ gatewayScript, nodePath }) {
  return `"${nodePath}" "${gatewayScript}"`;
}

function installWindowsStartupLink({ dryRun, paths, plan, run }) {
  const command = [
    "$wsh = New-Object -ComObject WScript.Shell;",
    `$shortcut = $wsh.CreateShortcut(${psSingleQuote(paths.linkPath)});`,
    `$shortcut.TargetPath = ${psSingleQuote(paths.nodePath)};`,
    `$shortcut.Arguments = ${psSingleQuote(`"${paths.gatewayScript}"`)};`,
    `$shortcut.WorkingDirectory = ${psSingleQuote(paths.projectRoot)};`,
    "$shortcut.Save();",
  ].join(" ");

  plan("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);
  if (!dryRun) {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ]);
  }

  const verify = `if (Test-Path -LiteralPath ${psSingleQuote(paths.linkPath)}) { exit 0 } else { exit 1 }`;
  plan("powershell", ["-NoProfile", "-Command", verify]);
  const verified =
    dryRun || commandOk(run, "powershell", ["-NoProfile", "-Command", verify]);
  return {
    code: verified ? 0 : 1,
    linkPath: paths.linkPath,
    method: "startup-link",
    platform: "win32",
    verified,
  };
}

function installWin32({ dryRun, paths, plan, run }) {
  const taskArgs = [
    "/create",
    "/tn",
    TASK_NAME,
    "/tr",
    windowsTaskCommand(paths),
    "/sc",
    "onlogon",
    "/f",
  ];
  plan("schtasks", taskArgs);

  let taskCreated = false;
  if (dryRun) {
    taskCreated = true;
  } else {
    try {
      run("schtasks", taskArgs);
      taskCreated = true;
    } catch {
      taskCreated = false;
    }
  }

  if (taskCreated) {
    const queryArgs = ["/query", "/tn", TASK_NAME];
    plan("schtasks", queryArgs);
    const verified = dryRun || commandOk(run, "schtasks", queryArgs);
    if (verified) {
      return {
        code: 0,
        method: "schtasks",
        platform: "win32",
        verified: true,
      };
    }
  }

  return installWindowsStartupLink({ dryRun, paths, plan, run });
}

function uninstallWin32({ dryRun, fs, paths, plan, run }) {
  const deleteArgs = ["/delete", "/tn", TASK_NAME, "/f"];
  plan("schtasks", deleteArgs);
  if (!dryRun) commandOk(run, "schtasks", deleteArgs);

  plan("remove startup link", [paths.linkPath]);
  if (!dryRun) fs.rmSync(paths.linkPath, { force: true });

  return { action: "uninstall", code: 0, platform: "win32", verified: true };
}

function buildSystemdUnit({ gatewayScript, nodePath, projectRoot }) {
  return `[Unit]
Description=Triflux MCP Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(projectRoot)}
Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
EnvironmentFile=-%h/.config/triflux/mcp-gateway.env
EnvironmentFile=-%h/.config/tfx/mcp-gateway.env
EnvironmentFile=-%h/.mcp-gateway.env
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(gatewayScript)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function installLinux({ dryRun, fs, paths, plan, run }) {
  const unit = buildSystemdUnit(paths);

  plan("mkdir -p", [paths.systemdDir]);
  if (!dryRun) fs.mkdirSync(paths.systemdDir, { recursive: true });

  plan("write systemd unit", [paths.systemdPath]);
  if (!dryRun) fs.writeFileSync(paths.systemdPath, unit, "utf8");

  const commands = [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]],
    ["systemctl", ["--user", "is-enabled", SYSTEMD_UNIT]],
  ];

  for (const [command, args] of commands) {
    plan(command, args);
    if (!dryRun) run(command, args);
  }

  return { code: 0, method: "systemd-user", platform: "linux", verified: true };
}

function uninstallLinux({ dryRun, fs, paths, plan, run }) {
  const commands = [
    ["systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]],
    ["systemctl", ["--user", "daemon-reload"]],
  ];
  for (const [command, args] of commands) {
    plan(command, args);
    if (!dryRun) commandOk(run, command, args);
  }

  plan("remove systemd unit", [paths.systemdPath]);
  if (!dryRun) fs.rmSync(paths.systemdPath, { force: true });

  return { action: "uninstall", code: 0, platform: "linux", verified: true };
}

function usage(stdout) {
  stdout.write(`Usage: node scripts/install-mcp-gateway-startup.mjs [--dry-run] [--uninstall]

Register scripts/mcp-gateway-start.mjs with the current OS startup mechanism.

Secrets are read by the startup process from one of:
  ~/.config/triflux/mcp-gateway.env
  ~/.config/tfx/mcp-gateway.env
  ~/.mcp-gateway.env
`);
}

export function runStartupInstaller(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const parsed = parseArgs(argv);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  if (parsed.help) {
    usage(stdout);
    return { code: 0, help: true };
  }

  const platform = options.platform || osPlatform();
  const fs = options.fs || realFs;
  const run = options.run || realRun;
  const home = options.home || homedir();
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const nodePath = options.nodePath || process.execPath;
  const paths = makePaths({ home, nodePath, platform, projectRoot });
  const { plan, plannedCommands } = makeStepRecorder({
    dryRun: parsed.dryRun,
    stdout,
  });

  let result;
  try {
    if (platform === "darwin") {
      result = parsed.uninstall
        ? uninstallDarwin({ dryRun: parsed.dryRun, fs, paths, plan, run })
        : installDarwin({
            dryRun: parsed.dryRun,
            fs,
            paths,
            plan,
            run,
            stdout,
          });
    } else if (platform === "win32") {
      result = parsed.uninstall
        ? uninstallWin32({ dryRun: parsed.dryRun, fs, paths, plan, run })
        : installWin32({ dryRun: parsed.dryRun, paths, plan, run });
    } else if (platform === "linux") {
      result = parsed.uninstall
        ? uninstallLinux({ dryRun: parsed.dryRun, fs, paths, plan, run })
        : installLinux({ dryRun: parsed.dryRun, fs, paths, plan, run });
    } else {
      stderr.write(`Unsupported platform: ${platform}\n`);
      return { code: 1, platform, supported: false };
    }
  } catch (error) {
    stderr.write(`[startup] ${error.message}\n`);
    result = { code: 1, platform, verified: false };
  }

  return {
    action: parsed.uninstall ? "uninstall" : "install",
    dryRun: parsed.dryRun,
    plannedCommands,
    ...result,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const result = runStartupInstaller();
  process.exit(result.code);
}
