import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import * as lib from "../../scripts/lib/machine-profile.mjs";
import {
  buildDisabledCliError,
  formatCliPolicyLine,
  normalizeCliName,
  readMachineProfile,
  resolveCliPolicy,
} from "../../scripts/lib/machine-profile.mjs";
import * as setup from "../../scripts/setup.mjs";

// 실제 홈이나 실제 machine profile 을 절대 읽지 않는다. 모든 케이스가
// TFX_MACHINE_PROFILE_PATH 로 임시 파일을 지정하거나 profile 을 주입한다.
function withProfileFile(body, contents) {
  const dir = mkdtempSync(join(tmpdir(), "tfx-machine-profile-reader-"));
  const profilePath = join(dir, "machine-profile.env");
  if (typeof contents === "string") {
    writeFileSync(profilePath, contents, "utf8");
  }
  try {
    return body(profilePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveCliPolicy 우선순위", () => {
  it("env 명시값이 profile 값을 이긴다", () => {
    withProfileFile((profilePath) => {
      const policy = resolveCliPolicy({
        TFX_MACHINE_PROFILE_PATH: profilePath,
        TFX_DISABLE_CODEX: "1",
      });
      assert.equal(policy.codexDisabled, true);
      assert.equal(policy.source.codex, "env");
      assert.equal(policy.profilePath, profilePath);
    }, "TFX_DISABLE_CODEX=0\n");
  });

  it("env 에 키가 없으면 profile 값을 쓴다", () => {
    withProfileFile((profilePath) => {
      const policy = resolveCliPolicy({
        TFX_MACHINE_PROFILE_PATH: profilePath,
      });
      assert.equal(policy.codexDisabled, true);
      assert.equal(policy.source.codex, "profile");
      assert.equal(policy.antigravityDisabled, false);
      assert.equal(policy.source.antigravity, "default");
    }, "TFX_DISABLE_CODEX=1\n");
  });

  it("env 에 빈 문자열로 존재하면 profile 을 읽지 않고 허용으로 둔다", () => {
    withProfileFile((profilePath) => {
      const policy = resolveCliPolicy({
        TFX_MACHINE_PROFILE_PATH: profilePath,
        TFX_DISABLE_ANTIGRAVITY: "",
      });
      assert.equal(policy.antigravityDisabled, false);
      assert.equal(policy.source.antigravity, "env");
    }, "TFX_DISABLE_ANTIGRAVITY=1\n");
  });

  it("env 와 profile 둘 다 없으면 기본값 0 이다", () => {
    withProfileFile((profilePath) => {
      const policy = resolveCliPolicy({
        TFX_MACHINE_PROFILE_PATH: profilePath,
      });
      assert.equal(policy.codexDisabled, false);
      assert.equal(policy.antigravityDisabled, false);
      assert.deepEqual(policy.source, {
        codex: "default",
        antigravity: "default",
      });
      assert.equal(policy.profilePath, null);
    });
  });
});

describe("resolveCliPolicy 값 검증", () => {
  it("allowlist 밖 key 와 안전하지 않은 literal 을 무시하고 경고만 남긴다", () => {
    withProfileFile((profilePath) => {
      const policy = resolveCliPolicy({
        TFX_MACHINE_PROFILE_PATH: profilePath,
      });
      assert.equal(policy.codexDisabled, false);
      assert.equal(policy.source.codex, "default");
      assert.equal(policy.warnings.length, 2);
      assert.match(
        policy.warnings.join("\n"),
        /허용되지 않은 key UNKNOWN_KEY/u,
      );
      assert.match(policy.warnings.join("\n"), /안전한 literal이 아님/u);
    }, "UNKNOWN_KEY=1\nTFX_DISABLE_CODEX=$(touch /tmp/must-not-run)\n");
  });

  it("0 도 1 도 아닌 env 값은 허용으로 두고 경고한다", () => {
    const policy = resolveCliPolicy(
      { TFX_DISABLE_CODEX: "maybe" },
      { profile: { path: null, exists: false, values: {}, warnings: [] } },
    );
    assert.equal(policy.codexDisabled, false);
    assert.equal(policy.source.codex, "env");
    assert.match(
      policy.warnings.join("\n"),
      /TFX_DISABLE_CODEX 값은 0 또는 1이어야 함/u,
    );
  });
});

describe("readMachineProfile", () => {
  it("프로파일 파일이 없어도 예외를 던지지 않는다", () => {
    withProfileFile((profilePath) => {
      const profile = readMachineProfile({
        env: { TFX_MACHINE_PROFILE_PATH: profilePath },
      });
      assert.equal(profile.exists, false);
      assert.deepEqual(profile.values, {});
      assert.deepEqual(profile.warnings, []);
      assert.equal(profile.path, profilePath);
    });
  });
});

describe("formatCliPolicyLine", () => {
  it("세션 문맥 주입 형식이 고정돼 있다", () => {
    const policy = {
      codexDisabled: false,
      antigravityDisabled: true,
      source: { codex: "default", antigravity: "profile" },
    };
    assert.equal(
      formatCliPolicyLine(policy),
      "cli-policy: codex=on antigravity=off (SSOT: TFX_DISABLE_*; codex<-default, antigravity<-profile)",
    );
  });
});

describe("buildDisabledCliError", () => {
  const disabledPolicy = {
    codexDisabled: true,
    antigravityDisabled: true,
    source: { codex: "profile", antigravity: "env" },
  };

  it("원인과 해제 방법을 모두 담고 코드 태그를 붙인다", () => {
    const error = buildDisabledCliError("codex", disabledPolicy);
    assert.ok(error instanceof Error);
    assert.equal(error.code, "TFX_CLI_DISABLED");
    assert.equal(error.cli, "codex");
    assert.match(error.message, /TFX_DISABLE_CODEX=1/u);
    assert.match(error.message, /source: profile/u);
    assert.match(error.message, /TFX_DISABLE_CODEX=0/u);
    assert.match(error.message, /--machine-profile-only/u);
  });

  it("agy 는 antigravity 로 정규화한다", () => {
    const error = buildDisabledCliError("agy", disabledPolicy);
    assert.equal(error.cli, "antigravity");
    assert.equal(normalizeCliName("gemini"), "antigravity");
    assert.match(error.message, /TFX_DISABLE_ANTIGRAVITY=1/u);
  });

  it("허용된 CLI 나 모르는 이름이면 null 이다", () => {
    const enabled = {
      codexDisabled: false,
      antigravityDisabled: false,
      source: { codex: "default", antigravity: "default" },
    };
    assert.equal(buildDisabledCliError("codex", enabled), null);
    assert.equal(buildDisabledCliError("claude", disabledPolicy), null);
  });
});

describe("setup.mjs re-export", () => {
  it("공용 리더와 동일한 함수 참조를 다시 내보낸다", () => {
    assert.equal(
      setup.parseMachineProfileContent,
      lib.parseMachineProfileContent,
    );
    assert.equal(
      setup.resolveMachineProfilePath,
      lib.resolveMachineProfilePath,
    );
  });
});
