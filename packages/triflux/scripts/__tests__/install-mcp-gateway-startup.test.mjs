import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runStartupInstaller } from "../install-mcp-gateway-startup.mjs";

function makeFs(existing = []) {
  const files = new Map(existing.map(([path, body = ""]) => [path, body]));
  const dirs = new Set();
  const removed = [];
  return {
    files,
    dirs,
    removed,
    existsSync(path) {
      return files.has(path) || dirs.has(path);
    },
    mkdirSync(path) {
      dirs.add(path);
    },
    writeFileSync(path, body) {
      files.set(path, String(body));
    },
    rmSync(path) {
      removed.push(path);
      files.delete(path);
      dirs.delete(path);
    },
  };
}

function makeRun({ failPatterns = [] } = {}) {
  const calls = [];
  const run = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(" ");
    if (failPatterns.some((pattern) => line.includes(pattern))) {
      const error = new Error(`mock command failed: ${line}`);
      error.status = 1;
      throw error;
    }
    return "";
  };
  run.calls = calls;
  return run;
}

const baseOptions = {
  home: "/home/user",
  nodePath: "/usr/local/bin/node",
  projectRoot: "/repo",
  stdout: { write() {} },
  stderr: { write() {} },
};

describe("install mcp gateway startup", () => {
  it("darwin dry-run prints the plist, wrapper, and launchctl steps without writing", () => {
    const fs = makeFs();
    const run = makeRun();

    const result = runStartupInstaller({
      ...baseOptions,
      argv: ["--dry-run"],
      fs,
      platform: "darwin",
      run,
    });

    assert.equal(result.code, 0);
    assert.equal(result.dryRun, true);
    assert.equal(fs.files.size, 0);
    assert.equal(run.calls.length, 0);
    assert.deepEqual(
      result.plannedCommands.map((step) => step.command),
      [
        "mkdir -p",
        "write wrapper",
        "chmod 700",
        "write plist",
        "launchctl load -w",
        "launchctl list",
      ],
    );
  });

  it("darwin install writes a secret-free plist and sources secrets in the wrapper", () => {
    const fs = makeFs();
    const run = makeRun();
    let launchctlListCalls = 0;
    const runWithUnloadedLaunchd = (cmd, args = []) => {
      if (cmd === "launchctl" && args[0] === "list") {
        launchctlListCalls++;
        if (launchctlListCalls === 1) {
          throw new Error("not loaded");
        }
      }
      return run(cmd, args);
    };
    runWithUnloadedLaunchd.calls = run.calls;

    const result = runStartupInstaller({
      ...baseOptions,
      fs,
      platform: "darwin",
      run: runWithUnloadedLaunchd,
    });

    const plistPath = join(
      "/home/user",
      "Library",
      "LaunchAgents",
      "com.tellang.mcp-gateway.plist",
    );
    const wrapperPath = join(
      "/home/user",
      ".local",
      "bin",
      "mcp-gateway-wrapper.sh",
    );

    assert.equal(result.code, 0);
    assert.equal(result.verified, true);
    assert.match(fs.files.get(plistPath), /com\.tellang\.mcp-gateway/);
    assert.match(fs.files.get(plistPath), /mcp-gateway-wrapper\.sh/);
    assert.doesNotMatch(fs.files.get(plistPath), /API_KEY|TOKEN|SECRET/);
    assert.match(fs.files.get(wrapperPath), /mcp-gateway\.env/);
    // Codex cross-review (PR #312): Darwin wrapper 도 Linux EnvironmentFile assertion
    // 처럼 secrets.env 명시 검증 + sourcing 순서 (secrets.env → legacy mcp-gateway.env) 고정.
    assert.match(
      fs.files.get(wrapperPath),
      /\$HOME\/\.config\/triflux\/secrets\.env/,
    );
    {
      const body = fs.files.get(wrapperPath);
      const secretsIdx = body.indexOf("$HOME/.config/triflux/secrets.env");
      const legacyIdx = body.indexOf("$HOME/.config/triflux/mcp-gateway.env");
      assert.ok(secretsIdx >= 0, "secrets.env 가 wrapper sourcing 목록에 있어야 한다");
      assert.ok(legacyIdx >= 0, "legacy mcp-gateway.env 도 호환 유지");
      assert.ok(
        secretsIdx < legacyIdx,
        "secrets.env 가 legacy mcp-gateway.env 보다 먼저 sourcing 되어야 한다",
      );
    }
    assert.match(
      fs.files.get(wrapperPath),
      /exec '\/usr\/local\/bin\/node' '\/repo\/scripts\/mcp-gateway-start\.mjs'/,
    );
    assert.deepEqual(run.calls.at(-2), ["launchctl", "load", "-w", plistPath]);
    assert.deepEqual(run.calls.at(-1), [
      "launchctl",
      "list",
      "com.tellang.mcp-gateway",
    ]);
  });

  it("darwin prints manual launchctl instructions when plist write is blocked", () => {
    const fs = makeFs();
    const writes = [];
    fs.writeFileSync = (path, body) => {
      writes.push(path);
      if (path.endsWith(".plist")) throw new Error("permission denied");
      fs.files.set(path, String(body));
    };
    const run = makeRun();
    let output = "";

    const result = runStartupInstaller({
      ...baseOptions,
      fs,
      platform: "darwin",
      run,
      stdout: { write: (chunk) => (output += chunk) },
    });

    assert.equal(result.code, 1);
    assert.equal(result.verified, false);
    assert.equal(
      writes.some((path) => path.endsWith(".plist")),
      true,
    );
    assert.match(output, /Could not write .*com\.tellang\.mcp-gateway\.plist/);
    assert.match(output, /launchctl load -w/);
    assert.equal(run.calls.length, 0);
  });

  it("win32 installs with schtasks onlogon when task registration verifies", () => {
    const fs = makeFs();
    const run = makeRun();

    const result = runStartupInstaller({
      ...baseOptions,
      home: "C:\\Users\\me",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      projectRoot: "C:\\repo",
      fs,
      platform: "win32",
      run,
    });

    assert.equal(result.code, 0);
    assert.equal(result.method, "schtasks");
    assert.equal(result.verified, true);
    assert.equal(run.calls[0][0], "schtasks");
    assert.deepEqual(run.calls[0].slice(1, 7), [
      "/create",
      "/tn",
      "MCP Gateway",
      "/tr",
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\scripts\\mcp-gateway-start.mjs"',
      "/sc",
    ]);
    assert.equal(run.calls[0].includes("onlogon"), true);
    assert.deepEqual(run.calls.at(-1), [
      "schtasks",
      "/query",
      "/tn",
      "MCP Gateway",
    ]);
  });

  it("win32 falls back to a Startup .lnk when schtasks fails", () => {
    const fs = makeFs();
    const run = makeRun({ failPatterns: ["schtasks /create"] });

    const result = runStartupInstaller({
      ...baseOptions,
      home: "C:\\Users\\me",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      projectRoot: "C:\\repo",
      fs,
      platform: "win32",
      run,
    });

    assert.equal(result.code, 0);
    assert.equal(result.method, "startup-link");
    assert.equal(result.verified, true);
    assert.equal(
      run.calls.some((call) => call[0] === "powershell"),
      true,
    );
    assert.match(result.linkPath, /MCP Gateway\.lnk$/);
  });

  it("linux installs a user systemd service with environment files outside the unit", () => {
    const fs = makeFs();
    const run = makeRun();

    const result = runStartupInstaller({
      ...baseOptions,
      fs,
      platform: "linux",
      run,
    });

    const unitPath = join(
      "/home/user",
      ".config",
      "systemd",
      "user",
      "mcp-gateway.service",
    );

    assert.equal(result.code, 0);
    assert.equal(result.verified, true);
    assert.match(
      fs.files.get(unitPath),
      /EnvironmentFile=-%h\/\.config\/triflux\/secrets\.env/,
    );
    assert.match(
      fs.files.get(unitPath),
      /EnvironmentFile=-%h\/\.config\/triflux\/mcp-gateway\.env/,
    );
    assert.match(
      fs.files.get(unitPath),
      /ExecStart="\/usr\/local\/bin\/node" "\/repo\/scripts\/mcp-gateway-start\.mjs"/,
    );
    assert.equal(run.calls.at(-1)[0], "systemctl");
    assert.deepEqual(run.calls.at(-1).slice(1), [
      "--user",
      "is-enabled",
      "mcp-gateway.service",
    ]);
  });

  it("linux unit quotes paths with spaces", () => {
    const fs = makeFs();
    const run = makeRun();

    const result = runStartupInstaller({
      ...baseOptions,
      nodePath: "/opt/node builds/bin/node",
      projectRoot: "/home/user/Projects/my repo",
      fs,
      platform: "linux",
      run,
    });

    const unitPath = join(
      "/home/user",
      ".config",
      "systemd",
      "user",
      "mcp-gateway.service",
    );
    const unit = fs.files.get(unitPath);

    assert.equal(result.code, 0);
    assert.match(unit, /WorkingDirectory="\/home\/user\/Projects\/my repo"/);
    assert.match(
      unit,
      /ExecStart="\/opt\/node builds\/bin\/node" "\/home\/user\/Projects\/my repo\/scripts\/mcp-gateway-start\.mjs"/,
    );
  });

  it("macOS wrapper rejects shell metacharacters", () => {
    const fs = makeFs();
    const run = makeRun();
    let stderr = "";

    const result = runStartupInstaller({
      ...baseOptions,
      projectRoot: "/tmp/triflux$(touch injected)",
      fs,
      platform: "darwin",
      run,
      stderr: { write: (chunk) => (stderr += chunk) },
    });

    assert.equal(result.code, 1);
    assert.equal(result.platform, "darwin");
    assert.match(stderr, /unsafe shell metacharacter/);
    assert.equal(fs.files.size, 0);
    assert.equal(run.calls.length, 0);
  });

  it("uninstall removes the OS startup registration", () => {
    const fs = makeFs();
    const run = makeRun();

    const result = runStartupInstaller({
      ...baseOptions,
      argv: ["--uninstall"],
      fs,
      platform: "darwin",
      run,
    });

    assert.equal(result.code, 0);
    assert.equal(result.action, "uninstall");
    assert.deepEqual(run.calls[0], [
      "launchctl",
      "unload",
      "-w",
      join(
        "/home/user",
        "Library",
        "LaunchAgents",
        "com.tellang.mcp-gateway.plist",
      ),
    ]);
    assert.equal(fs.removed.length, 2);
  });
});
