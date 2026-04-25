import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, before, describe, it } from "node:test";

import {
  migrateLegacyHosts,
  readHost,
  readHosts,
  resolveHost,
  userStateHostsPath,
} from "../../hub/lib/hosts-compat.mjs";

const TEMP_DIRS = [];
const PROJECT_ROOT = resolve(".");
const TFX_REMOTE_SKILL = join(PROJECT_ROOT, "skills", "tfx-remote", "SKILL.md");

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-remote-matrix-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeJson(repoRoot, relativePath, payload) {
  const target = join(repoRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload, null, 2));
  return target;
}

// Pre-existing matrix tests rely on source-tree fixtures and predate the
// user-state path introduced in issue #178. Disable user-state lookup so
// candidatePaths() only consults source-tree fixtures inside the temp repo.
const SAVED_ENV = {
  TFX_HOSTS_USER_STATE_DISABLE: process.env.TFX_HOSTS_USER_STATE_DISABLE,
  TFX_HOSTS_USER_STATE: process.env.TFX_HOSTS_USER_STATE,
};

before(() => {
  process.env.TFX_HOSTS_USER_STATE_DISABLE = "1";
});

describe("Phase 4b integration — tfx-remote public subcommands", () => {
  it("documents the consolidated public subcommand surface", () => {
    const skill = readFileSync(TFX_REMOTE_SKILL, "utf8");

    const expectedSubcommands = [
      "setup",
      "spawn",
      "list",
      "attach",
      "send",
      "resume",
      "kill",
      "probe",
    ];

    for (const subcommand of expectedSubcommands) {
      assert.ok(
        skill.includes(`| \`${subcommand}`),
        `missing subcommand row: ${subcommand}`,
      );
    }

    assert.match(skill, /hosts-compat\.mjs/u);
    assert.match(
      skill,
      /setup,\s*spawn,\s*list,\s*attach,\s*send,\s*resume,\s*kill,\s*probe/u,
    );
  });
});

describe("Phase 4b integration — hosts v1/v2 compatibility matrix", () => {
  const cases = [
    {
      name: "v1 legacy schema from references/hosts.json",
      location: join("references", "hosts.json"),
      query: "desktop",
      sshAddress: "SSAFY@desk.ts.net",
      raw: {
        hosts: {
          ultra4: {
            description: "legacy windows host",
            aliases: ["desktop", "ultra"],
            default_dir: "~/Desktop/Projects",
            os: "win32",
            ssh_user: "SSAFY",
            tailscale: {
              ip: "100.64.0.1",
              dns: "desk.ts.net",
            },
            capabilities: ["codex", "claude"],
          },
        },
        default_host: "ultra4",
        triggers: ["원격에서"],
      },
      expected: {
        os: "windows",
        ssh_user: "SSAFY",
        capabilities: ["codex", "claude"],
        capabilities_v2: {
          codex: true,
          claude: true,
        },
        default_host: "ultra4",
        trigger: "원격에서",
      },
    },
    {
      name: "v2 additive schema from packages/triflux/references/hosts.json",
      location: join("packages", "triflux", "references", "hosts.json"),
      query: "mac",
      sshAddress: "tellang@mac.ts.net",
      raw: {
        hosts: {
          m2: {
            description: "modern mac host",
            aliases: ["mac", "mba"],
            default_dir: "~/projects",
            os: "darwin kernel",
            ssh: {
              user: "tellang",
            },
            tailscale: {
              ip: "100.64.0.2",
              dns: "mac.ts.net",
              ssh_mode: "ssh-over-vpn",
            },
            capabilities_v2: {
              codex: true,
              gemini: true,
              high_memory: true,
            },
            last_probe: {
              ok: true,
              ts: "2026-04-18T12:34:56Z",
              latency_ms: 143,
            },
          },
        },
        default_host: "m2",
        triggers: ["다른 머신에서"],
      },
      expected: {
        os: "darwin",
        ssh_user: "tellang",
        capabilities: ["codex", "gemini", "high-memory"],
        capabilities_v2: {
          codex: true,
          gemini: true,
          high_memory: true,
        },
        default_host: "m2",
        trigger: "다른 머신에서",
        last_probe: {
          ok: true,
          ts: "2026-04-18T12:34:56Z",
          latency_ms: 143,
        },
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const repoRoot = makeTempRepo();
      const targetPath = writeJson(repoRoot, testCase.location, testCase.raw);

      const registry = readHosts(repoRoot);
      const hostName = Object.keys(testCase.raw.hosts)[0];
      const host = registry.hosts[hostName];

      assert.equal(relative(repoRoot, registry.path), testCase.location);
      assert.equal(resolve(targetPath), resolve(registry.path));
      assert.equal(registry.default_host, testCase.expected.default_host);
      assert.equal(registry.triggers[0], testCase.expected.trigger);

      assert.ok(host, "normalized host should exist");
      assert.equal(host.name, hostName);
      assert.equal(host.os, testCase.expected.os);
      assert.equal(host.ssh_user, testCase.expected.ssh_user);
      assert.equal(host.ssh.user, testCase.expected.ssh_user);
      assert.deepEqual(host.capabilities, testCase.expected.capabilities);
      assert.deepEqual(host.capabilities_v2, testCase.expected.capabilities_v2);

      if (testCase.expected.last_probe) {
        assert.deepEqual(host.last_probe, testCase.expected.last_probe);
      } else {
        assert.equal(host.last_probe, null);
      }

      assert.equal(readHost(testCase.query, repoRoot)?.name, hostName);
      assert.equal(resolveHost(testCase.query, repoRoot)?.name, hostName);
      assert.equal(resolveHost(testCase.sshAddress, repoRoot)?.name, hostName);
      assert.equal(resolveHost(host.tailscale.ip, repoRoot)?.name, hostName);
      assert.equal(resolveHost(host.tailscale.dns, repoRoot)?.name, hostName);
    });
  }
});

