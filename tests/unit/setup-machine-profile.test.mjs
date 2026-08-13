import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildMachineProfileDefaults,
  ensureMachineProfile,
  parseMachineProfileContent,
  resolveMachineProfilePath,
  writeMachineProfileAtomic,
} from "../../scripts/setup.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const SETUP_SCRIPT = join(PROJECT_ROOT, "scripts", "setup.mjs");

describe("setup machine profile path", () => {
  it("darwin/linux는 XDG_CONFIG_HOME 아래를 사용한다", () => {
    assert.equal(
      resolveMachineProfilePath({
        platform: "darwin",
        home: "/Users/example",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      }),
      "/tmp/xdg/triflux/machine-profile.env",
    );
  });

  it("win32는 APPDATA 아래를 사용한다", () => {
    assert.equal(
      resolveMachineProfilePath({
        platform: "win32",
        home: "C:\\Users\\example",
        env: { APPDATA: "C:\\Users\\example\\AppData\\Roaming" },
      }),
      join(
        "C:\\Users\\example\\AppData\\Roaming",
        "triflux",
        "machine-profile.env",
      ),
    );
  });
});

describe("setup machine profile serialization", () => {
  it("allowlist KEY=VALUE만 파싱하고 셸 표현식은 실행 가능한 값으로 인정하지 않는다", () => {
    const parsed = parseMachineProfileContent(
      [
        "TFX_MACHINE_PROFILE_VERSION=1",
        "TFX_MACHINE_OS=darwin",
        "TFX_DISABLE_CODEX=$(touch /tmp/must-not-run)",
        "UNKNOWN_KEY=1",
        "TFX_STALL_KILL=classify",
        "",
      ].join("\n"),
    );

    assert.deepEqual(parsed.values, {
      TFX_MACHINE_PROFILE_VERSION: "1",
      TFX_MACHINE_OS: "darwin",
      TFX_STALL_KILL: "classify",
    });
    assert.equal(parsed.warnings.length, 2);
  });

  it("atomic replace 실패 시 기존 프로파일을 보존하고 임시 파일을 정리한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-machine-profile-atomic-"));
    const profilePath = join(dir, "machine-profile.env");
    writeFileSync(profilePath, "ORIGINAL=preserve\n", "utf8");

    try {
      const profile = buildMachineProfileDefaults({
        platform: "darwin",
        interactive: false,
        commandAvailable: () => false,
      });
      const renameError = Object.assign(new Error("rename denied"), {
        code: "EACCES",
      });

      assert.throws(
        () =>
          writeMachineProfileAtomic(profilePath, profile, {
            platform: "darwin",
            pid: 123,
            now: () => 456,
            rename: () => {
              throw renameError;
            },
          }),
        (error) => error === renameError,
      );
      assert.equal(readFileSync(profilePath, "utf8"), "ORIGINAL=preserve\n");
      assert.deepEqual(readdirSync(dir), ["machine-profile.env"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setup machine profile defaults", () => {
  it("interactive tmux는 visible 권장값을 제시한다", () => {
    const profile = buildMachineProfileDefaults({
      platform: "darwin",
      env: { TMUX: "/tmp/tmux/default,1,0" },
      interactive: true,
      commandAvailable: () => false,
    });

    assert.equal(profile.TFX_MULTIPLEXER_POLICY, "tmux");
    assert.equal(profile.TFX_TIMEOUT_POLICY, "visible");
    assert.equal(profile.TFX_HARD_CEILING_SEC, "0");
    assert.equal(profile.TFX_STALL_KILL, "classify");
  });
});

describe("setup machine profile non-interactive install", () => {
  it("CI=1은 TTY처럼 보여도 질문하지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-machine-profile-ci-"));
    const profilePath = join(dir, "machine-profile.env");
    try {
      const result = await ensureMachineProfile({
        platform: "linux",
        home: dir,
        env: {
          HOME: dir,
          CI: "1",
          TFX_MACHINE_PROFILE_PATH: profilePath,
          TFX_SETUP_USE_CODEX: "0",
          TFX_SETUP_USE_ANTIGRAVITY: "0",
        },
        force: true,
        input: { isTTY: true },
        output: { isTTY: true },
        commandAvailable: () => false,
        timeoutCommandAvailable: () => true,
      });

      assert.equal(result.interactive, false);
      assert.equal(result.changed, true);
      assert.equal(existsSync(profilePath), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("자동감지보다 명시 setup env를 우선해 안전 기본값으로 원자 저장한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-machine-profile-unit-"));
    const profilePath = join(dir, "machine-profile.env");
    try {
      const result = await ensureMachineProfile({
        platform: "darwin",
        home: dir,
        env: {
          HOME: dir,
          TFX_MACHINE_PROFILE_PATH: profilePath,
          TFX_SETUP_USE_CODEX: "1",
          TFX_SETUP_USE_ANTIGRAVITY: "0",
        },
        force: true,
        interactive: false,
        commandAvailable: () => false,
        timeoutCommandAvailable: () => false,
      });

      assert.equal(result.changed, true);
      assert.equal(result.profile.TFX_MACHINE_OS, "darwin");
      assert.equal(result.profile.TFX_MULTIPLEXER_POLICY, "tmux");
      assert.equal(result.profile.TFX_DISABLE_CODEX, "0");
      assert.equal(result.profile.TFX_DISABLE_ANTIGRAVITY, "1");
      assert.equal(result.profile.TFX_HARD_CEILING_SEC, "21600");
      assert.equal(result.profile.TFX_STALL_THRESHOLD, "1200");
      assert.equal(result.profile.TFX_STALL_KILL, "kill");
      assert.match(result.warnings.join("\n"), /hard ceiling.*비활성/u);
      assert.equal(existsSync(profilePath), true);
      assert.match(
        readFileSync(profilePath, "utf8"),
        /TFX_MULTIPLEXER_POLICY=tmux/u,
      );
      if (process.platform !== "win32") {
        assert.equal(statSync(profilePath).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--machine-profile-only --non-interactive는 TTY 없이 종료하고 프로파일을 만든다", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-machine-profile-spawn-"));
    const profilePath = join(dir, "config", "machine-profile.env");
    mkdirSync(join(dir, ".claude", "cache"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "cache", "tfx-setup-marker.json"),
      "{}\n",
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [SETUP_SCRIPT, "--machine-profile-only", "--non-interactive"],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: dir,
            USERPROFILE: dir,
            TRIFLUX_TEST_HOME: dir,
            TFX_MACHINE_PROFILE_PATH: profilePath,
            TFX_SETUP_USE_CODEX: "0",
            TFX_SETUP_USE_ANTIGRAVITY: "0",
          },
        },
      );

      assert.equal(
        result.status,
        0,
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
      );
      assert.equal(result.signal, null);
      assert.equal(existsSync(profilePath), true);
      assert.match(readFileSync(profilePath, "utf8"), /TFX_DISABLE_CODEX=1/u);
      assert.match(result.stdout, /machine profile/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
