import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveStableNodeBin } from "../../scripts/lib/stable-node.mjs";

describe("resolveStableNodeBin", () => {
  it("prefers the Homebrew bin/node alias over the versioned Cellar path", () => {
    const prefix = "/opt/homebrew";
    const cellar = `${prefix}/Cellar/node/26.0.0/bin/node`;
    const alias = `${prefix}/bin/node`;
    const realpath = (p) => {
      if (p === cellar || p === alias) return cellar;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    assert.equal(
      resolveStableNodeBin(cellar, {
        env: { HOMEBREW_PREFIX: prefix },
        realpath,
      }),
      alias,
    );
  });

  it("keeps execPath when no stable alias resolves to the same binary", () => {
    const exec = "/Users/me/.nvm/versions/node/v26.0.0/bin/node";
    const realpath = (p) => {
      if (p === exec) return exec;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    assert.equal(resolveStableNodeBin(exec, { env: {}, realpath }), exec);
  });

  it("returns the fallback instead of a versioned path when no alias matches", () => {
    const exec = "/home/u/.nvm/versions/node/v22.0.0/bin/node";
    const realpath = (path) => {
      if (path === exec) return exec;
      throw new Error("absent");
    };
    assert.equal(
      resolveStableNodeBin(exec, { env: {}, realpath, fallback: "node" }),
      "node",
    );
  });

  it("keeps execPath when the alias points at a different node", () => {
    const exec = "/opt/homebrew/Cellar/node/26.0.0/bin/node";
    const realpath = (p) => {
      if (p === exec) return exec;
      if (p === "/opt/homebrew/bin/node")
        return "/opt/homebrew/Cellar/node/25.0.0/bin/node";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    assert.equal(resolveStableNodeBin(exec, { env: {}, realpath }), exec);
  });
});
