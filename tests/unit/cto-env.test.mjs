import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getCtoHygieneApplyMode,
  getCtoMaxTokens,
  getCtoMode,
  isCtoManagerEnabled,
  isCtoRetentionEnabled,
  resolveRoleControlSnapshot,
} from "../../hub/lib/cto-env.mjs";

const ENV_KEYS = [
  "TFX_CTO",
  "TFX_CTO_MANAGER",
  "TFX_CTO_HYGIENE_APPLY",
  "TFX_CTO_RETENTION",
  "TFX_CTO_MODE",
  "TFX_CTO_MAX_TOKENS",
];

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnv(values = {}) {
  for (const key of ENV_KEYS) {
    if (Object.hasOwn(values, key)) {
      process.env[key] = values[key];
    } else {
      delete process.env[key];
    }
  }
}

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("cto env readers", () => {
  it("defaults every gate to off or safe values", () => {
    setEnv();

    assert.equal(isCtoManagerEnabled(), false);
    assert.equal(getCtoHygieneApplyMode(), "off");
    assert.equal(isCtoRetentionEnabled(), false);
    assert.equal(getCtoMode(), "bounded");
    assert.equal(getCtoMaxTokens(), 0);
  });

  it("enables manager only for explicit on values", () => {
    for (const value of ["1", "true", "on", "yes", " TRUE "]) {
      setEnv({ TFX_CTO_MANAGER: value });
      assert.equal(isCtoManagerEnabled(), true);
    }

    for (const value of ["0", "false", "off", "no", "", "maybe"]) {
      setEnv({ TFX_CTO_MANAGER: value });
      assert.equal(isCtoManagerEnabled(), false);
    }
  });

  it("lets the global CTO kill switch disable manager, hygiene, and retention", () => {
    setEnv({
      TFX_CTO: "0",
      TFX_CTO_MANAGER: "1",
      TFX_CTO_HYGIENE_APPLY: "archive",
      TFX_CTO_RETENTION: "1",
    });

    assert.equal(isCtoManagerEnabled(), false);
    assert.equal(getCtoHygieneApplyMode(), "off");
    assert.equal(isCtoRetentionEnabled(), false);
  });

  it("returns archive only for the hygiene archive apply mode", () => {
    setEnv({ TFX_CTO_HYGIENE_APPLY: "archive" });
    assert.equal(getCtoHygieneApplyMode(), "archive");

    for (const value of ["off", "0", "", "delete", "apply"]) {
      setEnv({ TFX_CTO_HYGIENE_APPLY: value });
      assert.equal(getCtoHygieneApplyMode(), "off");
    }
  });

  it("enables retention only for explicit on values", () => {
    setEnv({ TFX_CTO_RETENTION: "yes" });
    assert.equal(isCtoRetentionEnabled(), true);

    setEnv({ TFX_CTO_RETENTION: "archive" });
    assert.equal(isCtoRetentionEnabled(), false);
  });

  it("returns bounded by default and bridge only for explicit bridge mode", () => {
    setEnv({ TFX_CTO_MODE: "bridge" });
    assert.equal(getCtoMode(), "bridge");

    for (const value of ["bounded", "off", "", "resident"]) {
      setEnv({ TFX_CTO_MODE: value });
      assert.equal(getCtoMode(), "bounded");
    }
  });

  it("returns a positive integer max token cap or zero", () => {
    setEnv({ TFX_CTO_MAX_TOKENS: "12000" });
    assert.equal(getCtoMaxTokens(), 12000);

    for (const value of ["", "0", "-1", "10.5", "NaN", "Infinity"]) {
      setEnv({ TFX_CTO_MAX_TOKENS: value });
      assert.equal(getCtoMaxTokens(), 0);
    }
  });

  it("rereads process.env on each call", () => {
    setEnv({ TFX_CTO_MANAGER: "0" });
    assert.equal(isCtoManagerEnabled(), false);
    process.env.TFX_CTO_MANAGER = "1";
    assert.equal(isCtoManagerEnabled(), true);

    process.env.TFX_CTO_HYGIENE_APPLY = "off";
    assert.equal(getCtoHygieneApplyMode(), "off");
    process.env.TFX_CTO_HYGIENE_APPLY = "archive";
    assert.equal(getCtoHygieneApplyMode(), "archive");

    process.env.TFX_CTO_RETENTION = "0";
    assert.equal(isCtoRetentionEnabled(), false);
    process.env.TFX_CTO_RETENTION = "on";
    assert.equal(isCtoRetentionEnabled(), true);

    process.env.TFX_CTO_MODE = "bounded";
    assert.equal(getCtoMode(), "bounded");
    process.env.TFX_CTO_MODE = "bridge";
    assert.equal(getCtoMode(), "bridge");

    process.env.TFX_CTO_MAX_TOKENS = "0";
    assert.equal(getCtoMaxTokens(), 0);
    process.env.TFX_CTO_MAX_TOKENS = "4096";
    assert.equal(getCtoMaxTokens(), 4096);
  });
});

describe("resolveRoleControlSnapshot", () => {
  const cases = [
    [
      {
        TFX_CTO: "0",
        TFX_CTO_MANAGER: "1",
        TFX_LEAD_MANAGER: "1",
        TFX_CTO_NORTH_STAR: "1",
        TFX_CTO_AUTO_COLLECT: "1",
      },
      [false, false, false, false],
    ],
    [{}, [false, false, true, true]],
    [{ TFX_CTO_MANAGER: "1" }, [true, false, true, true]],
    [{ TFX_CTO_MANAGER: "1", TFX_LEAD_MANAGER: "1" }, [true, true, true, true]],
    [
      { TFX_CTO_MANAGER: "1", TFX_CTO_NORTH_STAR: "0" },
      [true, false, false, true],
    ],
    [
      { TFX_CTO_MANAGER: "1", TFX_CTO_AUTO_COLLECT: "off" },
      [true, false, true, false],
    ],
  ];

  for (const [env, expected] of cases) {
    it(`resolves ${JSON.stringify(env)}`, () => {
      const snapshot = resolveRoleControlSnapshot(env, { generation: 7 });
      assert.equal(snapshot.generation, 7);
      assert.deepEqual(
        [
          snapshot.cto_manager_enabled,
          snapshot.lead_manager_enabled,
          snapshot.north_star_enabled,
          snapshot.auto_collect_enabled,
        ],
        expected,
      );
    });
  }
});
