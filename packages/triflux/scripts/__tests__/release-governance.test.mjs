import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { bumpVersion } from "../release/bump-version.mjs";
import { assertVersionSync, writeJson } from "../release/lib.mjs";
import { prepareRelease } from "../release/prepare.mjs";
import { publishRelease } from "../release/publish.mjs";
import { verifyRelease } from "../release/verify.mjs";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "tfx-release-"));
  mkdirSync(join(root, "scripts", "release"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "packages", "triflux"), { recursive: true });
  mkdirSync(join(root, ".omx", "plans"), { recursive: true });

  writeJson(join(root, "package.json"), { name: "triflux", version: "1.2.3" });
  writeJson(join(root, "packages", "triflux", "package.json"), {
    name: "triflux",
    version: "1.2.0",
  });
  writeJson(join(root, ".claude-plugin", "plugin.json"), {
    name: "triflux",
    version: "1.1.0",
  });
  writeJson(join(root, ".claude-plugin", "marketplace.json"), {
    version: "1.2.0",
    plugins: [{ name: "triflux", version: "1.0.0" }],
  });
  writeJson(join(root, "package-lock.json"), {
    name: "triflux",
    version: "1.2.0",
    packages: {
      "": {
        version: "1.0.0",
      },
    },
  });
  writeJson(join(root, "scripts", "release", "version-manifest.json"), {
    canonicalFile: "package.json",
    canonicalPath: ["version"],
    targets: [
      { file: "package.json", paths: [["version"]] },
      { file: "packages/triflux/package.json", paths: [["version"]] },
      { file: ".claude-plugin/plugin.json", paths: [["version"]] },
      {
        file: ".claude-plugin/marketplace.json",
        paths: [["version"], ["plugins", 0, "version"]],
      },
      {
        file: "package-lock.json",
        paths: [["version"], ["packages", "", "version"]],
      },
    ],
  });
  return root;
}

describe("release governance scripts", () => {
  it("assertVersionSync detects mismatches and fixes them", () => {
    const root = makeRepo();
    try {
      const before = assertVersionSync({ rootDir: root });
      assert.equal(before.ok, false);
      assert.ok(before.mismatches.length >= 4);

      const after = assertVersionSync({ rootDir: root, fix: true });
      assert.equal(after.ok, true);
      assert.deepEqual(
        JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"))),
        { name: "triflux", version: "1.2.3" },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bumpVersion writes canonical version and syncs targets", async () => {
    const root = makeRepo();
    try {
      const result = await bumpVersion({
        rootDir: root,
        nextVersion: "2.0.0",
        write: true,
      });
      assert.equal(result.ok, true);
      assert.equal(
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
        "2.0.0",
      );
      assert.equal(
        JSON.parse(
          readFileSync(
            join(root, "packages", "triflux", "package.json"),
            "utf8",
          ),
        ).version,
        "2.0.0",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepare/publish/verify support dry-run planning", async () => {
    const root = makeRepo();
    try {
      assertVersionSync({ rootDir: root, fix: true });
      const execStub = (command, args) => {
        if (command === "git" && args[0] === "status") return "";
        if (command === "git" && args[0] === "describe") return "v1.2.2";
        if (command === "git" && args[0] === "log")
          return "abc1234 feat: sample\n";
        return "";
      };

      const prepare = await prepareRelease({
        rootDir: root,
        version: "1.2.3",
        allowDirty: true,
        dryRun: true,
        execFileSyncFn: execStub,
      });
      assert.equal(prepare.ok, true);
      assert.equal(prepare.commands.length, 3);
      assert.equal(prepare.steps[0].name, "npm-test");
      assert.equal(prepare.steps[0].timeoutMs, 10 * 60 * 1000);
      assert.equal(prepare.previousTag, "v1.2.2");

      const publish = await publishRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: true,
      });
      assert.equal(publish.steps.length >= 3, true);

      const verify = await verifyRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: true,
      });
      assert.equal(verify.ok, true);
      assert.equal(verify.checks[1].name, "npm-view");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepareRelease supports skip-tests and non-interactive test execution", async () => {
    const root = makeRepo();
    try {
      assertVersionSync({ rootDir: root, fix: true });
      const calls = [];
      const execStub = (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === "git" && args[0] === "status") return "";
        if (command === "git" && args[0] === "describe") return "v1.2.2";
        if (command === "git" && args[0] === "log")
          return "abc1234 feat: sample\n";
        return "";
      };

      const skipped = await prepareRelease({
        rootDir: root,
        version: "1.2.3",
        allowDirty: true,
        dryRun: false,
        skipTests: true,
        execFileSyncFn: execStub,
      });
      assert.equal(skipped.skipTests, true);
      assert.equal(skipped.commands.includes("npm test"), false);
      assert.equal(
        calls.some(
          (call) => call.command === "npm" && call.args.join(" ") === "test",
        ),
        false,
      );

      calls.length = 0;

      const executed = await prepareRelease({
        rootDir: root,
        version: "1.2.3",
        allowDirty: true,
        dryRun: false,
        execFileSyncFn: execStub,
      });
      assert.equal(executed.skipTests, false);

      const testCall = calls.find(
        (call) => call.command === "npm" && call.args.join(" ") === "test",
      );
      assert.ok(testCall);
      assert.deepEqual(testCall.options.stdio, ["ignore", "pipe", "pipe"]);
      assert.equal(testCall.options.timeout, 10 * 60 * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
