// 테스트마다 MCP override 대상 config를 격리한다.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_CONFIG = `model = "gpt-5.5"
model_reasoning_effort = "high"

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.brave-search]
url = "http://127.0.0.1:8101/mcp"

[mcp_servers.tfx-hub]
url = "http://127.0.0.1:27888/mcp"

[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"

[mcp_servers.serena]
url = "http://127.0.0.1:8105/mcp"

`;

/**
 * Create a unique, isolated codex config.toml for one test file and return its
 * path (point TFX_CODEX_CONFIG at it). Call once per test file at module scope.
 *
 * @returns {{ path: string, dir: string, cleanup: () => void }}
 */
export function makeIsolatedCodexConfig() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-codex-cfg-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, FIXTURE_CONFIG);
  return {
    path,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