describe("issue #178 — hosts.json user-state migration", () => {
  function sandboxUserState() {
    const dir = mkdtempSync(join(tmpdir(), "tfx-userstate-"));
    TEMP_DIRS.push(dir);
    delete process.env.TFX_HOSTS_USER_STATE_DISABLE;
    process.env.TFX_HOSTS_USER_STATE = join(dir, "triflux", "hosts.json");
    return process.env.TFX_HOSTS_USER_STATE;
  }

  afterEach(() => {
    process.env.TFX_HOSTS_USER_STATE_DISABLE =
      SAVED_ENV.TFX_HOSTS_USER_STATE_DISABLE ?? "1";
    if (SAVED_ENV.TFX_HOSTS_USER_STATE === undefined) {
      delete process.env.TFX_HOSTS_USER_STATE;
    } else {
      process.env.TFX_HOSTS_USER_STATE = SAVED_ENV.TFX_HOSTS_USER_STATE;
    }
  });

  it("userStateHostsPath() returns platform-appropriate path by default", () => {
    delete process.env.TFX_HOSTS_USER_STATE_DISABLE;
    delete process.env.TFX_HOSTS_USER_STATE;
    const path = userStateHostsPath();
    if (process.platform === "win32") {
      assert.match(path, /triflux[\\/]hosts\.json$/);
    } else {
      assert.match(path, /\.config[\\/]triflux[\\/]hosts\.json$/);
    }
  });

  it("TFX_HOSTS_USER_STATE_DISABLE=1 short-circuits to null", () => {
    process.env.TFX_HOSTS_USER_STATE_DISABLE = "1";
    delete process.env.TFX_HOSTS_USER_STATE;
    assert.equal(userStateHostsPath(), null);
  });

  it("migrates source-tree hosts.json into user-state on first read", () => {
    const userPath = sandboxUserState();
    const repoRoot = makeTempRepo();
    writeJson(repoRoot, "references/hosts.json", {
      hosts: { ultra4: { description: "legacy", os: "win32" } },
    });

    const result = migrateLegacyHosts(repoRoot);

    assert.equal(result.migrated, true);
    assert.equal(result.to, userPath);
    assert.ok(readFileSync(userPath, "utf8").length > 0);
  });

  it("migration is idempotent on second call", () => {
    sandboxUserState();
    const repoRoot = makeTempRepo();
    writeJson(repoRoot, "references/hosts.json", {
      hosts: { ultra4: { os: "win32" } },
    });

    migrateLegacyHosts(repoRoot);
    const second = migrateLegacyHosts(repoRoot);

    assert.equal(second.migrated, false);
    assert.equal(second.reason, "already-exists");
  });

  it("user-state takes priority over source-tree when both exist", () => {
    const userPath = sandboxUserState();
    const repoRoot = makeTempRepo();
    writeJson(repoRoot, "references/hosts.json", {
      hosts: { source: { description: "from-source", os: "linux" } },
    });
    mkdirSync(dirname(userPath), { recursive: true });
    writeFileSync(
      userPath,
      JSON.stringify({
        hosts: { user: { description: "from-user-state", os: "darwin" } },
      }),
    );

    const registry = readHosts(repoRoot);

    assert.equal(resolve(registry.path), resolve(userPath));
    assert.ok(registry.hosts.user, "user-state host should win");
    assert.equal(registry.hosts.source, undefined);
  });

  it("falls back to source-tree when user-state missing", () => {
    sandboxUserState();
    const repoRoot = makeTempRepo();
    const sourcePath = writeJson(repoRoot, "references/hosts.json", {
      hosts: { fallback: { os: "linux" } },
    });

    const registry = readHosts(repoRoot);

    assert.equal(resolve(registry.path), resolve(sourcePath));
    assert.ok(registry.hosts.fallback);
  });

  it("disabled user-state still allows source-tree reads", () => {
    process.env.TFX_HOSTS_USER_STATE_DISABLE = "1";
    delete process.env.TFX_HOSTS_USER_STATE;
    const repoRoot = makeTempRepo();
    const sourcePath = writeJson(repoRoot, "references/hosts.json", {
      hosts: { ci: { os: "linux" } },
    });

    const result = migrateLegacyHosts(repoRoot);
    assert.equal(result.migrated, false);
    assert.equal(result.reason, "user-state-disabled");

    const registry = readHosts(repoRoot);
    assert.equal(resolve(registry.path), resolve(sourcePath));
  });
});
