// tests/unit/setup-home-resolution.test.mjs
//
// Issue #193 회귀 가드 — Windows 에서 os.homedir() 가 USERPROFILE 만 보고
// process.env.HOME swap 을 무시하기 때문에, integration test 가 fixture 격리한
// spawn child 에서도 production ~/.codex/config.toml 을 mutate 하는 회귀를 막는다.
//
// 검증 전략:
// - sentinel HOME 디렉토리에 .codex/config.toml 을 만들어 두고
// - fixture HOME 으로 setup 의 ensureCodexProfiles() 를 spawn 한 다음
// - sentinel 의 config.toml 이 untouched 인지 확인한다.
//
// spawn child 사용 → P3 (module-load freeze) 회피.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SETUP_URL = new URL("../../scripts/setup.mjs", import.meta.url).href;

function snapshotConfig(path) {
  if (!existsSync(path)) return { exists: false };
  const data = readFileSync(path);
  return {
    exists: true,
    size: data.length,
    sha: createHash("sha256").update(data).digest("hex"),
  };
}

function spawnEnsureCodexProfiles({
  home,
  userprofile,
  trifluxTestHome,
  codexConfigSync = true,
  ci,
}) {
  const env = { ...process.env };
  // 환경 정리 — 명시적으로 set 하지 않은 키는 child 가 OS 기본값 사용 못 하게 비움
  delete env.TRIFLUX_TEST_HOME;
  delete env.TFX_CODEX_CONFIG_SYNC;
  delete env.CI;
  if (codexConfigSync) env.TFX_CODEX_CONFIG_SYNC = "1";
  if (typeof ci === "string") env.CI = ci;
  if (typeof home === "string") env.HOME = home;
  else delete env.HOME;
  if (typeof userprofile === "string") env.USERPROFILE = userprofile;
  else delete env.USERPROFILE;
  if (typeof trifluxTestHome === "string") {
    env.TRIFLUX_TEST_HOME = trifluxTestHome;
  }

  const script = `
    import(${JSON.stringify(SETUP_URL)}).then((m) => {
      const result = m.ensureCodexProfiles();
      process.stdout.write(JSON.stringify(result));
    }).catch((err) => {
      process.stderr.write("ERR: " + (err?.message || err));
      process.exit(1);
    });
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
}

describe("setup home resolution (#193 회귀 가드)", () => {
  it("Windows: USERPROFILE 이 set 이면 fixture path 사용, sentinel HOME 은 untouched", () => {
    if (process.platform !== "win32") return;

    const fixture = mkdtempSync(join(tmpdir(), "tfx-home-fixture-"));
    const sentinel = mkdtempSync(join(tmpdir(), "tfx-home-sentinel-"));
    mkdirSync(join(fixture, ".codex"), { recursive: true });
    mkdirSync(join(sentinel, ".codex"), { recursive: true });
    const sentinelConfig = join(sentinel, ".codex", "config.toml");
    const fixtureConfig = join(fixture, ".codex", "config.toml");
    // sentinel 에 baseline content 를 깔아두고 변경되지 않는지 확인
    writeFileSync(
      sentinelConfig,
      '# sentinel — must not be mutated\nmodel = "sentinel"\n',
      "utf8",
    );

    try {
      const before = snapshotConfig(sentinelConfig);
      // HOME 은 sentinel, USERPROFILE 은 fixture — Windows 우선순위는 USERPROFILE
      const result = spawnEnsureCodexProfiles({
        home: sentinel,
        userprofile: fixture,
      });
      assert.equal(
        result.status,
        0,
        `spawn failed: ${result.stderr || result.stdout}`,
      );
      const after = snapshotConfig(sentinelConfig);
      assert.equal(after.exists, true, "sentinel must still exist");
      assert.equal(
        after.sha,
        before.sha,
        `sentinel mutated! before=${before.sha} after=${after.sha}`,
      );
      // fixture 에 setup 결과가 만들어졌는지
      assert.equal(
        existsSync(fixtureConfig),
        true,
        "fixture config should be created by ensureCodexProfiles",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(sentinel, { recursive: true, force: true });
    }
  });

  it("TRIFLUX_TEST_HOME 이 set 되면 HOME / USERPROFILE 보다 우선", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tfx-home-test-"));
    const decoy1 = mkdtempSync(join(tmpdir(), "tfx-home-decoy1-"));
    const decoy2 = mkdtempSync(join(tmpdir(), "tfx-home-decoy2-"));
    mkdirSync(join(fixture, ".codex"), { recursive: true });
    mkdirSync(join(decoy1, ".codex"), { recursive: true });
    mkdirSync(join(decoy2, ".codex"), { recursive: true });
    const decoy1Config = join(decoy1, ".codex", "config.toml");
    const decoy2Config = join(decoy2, ".codex", "config.toml");
    const fixtureConfig = join(fixture, ".codex", "config.toml");
    writeFileSync(decoy1Config, '# decoy1\nmodel = "decoy1"\n', "utf8");
    writeFileSync(decoy2Config, '# decoy2\nmodel = "decoy2"\n', "utf8");

    try {
      const before1 = snapshotConfig(decoy1Config);
      const before2 = snapshotConfig(decoy2Config);
      const result = spawnEnsureCodexProfiles({
        home: decoy1,
        userprofile: decoy2,
        trifluxTestHome: fixture,
      });
      assert.equal(
        result.status,
        0,
        `spawn failed: ${result.stderr || result.stdout}`,
      );
      assert.equal(snapshotConfig(decoy1Config).sha, before1.sha);
      assert.equal(snapshotConfig(decoy2Config).sha, before2.sha);
      assert.equal(
        existsSync(fixtureConfig),
        true,
        "fixture (TRIFLUX_TEST_HOME) config must be created",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(decoy1, { recursive: true, force: true });
      rmSync(decoy2, { recursive: true, force: true });
    }
  });

  it("CI/test env에서는 opt-in 없으면 implicit config.toml을 쓰지 않는다", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tfx-home-protected-"));
    mkdirSync(join(fixture, ".codex"), { recursive: true });
    const fixtureConfig = join(fixture, ".codex", "config.toml");

    try {
      const result = spawnEnsureCodexProfiles({
        home: fixture,
        userprofile: fixture,
        codexConfigSync: false,
        ci: "true",
      });
      assert.equal(
        result.status,
        0,
        `spawn failed: ${result.stderr || result.stdout}`,
      );
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.changed, 0);
      assert.equal(parsed.reason, "protected-env");
      assert.equal(
        existsSync(fixtureConfig),
        false,
        "protected env must not create config.toml without opt-in",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
