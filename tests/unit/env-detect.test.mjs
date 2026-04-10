import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it, mock } from "node:test";

const MODULE_URL = new URL("../../hub/lib/env-detect.mjs", import.meta.url);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
const originalShell = process.env.SHELL;
const originalTermProgram = process.env.TERM_PROGRAM;
const restorers = [];

function registerRestore(fn) {
  restorers.push(fn);
}

function setPlatform(value) {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
  registerRestore(() => {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  });
}

function setEnv(name, value) {
  const previous = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  registerRestore(() => {
    if (previous == null) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

function mockExecFileSync(impl) {
  const tracker = mock.method(childProcess, "execFileSync", impl);
  syncBuiltinESMExports();
  registerRestore(() => {
    tracker.mock.restore();
    syncBuiltinESMExports();
  });
}

async function importFresh() {
  const url = new URL(MODULE_URL);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()();
  }

  if (process.env.SHELL !== originalShell) {
    if (originalShell == null) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }

  if (process.env.TERM_PROGRAM !== originalTermProgram) {
    if (originalTermProgram == null) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = originalTermProgram;
  }
});

describe("hub/lib/env-detect.mjs", () => {
  it("Windows에서 pwsh를 우선 감지하고 lazy singleton 캐시를 재사용한다", async () => {
    setPlatform("win32");

    const calls = [];
    mockExecFileSync((file, args, options) => {
      calls.push({ file, args: [...args], options });
      const argv = [file, ...args].join(" ");

      if (argv === "where pwsh.exe") {
        return "C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n";
      }
      if (
        argv ===
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoLogo -NoProfile -Command $PSVersionTable.PSVersion.ToString()"
      ) {
        return "7.5.0\r\n";
      }
      if (argv === "where wt.exe") {
        return "C:\\Users\\tellang\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe\r\n";
      }
      if (argv === "where tmux") {
        throw new Error("not found");
      }

      throw new Error(`unexpected execFileSync call: ${argv}`);
    });

    const mod = await importFresh();
    const shell = mod.detectShell();
    const terminal = mod.detectTerminal();
    const multiplexer = mod.detectMultiplexer();
    const env = mod.getEnvironment();

    assert.deepEqual(shell, {
      name: "pwsh",
      path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      version: "7.5.0",
    });
    assert.deepEqual(terminal, {
      name: "windows-terminal",
      hasWt: true,
    });
    assert.deepEqual(multiplexer, {
      name: "none",
      path: null,
      installHint: "tmux: install tmux in WSL or MSYS2",
    });
    assert.equal(env.platform, "win32");
    assert.equal(env.shell, shell);
    assert.equal(env.terminal, terminal);
    assert.equal(env.multiplexer, multiplexer);
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.options.timeout, 3000);
      assert.equal(call.options.stdio, "pipe");
    }
  });

  it("Windows에서 감지 실패 시 graceful fallback과 installHint를 반환한다", async () => {
    setPlatform("win32");

    mockExecFileSync((file, args) => {
      const argv = [file, ...args].join(" ");
      if (
        argv === "where pwsh.exe" ||
        argv === "where powershell.exe" ||
        argv === "where wt.exe" ||
        argv === "where tmux"
      ) {
        throw new Error("not found");
      }
      throw new Error(`unexpected execFileSync call: ${argv}`);
    });

    const mod = await importFresh();
    assert.deepEqual(mod.getEnvironment(), {
      shell: {
        name: "powershell",
        path: "",
        version: null,
        installHint: "pwsh: winget install Microsoft.PowerShell",
      },
      terminal: {
        name: "unknown",
        hasWt: false,
        installHint: "wt: winget install Microsoft.WindowsTerminal",
      },
      multiplexer: {
        name: "none",
        path: null,
        installHint: "tmux: install tmux in WSL or MSYS2",
      },
      platform: "win32",
    });
  });

  it("macOS에서 SHELL/TERM_PROGRAM/tmux를 통합 감지한다", async () => {
    setPlatform("darwin");
    setEnv("SHELL", "/bin/zsh");
    setEnv("TERM_PROGRAM", "iTerm.app");

    mockExecFileSync((file, args) => {
      const argv = [file, ...args].join(" ");

      if (argv === "/bin/zsh -c exit 0") return "";
      if (argv === "/bin/zsh --version")
        return "zsh 5.9 (arm64-apple-darwin)\n";
      if (argv === "which tmux") return "/opt/homebrew/bin/tmux\n";

      throw new Error(`unexpected execFileSync call: ${argv}`);
    });

    const mod = await importFresh();
    assert.deepEqual(mod.getEnvironment(), {
      shell: {
        name: "zsh",
        path: "/bin/zsh",
        version: "zsh 5.9 (arm64-apple-darwin)",
      },
      terminal: {
        name: "iterm2",
        hasWt: false,
      },
      multiplexer: {
        name: "tmux",
        path: "/opt/homebrew/bin/tmux",
      },
      platform: "darwin",
    });
  });
});
