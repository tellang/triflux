import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  cleanupLegacyMcp,
  MCP_PACKAGE_PINS,
  pinRegistryMcpPackages,
} from "../../scripts/lib/legacy-mcp-cleanup.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tfx-mcp-cleanup-"));
  dirs.push(root);
  const home = join(root, "home");
  const repoRoot = join(root, "repo");
  for (const path of [
    home,
    repoRoot,
    join(home, ".codex"),
    join(home, ".gemini", "config"),
  ])
    mkdirSync(path, { recursive: true });
  return { home, repoRoot };
}

function put(path, value) {
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

test("5개 설정의 소유 URL만 직접 연결로 이주하고 백업 후 멱등으로 끝난다", () => {
  const { home, repoRoot } = fixture();
  const claude = join(home, ".claude.json");
  const project = join(repoRoot, ".mcp.json");
  const gemini = join(home, ".gemini", "settings.json");
  const codex = join(home, ".codex", "config.toml");
  const agy = join(home, ".gemini", "config", "mcp_config.json");
  put(agy, {
    mcpServers: {
      "brave-search": { type: "http", url: "http://127.0.0.1:8101/mcp" },
    },
  });
  put(claude, {
    history: ["http://127.0.0.1:8101/mcp"],
    mcpServers: {
      "brave-search": { type: "http", url: "http://127.0.0.1:8101/mcp" },
      other: { url: "https://example.test/mcp" },
    },
    projects: {
      sample: {
        mcpServers: { context7: { url: "http://127.0.0.1:8100/mcp" } },
      },
    },
  });
  put(project, { mcpServers: { exa: { url: "http://localhost:8102/sse" } } });
  put(gemini, {
    mcpServers: { tavily: { httpUrl: "http://127.0.0.1:8103/mcp" } },
  });
  put(
    codex,
    '[mcp_servers."context7"]\nurl = "http://127.0.0.1:8100/sse"\ntransport = "sse"\n\n[mcp_servers.tfx-gateway-preflight]\ncommand = "node"\nargs = ["/opt/triflux/scripts/codex-gateway-preflight.mjs"]\n\n[model_providers.keep]\nname = "keep"\n\n[mcp_servers.brave-search]\nurl = "http://127.0.0.1:8101/mcp"\n# no final newline',
  );
  mkdirSync(join(home, ".config/triflux"), { recursive: true });
  put(
    join(home, ".config/triflux/secrets.env"),
    "BRAVE_API_KEY=fixture-secret-value\n",
  );
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "ps") return "";
    throw new Error("unexpected command");
  };
  const options = {
    home,
    repoRoot,
    platform: "darwin",
    run,
    uid: 500,
    env: {},
  };
  const result = cleanupLegacyMcp(options);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, 8);
  assert.equal(result.backups.length, 5);
  assert.ok(calls.every(([command]) => command === "ps"));
  assert.ok(result.warnings.some((warning) => warning.includes("secrets.env")));
  for (const file of [claude, project, gemini, codex])
    assert.ok(!readFileSync(file, "utf8").includes("fixture-secret-value"));
  const claudeServers = JSON.parse(readFileSync(claude, "utf8")).mcpServers;
  assert.deepEqual(claudeServers["brave-search"], {
    command: "npx",
    args: ["-y", "@brave/brave-search-mcp-server@2.1.4"],
    env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
  });
  assert.deepEqual(claudeServers.other, { url: "https://example.test/mcp" });
  assert.deepEqual(
    JSON.parse(readFileSync(agy, "utf8")).mcpServers["brave-search"],
    { command: "npx", args: ["-y", "@brave/brave-search-mcp-server@2.1.4"] },
  );
  assert.equal(
    JSON.parse(readFileSync(claude, "utf8")).projects.sample.mcpServers.context7
      .command,
    "npx",
  );
  assert.equal(
    JSON.parse(readFileSync(project, "utf8")).mcpServers.exa.command,
    "npx",
  );
  assert.equal(
    JSON.parse(readFileSync(gemini, "utf8")).mcpServers.tavily.env
      .TAVILY_API_KEY,
    "${TAVILY_API_KEY}",
  );
  assert.match(readFileSync(codex, "utf8"), /env_vars = \[\]\n/);
  assert.match(readFileSync(codex, "utf8"), /env_vars = \["BRAVE_API_KEY"\]/);
  assert.doesNotMatch(readFileSync(codex, "utf8"), /transport =/);
  assert.doesNotMatch(readFileSync(codex, "utf8"), /tfx-gateway-preflight/);
  assert.equal(cleanupLegacyMcp(options).migrated, 0);
  assert.equal(
    readdirSync(join(home, ".codex")).filter((name) =>
      name.includes("tfx-bak-"),
    ).length,
    1,
  );
});

