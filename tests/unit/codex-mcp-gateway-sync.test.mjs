// tests/unit/codex-mcp-gateway-sync.test.mjs
// codex-mcp-gateway-sync.mjs — /sse → /mcp 업그레이드 마이그레이션 회귀 가드
//
// 회귀 시나리오: v10.27.0 이하에서 gateway 가 /sse URL 을 config.toml 에 썼다.
// 데몬은 이제 streamableHttp /mcp 만 서빙하므로, 업그레이드 후에는 stale /sse 가
// 반드시 /mcp 로 재작성돼야 한다. hasUrl 만 보고 스킵하면 dead /sse 가 남는다.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const ROOT = process.cwd();
const SYNC_PATH = join(ROOT, "scripts", "codex-mcp-gateway-sync.mjs");

const syncModule = await import(`${SYNC_PATH}?t=${Date.now()}`);
const serversModule = await import(
  `${join(ROOT, "scripts", "lib", "mcp-gateway-servers.mjs")}?t=${Date.now()}`
);

const { enableGateway, getStatus } = syncModule;
const { SERVERS } = serversModule;

// context7 는 8100 → http://127.0.0.1:8100/mcp 가 기대 endpoint.
const CONTEXT7 = SERVERS.find((s) => s.name === "context7");
const EXPECTED_MCP_URL = `http://127.0.0.1:${CONTEXT7.port}/mcp`;
const STALE_SSE_URL = `http://127.0.0.1:${CONTEXT7.port}/sse`;

describe("codex-mcp-gateway-sync — stale /sse upgrade migration", () => {
  let workDir;
  let configPath;
  let prevOptIn;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "tfx-gateway-sync-test-"));
    configPath = join(workDir, "config.toml");
    // 보호 환경(NODE_ENV=test) 가드를 우회해 실제 재작성 로직을 실행한다.
    prevOptIn = process.env.TFX_CODEX_CONFIG_SYNC;
    process.env.TFX_CODEX_CONFIG_SYNC = "1";
  });

  after(() => {
    if (prevOptIn === undefined) delete process.env.TFX_CODEX_CONFIG_SYNC;
    else process.env.TFX_CODEX_CONFIG_SYNC = prevOptIn;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("enableGateway rewrites a stale /sse url to the /mcp endpoint instead of skipping", () => {
    // v10.27.0 이 남긴 stale /sse URL 블록
    writeFileSync(
      configPath,
      `[mcp_servers.context7]\nurl = "${STALE_SSE_URL}"\n`,
      "utf8",
    );

    const result = enableGateway(configPath);

    const after = readFileSync(configPath, "utf8");
    assert.ok(
      after.includes(`url = "${EXPECTED_MCP_URL}"`),
      `stale /sse must be rewritten to ${EXPECTED_MCP_URL}; got:\n${after}`,
    );
    assert.doesNotMatch(
      after,
      /url\s*=\s*"[^"]*\/sse"/,
      `no /sse url may survive enableGateway; got:\n${after}`,
    );
    // 스킵이 아니라 변경(또는 마이그레이션)으로 카운트돼야 한다.
    assert.ok(
      result.changed >= 1,
      `stale /sse block must count as changed, not skipped: ${JSON.stringify(result)}`,
    );
  });

  it("getStatus does not report a stale /sse url as a healthy http server", () => {
    writeFileSync(
      configPath,
      `[mcp_servers.context7]\nurl = "${STALE_SSE_URL}"\n`,
      "utf8",
    );

    const { servers } = getStatus(configPath);
    const ctx = servers.find((s) => s.name === "context7");
    assert.ok(ctx, "context7 must appear in status");
    assert.notStrictEqual(
      ctx.mode,
      "http",
      `stale /sse must not be classified as a healthy http server; got mode=${ctx.mode}`,
    );
  });

  it("enableGateway leaves a correct /mcp url untouched (no false migration)", () => {
    writeFileSync(
      configPath,
      `[mcp_servers.context7]\nurl = "${EXPECTED_MCP_URL}"\n`,
      "utf8",
    );

    const result = enableGateway(configPath);
    const after = readFileSync(configPath, "utf8");
    assert.ok(
      after.includes(`url = "${EXPECTED_MCP_URL}"`),
      "correct /mcp url must remain present",
    );
    // preflight 추가는 changed 를 올릴 수 있으므로 context7 자체는 skip 으로 분류돼야 한다.
    assert.ok(
      result.skipped >= 1,
      `correct /mcp url should be skipped, not migrated: ${JSON.stringify(result)}`,
    );
  });
});
