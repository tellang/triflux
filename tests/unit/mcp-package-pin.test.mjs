import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  loadRegistryOrDefault,
  pinnedArgs,
  pinRegistryMcpPackages,
  splitPackageSpec,
} from "../../scripts/lib/mcp-package-pin.mjs";

const tempDirs = [];
const originalRegistryEnv = process.env.TFX_MCP_REGISTRY_PATH;

afterEach(() => {
  if (originalRegistryEnv === undefined) {
    delete process.env.TFX_MCP_REGISTRY_PATH;
  } else {
    process.env.TFX_MCP_REGISTRY_PATH = originalRegistryEnv;
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test("레지스트리 고정은 버전만 다른 항목만 바꾸고 사용자 인자와 다른 패키지는 남긴다", () => {
  const home = mkdtempSync(join(tmpdir(), "tfx-mcp-pin-"));
  tempDirs.push(home);
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".gemini/config"), { recursive: true });

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
  for (const [path, data] of Object.entries(files)) {
    writeFileSync(join(home, path), JSON.stringify(data));
  }
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

test("loadRegistryOrDefault 는 파일 없음과 손상 JSON 에서 빈 servers 를 반환하고 hub-url 항목을 제외한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "tfx-mcp-reg-"));
  tempDirs.push(dir);
  const registryPath = join(dir, "mcp-registry.json");
  process.env.TFX_MCP_REGISTRY_PATH = registryPath;

  assert.deepEqual(loadRegistryOrDefault(), { servers: {} });

  writeFileSync(registryPath, "{broken", "utf8");
  assert.deepEqual(loadRegistryOrDefault(), { servers: {} });

  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      servers: {
        legacy: { transport: "hub-url", url: "http://127.0.0.1:27888/mcp" },
        brave: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@brave/brave-search-mcp-server@2.1.4"],
        },
      },
    }),
    "utf8",
  );
  const loaded = loadRegistryOrDefault();
  assert.equal("legacy" in loaded.servers, false);
  assert.deepEqual(loaded.servers.brave.args, [
    "-y",
    "@brave/brave-search-mcp-server@2.1.4",
  ]);
});

test("loadRegistryOrDefault 는 환경변수가 비어 있으면 기본 config/mcp-registry.json 을 읽는다", () => {
  delete process.env.TFX_MCP_REGISTRY_PATH;
  const loaded = loadRegistryOrDefault();
  assert.ok(loaded.servers && typeof loaded.servers === "object");
  assert.ok("brave-search" in loaded.servers);
});

test("splitPackageSpec 과 pinnedArgs 는 스코프 패키지 버전을 안전하게 판별한다", () => {
  assert.deepEqual(splitPackageSpec("@brave/brave-search-mcp-server@2.1.4"), {
    name: "@brave/brave-search-mcp-server",
    version: "2.1.4",
  });
  assert.deepEqual(splitPackageSpec("@brave/brave-search-mcp-server"), {
    name: "@brave/brave-search-mcp-server",
    version: null,
  });
  assert.deepEqual(
    pinnedArgs(
      { command: "npx", args: ["-y", "@brave/brave-search-mcp-server@1.0.0"] },
      { command: "npx", args: ["-y", "@brave/brave-search-mcp-server@2.1.4"] },
    ),
    ["-y", "@brave/brave-search-mcp-server@2.1.4"],
  );
  assert.equal(
    pinnedArgs(
      { command: "npx", args: ["-y", "other-pkg@1.0.0"] },
      { command: "npx", args: ["-y", "@brave/brave-search-mcp-server@2.1.4"] },
    ),
    null,
  );
});