test("빈 설정 파일은 건너뛰고 허브 정리와 같은 사용자 파일을 이주한다", () => {
  const { home, repoRoot } = fixture();
  put(join(home, ".gemini", "config", "mcp_config.json"), "");
  const claudeMcp = join(home, ".claude", "mcp.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  put(claudeMcp, {
    mcpServers: {
      "brave-search": { type: "http", url: "http://127.0.0.1:8101/mcp" },
    },
  });
  const result = cleanupLegacyMcp({
    home,
    repoRoot,
    platform: "darwin",
    run: (command) => {
      if (command === "ps") return "";
      throw new Error("unexpected command");
    },
    uid: 500,
    env: { BRAVE_API_KEY: "x" },
  });
  assert.equal(result.ok, true, result.warnings.join("\n"));
  assert.equal(
    JSON.parse(readFileSync(claudeMcp, "utf8")).mcpServers["brave-search"]
      .command,
    "npx",
  );
});

test("symlink 별칭은 한 번만 이주하고 뒤의 설정도 이어서 이주한다", () => {
  const { home, repoRoot } = fixture();
  const claude = join(home, ".claude.json");
  put(claude, {
    mcpServers: { context7: { url: "http://127.0.0.1:8100/mcp" } },
  });
  mkdirSync(join(home, ".claude"), { recursive: true });
  symlinkSync(claude, join(home, ".claude", "mcp.json"));
  put(
    join(home, ".codex", "config.toml"),
    '[mcp_servers.context7]\nurl = "http://127.0.0.1:8100/mcp"\n',
  );
  const result = cleanupLegacyMcp({
    home,
    repoRoot,
    platform: "darwin",
    run: (command) => {
      if (command === "ps") return "";
      throw new Error("unexpected command");
    },
    uid: 500,
    env: {},
  });
  assert.equal(result.ok, true, result.warnings.join("\n"));
  assert.equal(result.backups.length, 2);
  assert.match(
    readFileSync(join(home, ".codex", "config.toml"), "utf8"),
    /command = "npx"/,
  );
});

test("형식이 다른 설정이 같은 파일이면 쓰기와 해제 없이 멈춘다", () => {
  const { home, repoRoot } = fixture();
  const gemini = join(home, ".gemini", "settings.json");
  const original = JSON.stringify({
    mcpServers: { "brave-search": { url: "http://127.0.0.1:8101/mcp" } },
  });
  put(gemini, original);
  symlinkSync(gemini, join(home, ".gemini", "config", "mcp_config.json"));
  const result = cleanupLegacyMcp({
    home,
    repoRoot,
    platform: "darwin",
    run: () => {
      throw new Error("unexpected command");
    },
    uid: 500,
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.teardown.attempted, false);
  assert.equal(readFileSync(gemini, "utf8"), original);
});

test("깨진 설정과 소유 불명 URL은 원본을 보존하고 해제를 막는다", () => {
  const { home, repoRoot } = fixture();
  const claude = join(home, ".claude.json");
  const project = join(repoRoot, ".mcp.json");
  put(claude, "{broken");
  put(project, {
    mcpServers: { custom: { url: "http://127.0.0.1:8101/mcp" } },
  });
  const calls = [];
  const result = cleanupLegacyMcp({
    home,
    repoRoot,
    platform: "darwin",
    run: (...args) => calls.push(args),
  });
  assert.equal(result.ok, false);
  assert.equal(result.teardown.attempted, false);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(claude, "utf8"), "{broken");
  assert.equal(
    JSON.parse(readFileSync(project, "utf8")).mcpServers.custom.url,
    "http://127.0.0.1:8101/mcp",
  );
  assert.equal(cleanupLegacyMcp({ home, repoRoot }).skipped, true);
  put(claude, {});
  put(project, {});
  const codex = join(home, ".codex/config.toml");
  const indented =
    '[mcp_servers.context7]\nurl = "http://127.0.0.1:8100/mcp"\n  [mcp_servers.other]\nurl = "https://example.test/mcp"\n';
  put(codex, indented);
  const preserved = cleanupLegacyMcp({
    home,
    repoRoot,
    run: (...args) => calls.push(args),
  });
  assert.equal(preserved.ok, false);
  assert.equal(readFileSync(codex, "utf8"), indented);
  assert.deepEqual(calls, []);
});

