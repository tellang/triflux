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

      const trustedPublish = await publishRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: true,
        provenance: true,
      });
      assert.equal(trustedPublish.provenance, true);
      assert.deepEqual(
        trustedPublish.steps
          .filter((step) => step.label.startsWith("npm publish"))
          .map((step) => step.command.includes("--provenance")),
        [true, true, true],
      );
      const tagOnlyPublish = await publishRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: true,
        publishNpm: false,
      });
      assert.equal(tagOnlyPublish.publishNpm, false);
      assert.equal(
        tagOnlyPublish.steps.some((step) =>
          step.label.startsWith("npm publish"),
        ),
        false,
      );
      assert.deepEqual(
        tagOnlyPublish.steps.map((step) => step.label),
        ["git tag", "git push", "gh release create"],
      );

      const executed = [];
      const resumedPublish = await publishRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: false,
        publishNpm: false,
        allowExistingArtifacts: true,
        execFileSyncFn: (command, args) => {
          executed.push([command, ...args].join(" "));
          if (command === "git" && args[0] === "rev-parse") return "tag\n";
          if (command === "gh" && args[0] === "release") {
            return '{"tagName":"v1.2.3"}\n';
          }
          return "";
        },
      });
      assert.equal(resumedPublish.allowExistingArtifacts, true);
      assert.deepEqual(executed, [
        "git rev-parse --verify v1.2.3",
        "git push origin HEAD --tags",
        "gh release view v1.2.3 --json tagName",
      ]);

      const verify = await verifyRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: true,
      });
      assert.equal(verify.ok, true);
      assert.deepEqual(
        verify.checks
          .filter((check) => check.name.startsWith("npm-view"))
          .map((check) => check.name),
        [
          "npm-view @triflux/core",
          "npm-view @triflux/remote",
          "npm-view triflux",
        ],
      );
      assert.deepEqual(
        verify.checks
          .filter((check) => check.name.startsWith("npm-view"))
          .map((check) => check.detail),
        [
          "would run: npm view @triflux/core@1.2.3 version",
          "would run: npm view @triflux/remote@1.2.3 version",
          "would run: npm view triflux@1.2.3 version",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("release workflows use trusted publishing and skip duplicate tag publishes", () => {
    const releaseWorkflow = readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    assert.match(releaseWorkflow, /actions:\s*write/);
    assert.match(releaseWorkflow, /node-version:\s*24/);
    assert.match(releaseWorkflow, /publish\.mjs.*--skip-npm.*--allow-existing/);
    assert.match(releaseWorkflow, /gh workflow run npm-publish\.yml/);
    assert.match(releaseWorkflow, /npm-publish\.yml/);
    assert.match(releaseWorkflow, /workflow_dispatch/);
    assert.match(releaseWorkflow, /gh run list/);
    assert.doesNotMatch(
      releaseWorkflow,
      /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/,
    );

    const npmPublishWorkflow = readFileSync(
      new URL("../../.github/workflows/npm-publish.yml", import.meta.url),
      "utf8",
    );
    assert.match(npmPublishWorkflow, /npm view "\$name@\$version" version/);
    assert.doesNotMatch(
      npmPublishWorkflow,
      /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/,
    );
    assert.equal(
      (npmPublishWorkflow.match(/already published; skipping/g) || []).length,
      3,
    );
  });

  it("verify reports explicit npm package/version failures", async () => {
    const root = makeRepo();
    try {
      assertVersionSync({ rootDir: root, fix: true });
      const calls = [];
      const verify = await verifyRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: false,
        execFileSyncFn: (command, args) => {
          calls.push({ command, args });
          if (command === "npm" && args[1] === "@triflux/remote@1.2.3") {
            const error = new Error("npm view failed");
            error.stderr = Buffer.from("not found");
            throw error;
          }
          if (command === "npm") return "1.2.3\n";
          if (command === "gh") return '{"tagName":"v1.2.3"}\n';
          return "";
        },
      });

      assert.equal(verify.ok, false);
      assert.deepEqual(
        calls.filter((call) => call.command === "npm").map((call) => call.args),
        [
          ["view", "@triflux/core@1.2.3", "version"],
          ["view", "@triflux/remote@1.2.3", "version"],
          ["view", "triflux@1.2.3", "version"],
        ],
      );
      assert.equal(
        verify.checks.find((check) => check.name === "npm-view @triflux/remote")
          .detail,
        "npm view failed for @triflux/remote@1.2.3: not found",
      );
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

      // F3 (issue #192): test step 의 command 가 "npm test" 에서 직접 node
      // test-lock.mjs 호출로 바뀜. legacy npm test 와 F3 후 node test-lock.mjs
      // 둘 다 인식.
      const testCall = calls.find(
        (call) =>
          (call.command === "npm" && call.args.join(" ") === "test") ||
          call.args[0]?.endsWith("test-lock.mjs"),
      );
      assert.ok(testCall);
      assert.deepEqual(testCall.options.stdio, ["ignore", "pipe", "pipe"]);
      assert.equal(testCall.options.timeout, 10 * 60 * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
