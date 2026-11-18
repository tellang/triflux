import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertVersionSync,
  ROOT,
  syncVersionTargets,
  writeJson,
} from "../../scripts/release/lib.mjs";

describe("release version sync with prefix support", () => {
  it("저장소 현재 버전 매니페스트가 루트 버전 및 prefix 버전과 일치한다", () => {
    const result = assertVersionSync({ rootDir: ROOT });
    assert.equal(result.ok, true, JSON.stringify(result.mismatches));
    assert.ok(result.rootVersion);
    const remotePeer = result.targets.find(
      (t) =>
        t.file === "packages/remote/package.json" &&
        t.path.join(".") === "peerDependencies.@triflux/core",
    );
    assert.ok(remotePeer);
    assert.equal(remotePeer.expected, `^${result.rootVersion}`);
    assert.equal(remotePeer.found, `^${result.rootVersion}`);

    const agyPlugin = result.targets.find(
      (t) => t.file === "adapters/agy/plugins/triflux/plugin.json",
    );
    assert.ok(agyPlugin);
    assert.equal(agyPlugin.expected, result.rootVersion);
    assert.equal(agyPlugin.found, result.rootVersion);
  });

  it("prefix가 지정된 타겟을 메이저 버전 변경 시 함께 갱신한다", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tfx-release-prefix-"));
    try {
      writeJson(join(tmpRoot, "package.json"), {
        name: "triflux",
        version: "11.0.0",
      });
      writeJson(join(tmpRoot, "adapters/agy/plugins/triflux/plugin.json"), {
        name: "triflux",
        version: "10.99.0",
      });
      writeJson(join(tmpRoot, "packages/remote/package.json"), {
        name: "@triflux/remote",
        version: "10.99.0",
        peerDependencies: { "@triflux/core": "^10.99.0" },
      });
      writeJson(join(tmpRoot, "package-lock.json"), {
        name: "triflux",
        version: "10.99.0",
        packages: {
          "": { version: "10.99.0" },
          "packages/remote": {
            version: "10.99.0",
            peerDependencies: { "@triflux/core": "^10.99.0" },
          },
        },
      });
      writeJson(join(tmpRoot, "scripts/release/version-manifest.json"), {
        canonicalFile: "package.json",
        canonicalPath: ["version"],
        targets: [
          { file: "package.json", paths: [["version"]] },
          {
            file: "adapters/agy/plugins/triflux/plugin.json",
            paths: [["version"]],
          },
          { file: "packages/remote/package.json", paths: [["version"]] },
          {
            file: "packages/remote/package.json",
            prefix: "^",
            paths: [["peerDependencies", "@triflux/core"]],
          },
          {
            file: "package-lock.json",
            paths: [
              ["version"],
              ["packages", "", "version"],
              ["packages", "packages/remote", "version"],
            ],
          },
          {
            file: "package-lock.json",
            prefix: "^",
            paths: [
              [
                "packages",
                "packages/remote",
                "peerDependencies",
                "@triflux/core",
              ],
            ],
          },
        ],
      });

      const before = assertVersionSync({ rootDir: tmpRoot });
      assert.equal(before.ok, false);

      const touched = syncVersionTargets({ rootDir: tmpRoot });
      assert.ok(touched.includes("packages/remote/package.json"));
      assert.ok(touched.includes("package-lock.json"));
      assert.ok(touched.includes("adapters/agy/plugins/triflux/plugin.json"));

      const after = assertVersionSync({ rootDir: tmpRoot });
      assert.equal(after.ok, true);

      const remotePkg = JSON.parse(
        readFileSync(join(tmpRoot, "packages/remote/package.json"), "utf8"),
      );
      assert.equal(remotePkg.version, "11.0.0");
      assert.equal(remotePkg.peerDependencies["@triflux/core"], "^11.0.0");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