test("서비스 해제 실패를 보존하고 성공 후에만 소유 프로세스를 종료한다", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const failure of platform === "linux"
      ? ["verify", "reload", false]
      : [true, false]) {
      const { home, repoRoot } = fixture();
      const claude = join(home, ".claude.json");
      put(claude, {
        mcpServers: { "brave-search": { url: "http://127.0.0.1:8101/mcp" } },
      });
      const registration =
        platform === "darwin"
          ? join(home, "Library/LaunchAgents/com.tellang.mcp-gateway.plist")
          : platform === "linux"
            ? join(home, ".config/systemd/user/mcp-gateway.service")
            : null;
      const wrapper = join(home, ".local/bin/mcp-gateway-wrapper.sh");
      const plist = {
        Label: "com.tellang.mcp-gateway",
        ProgramArguments: ["/bin/bash", wrapper],
      };
      if (registration) {
        mkdirSync(join(registration, ".."), { recursive: true });
        put(
          registration,
          platform === "darwin"
            ? plist
            : '[Unit]\nDescription=Triflux MCP Gateway\n[Service]\nExecStart="/usr/bin/node" "/opt/triflux/scripts/mcp-gateway-start.mjs"\n',
        );
      }
      if (platform === "darwin") {
        mkdirSync(join(wrapper, ".."), { recursive: true });
        put(
          wrapper,
          "#!/bin/bash\nexec '/usr/bin/node' '/opt/triflux/scripts/mcp-gateway-start.mjs'\n",
        );
      }
      let loaded = true;
      let alive = true;
      const calls = [];
      const commandLine =
        "node /npm/supergateway/dist/index.js --stdio npx -y @brave/brave-search-mcp-server --port 8101 --outputTransport streamableHttp --stateful --streamableHttpPath /mcp --healthEndpoint /healthz --cors http://localhost";
      const run = (command, args) => {
        calls.push([command, args]);
        if (command === "plutil") return JSON.stringify(plist);
        if (command === "launchctl") {
          if (args[0] === "print") {
            if (loaded) return "loaded";
            throw new Error("Could not find service");
          }
          if (failure) throw new Error("bootout failed");
          loaded = false;
          return "";
        }
        if (command === "systemctl") {
          if (args.includes("show")) {
            if (failure === "verify") throw new Error("bus unavailable");
            return "ActiveState=inactive\nUnitFileState=disabled\n";
          }
          if (args.includes("daemon-reload") && failure === "reload")
            throw new Error("reload failed");
          return "";
        }
        if (command === "ps")
          return args[0] === "-p"
            ? "start-time"
            : alive
              ? `12345 500 ${commandLine}\n12346 500 node unrelated.js`
              : "";
        if (command === "powershell") {
          if (args[2].includes("GetTasks(1)"))
            return JSON.stringify(
              loaded
                ? {
                    xml: "<Task />",
                    command: '"C:\\node.exe"',
                    args: '"C:\\triflux\\scripts\\mcp-gateway-start.mjs"',
                    actions: 1,
                  }
                : null,
            );
          if (args[2].includes("DeleteTask")) {
            assert.ok(args[2].includes("$t.Stop(0)"));
            if (failure) throw new Error("access denied");
            loaded = false;
            return "";
          }
          return JSON.stringify(
            alive
              ? [{ pid: "12345", command: commandLine, started: "start-time" }]
              : [],
          );
        }
        if (command === "kill" || command === "taskkill") {
          assert.equal(
            JSON.parse(readFileSync(claude, "utf8")).mcpServers["brave-search"]
              .command,
            "npx",
          );
          if (registration) assert.equal(existsSync(registration), false);
          assert.ok(args.includes("12345"));
          alive = false;
          return "";
        }
        throw new Error(`unexpected command: ${command}`);
      };
      const options = { home, repoRoot, platform, env: {}, run, uid: 500 };
      const result = cleanupLegacyMcp(options);
      assert.equal(result.teardown.attempted, true, `${platform} attempted`);
      assert.equal(result.ok, !failure, `${platform} result`);
      assert.equal(
        result.teardown.verified,
        !failure,
        `${platform} verification`,
      );
      assert.equal(alive, Boolean(failure), `${platform} process`);
      if (registration)
        assert.equal(existsSync(registration), Boolean(failure));
      if (platform === "darwin")
        assert.ok(
          calls.some(
            ([cmd, args]) => cmd === "launchctl" && args[0] === "bootout",
          ),
        );
      assert.equal(cleanupLegacyMcp(options).ok, !failure, `${platform} retry`);
    }
  }
  for (const restart of [false, true]) {
    const { home, repoRoot } = fixture();
    let stopped = false;
    const calls = [];
    const commandLine = "node /opt/triflux/scripts/mcp-gateway-start.mjs";
    const result = cleanupLegacyMcp({
      home,
      repoRoot,
      platform: "linux",
      uid: 500,
      run: (command, args) => {
        calls.push([command, args]);
        if (command === "kill") {
          stopped = true;
          return "";
        }
        if (args[0] === "-axo")
          return `${stopped && restart ? "23456" : "12345"} 500 ${commandLine}`;
        if (stopped && !restart) {
          const error = new Error("gone");
          error.status = 1;
          throw error;
        }
        return "start-time";
      },
    });
    assert.equal(stopped, true);
    assert.equal(result.ok, !restart);
    assert.equal(result.teardown.verified, !restart);
    assert.deepEqual(
      calls.filter(([command]) => command === "kill"),
      [["kill", ["-TERM", "12345"]]],
    );
  }
});

