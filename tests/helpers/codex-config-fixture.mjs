// tests/helpers/codex-config-fixture.mjs
//
// Integration tests that run the full scripts/tfx-route.sh with a codex agent +
// a non-"none" mcp_profile (e.g. "minimal") trigger tfx-route's MCP config-swap,
// which by default mutates the REAL ~/.codex/config.toml and backs it up to a
// shared `${config}.pre-exec`. Under `--test-concurrency`, multiple such test
// files swap the same real config + shared backup at once → read-modify-write
// race → the user's real config can be left filtered/corrupted (node_repl,
// gbrain, auth headers dropped) and the swap-restore fails (flaky exit 1).
//
// Give each test FILE its own throwaway config via the TFX_CODEX_CONFIG seam
// (scripts/tfx-route.sh) so the swap operates on an isolated copy — never the
// real ~/.codex, and never shared across concurrent files.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must exceed tfx-route's 500-byte corruption guard so the swap path actually
// runs (instead of bailing). Carries context7 + brave-search so the "minimal"
// allowed-server filter has matches to keep.
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

# Isolated throwaway codex config fixture for tfx-route integration tests.
# This file is created under the OS tmpdir and is NEVER the real
# ~/.codex/config.toml. The padding below keeps it above the 500-byte
# config-swap corruption guard so the swap executes hermetically.
[fixture]
purpose = "tfx-route integration test isolation"
note = "the config-swap mutates this copy, leaving the developer's real codex config untouched even when many test files run concurrently"
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
