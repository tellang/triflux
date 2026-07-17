import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  codexProfileConfigOverrides,
  listLegacyCodexProfileSections,
  sanitizeCodexProfileConfig,
  sanitizeCodexProfileConfigFile,
} from "../../scripts/lib/codex-profile-config.mjs";

const tmpRoots = [];

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-codex-profile-config-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("codex legacy profile config sanitizer", () => {
  it("lists inline [profiles.*] sections", () => {
    const names = listLegacyCodexProfileSections(
      [
        'model = "gpt-5.5"',
        "",
        "[profiles.gpt55_xhigh]",
        'model = "gpt-5.5"',
        "[mcp_servers.tfx-hub]",
        'url = "http://127.0.0.1:27888/mcp"',
        "[profiles.gpt55_low] # stale inline profile",
        'model_reasoning_effort = "low"',
        "",
      ].join("\n"),
    );

    assert.deepEqual(names, ["gpt55_xhigh", "gpt55_low"]);
  });

  it("removes top-level profile selector and inline profile tables after MCP sections", () => {
    const codexHome = makeHome();
    writeFileSync(join(codexHome, "gpt55_low.config.toml"), 'model = "keep"\n');

    const source = [
      'profile = "gpt55_low"',
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.tfx-hub]",
      'url = "http://127.0.0.1:27888/mcp"',
      "",
      "[profiles.gpt55_xhigh]",
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      "",
      "[profiles.gpt55_low]",
      'model = "gpt-5.5"',
      'model_reasoning_effort = "low"',
      "",
      "[mcp_servers.brave-search]",
      'url = "http://127.0.0.1:8101/sse"',
      "",
    ].join("\n");

    const result = sanitizeCodexProfileConfig(source, { codexHome });

    assert.equal(result.changed, true);
    assert.equal(result.removedTopLevelProfileSelector, true);
    assert.deepEqual(result.removedProfiles, ["gpt55_xhigh", "gpt55_low"]);
    assert.deepEqual(result.migratedProfiles, ["gpt55_xhigh"]);
    assert.ok(result.skippedProfileFiles.includes("gpt55_low"));
    assert.doesNotMatch(result.toml, /^profile\s*=/m);
    assert.doesNotMatch(result.toml, /^\[profiles\./m);
    assert.match(result.toml, /^\[mcp_servers\.tfx-hub\]/m);
    assert.match(result.toml, /^\[mcp_servers\.brave-search\]/m);
    assert.equal(
      readFileSync(join(codexHome, "gpt55_xhigh.config.toml"), "utf8"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
    );
    assert.equal(
      readFileSync(join(codexHome, "gpt55_low.config.toml"), "utf8"),
      'model = "keep"\n',
    );
  });

  it("file sanitizer writes a backup once and is idempotent", () => {
    const codexHome = makeHome();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(
      configPath,
      [
        'model = "gpt-5.5"',
        "[profiles.gpt55_med]",
        'model_reasoning_effort = "medium"',
        "",
      ].join("\n"),
    );

    const first = sanitizeCodexProfileConfigFile(configPath, {
      now: () => new Date("2026-06-17T00:00:00Z"),
    });
    const second = sanitizeCodexProfileConfigFile(configPath, {
      now: () => new Date("2026-06-17T00:01:00Z"),
    });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(
      existsSync(`${configPath}.bak-codex-profile-sanitize-20260617-000000`),
      true,
    );
    assert.equal(
      existsSync(`${configPath}.bak-codex-profile-sanitize-20260617-000100`),
      false,
    );
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /^\[profiles\./m);
    // Atomic write must not leave behind a `.tmp-*` staging file; rename
    // consumes it. A leftover temp would mean a torn/aborted write.
    assert.equal(
      readdirSync(codexHome).some((name) => name.includes(".tmp-")),
      false,
      "atomic sanitize should leave no .tmp- staging file",
    );
  });
});

describe("codexProfileConfigOverrides", () => {
  it("reads model + reasoning effort from the per-profile file", () => {
    const codexHome = makeHome();
    writeFileSync(
      join(codexHome, "gpt55_high.config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
    );
    assert.deepEqual(codexProfileConfigOverrides("gpt55_high", { codexHome }), [
      'model="gpt-5.5"',
      'model_reasoning_effort="high"',
    ]);
  });

  it("falls back to the _<effort> naming convention when the file is absent", () => {
    const codexHome = makeHome();
    // no gpt55_xhigh.config.toml written → derive effort only, leave model unset
    assert.deepEqual(
      codexProfileConfigOverrides("gpt55_xhigh", { codexHome }),
      ['model_reasoning_effort="xhigh"'],
    );
  });

  it("derives max and ultra from canonical profile suffixes", () => {
    const codexHome = makeHome();
    assert.deepEqual(
      codexProfileConfigOverrides("gpt56_sol_max", { codexHome }),
      ['model_reasoning_effort="max"'],
    );
    assert.deepEqual(
      codexProfileConfigOverrides("gpt56_sol_ultra", { codexHome }),
      ['model_reasoning_effort="ultra"'],
    );
  });

  it("can enforce canonical values for nested role profiles", () => {
    const codexHome = makeHome();
    writeFileSync(
      join(codexHome, "gpt56_sol_xhigh.config.toml"),
      'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "high"\n',
    );
    assert.deepEqual(
      codexProfileConfigOverrides("gpt56_sol_xhigh", {
        codexHome,
        enforceCanonicalProfile: true,
      }),
      ['model="gpt-5.6-sol"', 'model_reasoning_effort="xhigh"'],
    );
  });

  it("returns [] for an unknown profile with no file and no effort suffix", () => {
    const codexHome = makeHome();
    assert.deepEqual(codexProfileConfigOverrides("auto", { codexHome }), []);
    assert.deepEqual(codexProfileConfigOverrides("", { codexHome }), []);
  });
});