test("이주가 써 넣는 MCP 패키지는 버전이나 커밋으로 고정한다", () => {
  for (const [name, spec] of Object.entries(MCP_PACKAGE_PINS))
    assert.match(spec, /@(?:\d+\.\d+\.\d+|[0-9a-f]{40})$/, name);
  // 레지스트리와 버전이 다르면 doctor 가 이주한 항목을 불일치로 본다.
  const registry = JSON.parse(
    readFileSync(new URL("../../config/mcp-registry.json", import.meta.url)),
  );
  assert.deepEqual(registry.servers["brave-search"].args, [
    "-y",
    MCP_PACKAGE_PINS["brave-search"],
  ]);
});

test("레지스트리 고정은 버전만 다른 항목만 바꾸고 사용자 인자와 다른 패키지는 남긴다", () => {
  const { home } = fixture();
  const registry = {
    servers: {
      brave: {
        command: "npx",
        args: ["-y", "@brave/brave-search-mcp-server@2.1.4"],
        targets: [],
      },
    },
  };
  const entry = (args) => ({ mcpServers: { brave: { command: "npx", args } } });
  const files = {
    ".claude.json": entry(["-y", "@brave/brave-search-mcp-server@2.0.0"]),
    ".mcp.json": entry(["-y", "@brave/brave-search-mcp-server", "--x"]),
    ".gemini/config/mcp_config.json": entry(["-y", "brave-search-fork"]),
  };
  for (const [path, data] of Object.entries(files))
    writeFileSync(join(home, path), JSON.stringify(data));
  writeFileSync(
    join(home, ".codex/config.toml"),
    '  [mcp_servers.brave]\ncommand = "npx"\n"args" = ["-y", "@brave/brave-search-mcp-server"]\n',
  );
  const result = pinRegistryMcpPackages({ home, registry });
  assert.equal(result.pinned, 2);
  const args = (path) =>
    JSON.parse(readFileSync(join(home, path), "utf8")).mcpServers.brave.args;
  assert.deepEqual(args(".claude.json"), registry.servers.brave.args);
  assert.deepEqual(args(".mcp.json"), files[".mcp.json"].mcpServers.brave.args);
  assert.deepEqual(
    args(".gemini/config/mcp_config.json"),
    files[".gemini/config/mcp_config.json"].mcpServers.brave.args,
  );
  assert.match(
    readFileSync(join(home, ".codex/config.toml"), "utf8"),
    /"args" = \["-y","@brave\/brave-search-mcp-server@2\.1\.4"\]/,
  );
  assert.equal(pinRegistryMcpPackages({ home, registry }).changed, false);
});
