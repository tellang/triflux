import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { prepareWorkerMcp } from "../../hub/lib/worker-mcp.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "worker-mcp-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CACHE_HOME: join(home, "cache"),
    TMPDIR: home,
  };
  const put = (path, data) => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };
  put(
    ".codex/config.toml",
    '[mcp_servers.docs]\nurl="https://mcp.context7.com/mcp?secret=local"\nenabled_tools=["query-docs"]\ndisabled_tools=["resolve-library-id"]\n[mcp_servers.other]\nurl="https://other.example/mcp"\n',
  );
  put(
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://mcp.context7.com/mcp?secret=local",
          headers: { Authorization: "SECRET" },
        },
      },
    }),
  );
  const recommendation = {
    cli: "codex",
    status: "recommended",
    recommendations: [{ id: "local:context7", installationStatus: "present" }],
    applied: false,
  };
  const input = {
    cli: "codex",
    cwd: home,
    recommendation,
    profileWasAuto: true,
    policy: {
      allowedServers: ["context7"],
      codexConfigOverrides: [
        "mcp_servers.docs.enabled=false",
        "mcp_servers.other.enabled=false",
      ],
    },
    transport: "exec",
  };
  return { home, env, put, input };
}

test("Codex uses registered alias, preserves original tool restrictions and never synthesizes plugin transport", (t) => {
  const f = fixture(t);
  f.put(
    ".codex/config.toml",
    `${readFileSync(join(f.home, ".codex/config.toml"), "utf8")}[mcp_servers.plugin_without_transport]\n`,
  );
  const result = prepareWorkerMcp(f.input, { env: f.env });
  assert.equal(result.metadata.status, "prepared");
  assert.deepEqual(result.metadata.servers, ["docs"]);
  assert.deepEqual(result.codexConfigOverrides, [
    "mcp_servers.docs.enabled=true",
    "mcp_servers.other.enabled=false",
  ]);
  assert.equal(result.metadata.runtimeConfirmed, false);
  assert.equal(result.metadata.toolVerified, false);
  assert.equal(result.metadata.appliedTo, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET|secret=|enabled_tools=\[\]/,
  );
});

for (const [label, change, reason] of [
  [
    "explicit profile",
    (f) => {
      f.input.profileWasAuto = false;
    },
    "explicit_mcp_profile",
  ],
  [
    "explicit config",
    (f) => {
      f.input.explicitConfig = true;
    },
    "explicit_mcp_config",
  ],
  [
    "shared daemon",
    (f) => {
      f.input.transport = "daemon";
    },
    "codex_transport_isolation_unverified",
  ],
  [
    "disabled",
    (f) => {
      f.put(
        ".codex/config.toml",
        '[mcp_servers.docs]\nurl="https://mcp.context7.com/mcp"\nenabled=false\n',
      );
    },
    "registration_disabled",
  ],
  [
    "missing",
    (f) => {
      f.put(".codex/config.toml", "");
    },
    "local_registration_missing",
  ],
  [
    "duplicate endpoint",
    (f) => {
      f.put(
        ".codex/config.toml",
        '[mcp_servers.one]\nurl="https://mcp.context7.com/mcp?a=1"\n[mcp_servers.two]\nurl="https://mcp.context7.com/mcp?a=2"\n',
      );
    },
    "registration_ambiguous",
  ],
  [
    "conflicting project",
    (f) => {
      f.input.cwd = join(f.home, "project");
      f.put(
        "project/.codex/config.toml",
        '[mcp_servers.docs]\nurl="https://different.example/mcp"\n',
      );
    },
    "registration_ambiguous",
  ],
  [
    "untrusted Codex project",
    (f) => {
      f.input.cwd = join(f.home, "project");
      f.put(".codex/config.toml", "");
      f.put(
        "project/.codex/config.toml",
        '[mcp_servers.docs]\nurl="https://mcp.context7.com/mcp"\n',
      );
    },
    "project_approval_unverified",
  ],
  [
    "present hint without identity",
    (f) => {
      f.input.recommendation.recommendations[0].id = "official:invented";
    },
    "catalog_identity_unavailable",
  ],
  [
    "AGY",
    (f) => {
      f.input.cli = "agy";
    },
    "agy_server_session_isolation_unverified",
  ],
  [
    "native Claude",
    (f) => {
      f.input.cli = "claude-native";
    },
    "native_metadata_only",
  ],
]) {
  test(`${label} is deferred without widening existing configuration`, (t) => {
    const f = fixture(t);
    change(f);
    const result = prepareWorkerMcp(f.input, { env: f.env });
    assert.equal(result.metadata.status, "deferred");
    assert.ok(
      result.metadata.reasons.includes(reason),
      JSON.stringify(result.metadata),
    );
    assert.deepEqual(
      result.codexConfigOverrides,
      f.input.policy.codexConfigOverrides,
    );
    assert.equal(result.configFile, null);
  });
}

