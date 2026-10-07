import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  isCtoRetentionEnabled,
  resolveRoleControlSnapshot,
} from "../../hub/lib/cto-env.mjs";

const ENV_KEYS = ["TFX_CTO", "TFX_CTO_RETENTION"];

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
  it("defaults retention to off", () => {
    setEnv();
    assert.equal(isCtoRetentionEnabled(), false);
  });

  it("lets the global CTO kill switch disable retention", () => {
    setEnv({ TFX_CTO: "0", TFX_CTO_RETENTION: "1" });
    assert.equal(isCtoRetentionEnabled(), false);
  });

  it("enables retention only for explicit on values", () => {
    setEnv({ TFX_CTO_RETENTION: "yes" });
    assert.equal(isCtoRetentionEnabled(), true);

    setEnv({ TFX_CTO_RETENTION: "archive" });
    assert.equal(isCtoRetentionEnabled(), false);
  });

  it("rereads process.env on each call", () => {
    process.env.TFX_CTO_RETENTION = "0";
    assert.equal(isCtoRetentionEnabled(), false);
    process.env.TFX_CTO_RETENTION = "on";
    assert.equal(isCtoRetentionEnabled(), true);
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
    [{}, [false, false, false, false]],
    [{ TFX_CTO_MANAGER: "1" }, [true, false, false, false]],
    [
      { TFX_CTO_MANAGER: "1", TFX_LEAD_MANAGER: "1" },
      [true, true, false, false],
    ],
    [
      { TFX_CTO_MANAGER: "1", TFX_CTO_NORTH_STAR: "0" },
      [true, false, false, false],
    ],
    [
      { TFX_CTO_MANAGER: "1", TFX_CTO_AUTO_COLLECT: "off" },
      [true, false, false, false],
    ],
    [{ TFX_CTO_NORTH_STAR: "1" }, [false, false, true, false]],
    [{ TFX_CTO_AUTO_COLLECT: "1" }, [false, false, false, true]],
    [
      { TFX_CTO_NORTH_STAR: "1", TFX_CTO_AUTO_COLLECT: "1" },
      [false, false, true, true],
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
