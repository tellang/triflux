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
import { pinRegistryMcpPackages } from "../../scripts/lib/mcp-package-pin.mjs";

const tempDirs = [];

afterEach(() => {
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