test("Claude private config copies only the original definition and cleanup owns only its directory", (t) => {
  const f = fixture(t);
  const result = prepareWorkerMcp(
    { ...f.input, cli: "claude" },
    { env: f.env },
  );
  t.after(result.cleanup);
  assert.equal(result.metadata.status, "prepared");
  assert.equal(statSync(dirname(result.configFile)).mode & 0o777, 0o700);
  assert.equal(statSync(result.configFile).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(readFileSync(result.configFile, "utf8")),
    JSON.parse(readFileSync(join(f.home, ".claude.json"), "utf8")),
  );
  assert.doesNotMatch(
    JSON.stringify(result.metadata),
    /SECRET|secret=|headers|command/,
  );
  result.cleanup();
  assert.equal(existsSync(result.configFile), false);
  assert.equal(existsSync(join(f.home, ".claude.json")), true);
});

test("Claude project approval cannot be granted by checked-in settings", (t) => {
  const f = fixture(t);
  f.put(".claude.json", "{}");
  f.put(
    "project/.mcp.json",
    '{"mcpServers":{"docs":{"url":"https://mcp.context7.com/mcp"}}}',
  );
  f.put("project/.claude/settings.json", '{"enableAllProjectMcpServers":true}');
  const result = prepareWorkerMcp(
    { ...f.input, cli: "claude", cwd: join(f.home, "project") },
    { env: f.env },
  );
  assert.ok(result.metadata.reasons.includes("project_approval_unverified"));
  assert.equal(result.configFile, null);
});

test("Claude explicit project rejection overrides prior approval", (t) => {
  const f = fixture(t);
  f.put(".claude/settings.local.json", '{"disabledMcpjsonServers":["docs"]}');
  const result = prepareWorkerMcp(
    { ...f.input, cli: "claude" },
    { env: f.env },
  );
  assert.ok(result.metadata.reasons.includes("registration_disabled"));
});

test("unknown tool list remains unset and original deny-all survives automatic profiles", async (t) => {
  const { getCodexMcpConfig, buildMcpPolicy } = await import(
    "../../scripts/lib/mcp-filter.mjs"
  );
  const unknown = getCodexMcpConfig({
    availableServers: ["custom"],
    allowedServers: ["custom"],
    requestedProfile: "default",
  });
  assert.deepEqual(unknown.mcp_servers.custom, { enabled: true });
  const f = fixture(t);
  f.put(
    ".codex/config.toml",
    '[mcp_servers.context7]\nurl="https://mcp.context7.com/mcp"\nenabled_tools=[]\n[mcp_servers.exa]\nurl="https://mcp.exa.ai/mcp"\nenabled=false\n',
  );
  const policy = buildMcpPolicy({
    cliType: "codex",
    requestedProfile: "explore",
    codexConfig: join(f.home, ".codex/config.toml"),
  });
  assert.deepEqual(policy.codexConfig.mcp_servers.context7.enabled_tools, []);
  assert.equal(policy.codexConfig.mcp_servers.exa.enabled, false);
});

test("explicit server manifest prevents recommendation from widening the enabled set", (t) => {
  const f = fixture(t);
  f.put(".claude/cache/mcp-enabled.json", '{"enabled":[]}');
  const result = prepareWorkerMcp(f.input, { env: f.env });
  assert.ok(result.metadata.reasons.includes("explicit_mcp_manifest"));
  assert.deepEqual(
    result.codexConfigOverrides,
    f.input.policy.codexConfigOverrides,
  );
});

test("a trusted Claude project still requires MCP approval from user or local settings", (t) => {
  const f = fixture(t);
  const cwd = join(f.home, "project");
  f.put(
    ".claude.json",
    JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
  );
  f.put(
    "project/.mcp.json",
    '{"mcpServers":{"docs":{"url":"https://mcp.context7.com/mcp"}}}',
  );
  const input = { ...f.input, cli: "claude", cwd };
  assert.ok(
    prepareWorkerMcp(input, { env: f.env }).metadata.reasons.includes(
      "project_approval_unverified",
    ),
  );
  f.put(
    "project/.claude/settings.local.json",
    '{"enabledMcpjsonServers":["docs"]}',
  );
  const approved = prepareWorkerMcp(input, { env: f.env });
  t.after(approved.cleanup);
  assert.equal(approved.metadata.status, "prepared");
});

test("quoted registered name and original deny-all remain valid TOML overrides", (t) => {
  const f = fixture(t);
  f.put(
    ".codex/config.toml",
    '[mcp_servers."my.docs"]\nurl="https://mcp.context7.com/mcp"\nenabled_tools=[]\n',
  );
  const result = prepareWorkerMcp(f.input, { env: f.env });
  assert.deepEqual(result.codexConfigOverrides, [
    'mcp_servers."my.docs".enabled=true',
  ]);
  assert.deepEqual(result.metadata.servers, ["my.docs"]);
});
