import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveAutoRelease } from "../release/resolve-auto-release.mjs";

function resolveVersion(
  version,
  {
    tags = [],
    headSha = "current",
    main = "current",
    parentVersion = "1.2.2",
    ancestorStatus = 0,
  } = {},
) {
  const rootDir = mkdtempSync(join(tmpdir(), "tfx-resolve-release-"));
  // The checkout metadata must not override the exact CI commit.
  writeFileSync(
    join(rootDir, "package.json"),
    JSON.stringify({ version: "99.0.0" }),
  );
  try {
    return resolveAutoRelease({
      rootDir,
      eventName: "workflow_run",
      headSha,
      execFileSyncFn(command, args, options) {
        assert.equal(command, "git");
        assert.equal(options.cwd, rootDir);
        if (args[0] === "show") {
          if (args[1] === `${headSha}:package.json`)
            return JSON.stringify({ version });
          assert.equal(args[1], `${headSha}^1:package.json`);
          return JSON.stringify({ version: parentVersion });
        }
        if (args[0] === "fetch") {
          assert.deepEqual(args, ["fetch", "--no-tags", "origin", main]);
          return "";
        }
        if (args[0] === "merge-base") {
          assert.deepEqual(args, [
            "merge-base",
            "--is-ancestor",
            headSha,
            main,
          ]);
          if (ancestorStatus !== 0)
            throw Object.assign(new Error("ancestry check failed"), {
              status: ancestorStatus,
            });
          return "";
        }
        assert.notEqual(
          parentVersion,
          version,
          "unchanged commits must not query remote refs",
        );
        assert.deepEqual(args, [
          "ls-remote",
          "--refs",
          "origin",
          "refs/heads/main",
          "refs/tags/v*",
        ]);
        assert.equal(options.cwd, rootDir);
        return [
          ...(main ? [`${main}\trefs/heads/main`] : []),
          ...tags.map((tag) => `tag-sha\trefs/tags/${tag}`),
        ].join("\n");
      },
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("automatic release resolution", () => {
  it("skips an already released version even when its CI is stale", () => {
    const result = resolveVersion("1.2.3", {
      tags: ["v1.2.3"],
      headSha: "older",
    });
    assert.equal(result.release, false);
    assert.match(result.reason, /already released.*v1\.2\.3/i);
  });

  it("skips a commit whose first parent already has the same version", () => {
    const result = resolveVersion("1.2.4", { parentVersion: "1.2.4" });
    assert.equal(result.release, false);
    assert.match(result.reason, /did not change.*version/i);
  });

  it("releases a version bump even when main has advanced beyond the CI head", () => {
    const result = resolveVersion("1.2.4", { headSha: "older" });
    assert.equal(result.release, true);
    assert.equal(result.sha, "older");
    assert.equal(result.npm_tag, "latest");
  });

  it("skips a CI head removed from main by a force push", () => {
    const result = resolveVersion("1.2.4", {
      headSha: "removed",
      ancestorStatus: 1,
    });
    assert.equal(result.release, false);
    assert.match(result.reason, /not.*ancestor.*main/i);
  });

  it("fails closed on ancestry errors other than a non-ancestor result", () => {
    assert.throws(
      () => resolveVersion("1.2.4", { ancestorStatus: 128 }),
      /ancestry check failed/,
    );
  });

  it("leaves prereleases to manual dispatch", () => {
    const result = resolveVersion("1.3.0-rc.1");
    assert.equal(result.release, false);
    assert.match(result.reason, /prerelease.*dispatch/i);
  });

  it("rejects a regression with both candidate and latest stable versions", () => {
    assert.throws(
      () =>
        resolveVersion("1.2.4", { tags: ["v1.2.3", "v1.3.0", "v9.0.0-rc.1"] }),
      /1\.2\.4.*1\.3\.0/,
    );
  });

  it("compares numeric version components, ignoring prerelease and unrelated tags", () => {
    const result = resolveVersion("1.10.0", {
      tags: ["v1.9.0", "v1.8.12", "v2.0.0-rc.1", "vnext"],
    });
    assert.equal(result.release, true);
    assert.equal(result.version, "1.10.0");
    assert.equal(result.channel, "stable");
    assert.equal(result.mode, "auto");
  });

  it("rejects a lower numeric version even when tag enumeration is unsorted", () => {
    assert.throws(
      () => resolveVersion("1.9.1", { tags: ["v1.10.0", "v1.9.0"] }),
      /1\.9\.1.*1\.10\.0/,
    );
  });

  it("allows the first stable release when no stable tags exist", () => {
    assert.equal(
      resolveVersion("1.0.0", { tags: ["v1.0.0-rc.1"] }).release,
      true,
    );
  });

  it("fails closed if the remote main ref cannot be found", () => {
    assert.throws(
      () => resolveVersion("1.2.3", { main: null }),
      /origin\/main/,
    );
  });

  it("rejects malformed versions before querying the remote", () => {
    assert.throws(() => resolveVersion("not-a-version"), /invalid.*version/i);
  });

  it("passes manual version and channel through without git or metadata reads", () => {
    assert.deepEqual(
      resolveAutoRelease({
        eventName: "workflow_dispatch",
        version: "2.0.0-canary.4",
        channel: "canary",
        headSha: "dispatch-sha",
        rootDir: "/nonexistent",
        execFileSyncFn: () => assert.fail("dispatch must not query git"),
      }),
      {
        release: true,
        version: "2.0.0-canary.4",
        channel: "canary",
        mode: "dispatch",
        npm_tag: "canary",
        sha: "dispatch-sha",
      },
    );
  });

  it("writes all six workflow outputs for dispatch", () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-resolve-output-"));
    const output = join(root, "output");
    try {
      execFileSync(
        process.execPath,
        ["scripts/release/resolve-auto-release.mjs"],
        {
          cwd: new URL("../../", import.meta.url),
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_OUTPUT: output,
            RELEASE_VERSION: "2.0.0-canary.4",
            RELEASE_CHANNEL: "canary",
            RELEASE_HEAD_SHA: "dispatch-sha",
          },
        },
      );
      assert.equal(
        readFileSync(output, "utf8"),
        "release=true\nversion=2.0.0-canary.4\nchannel=canary\nmode=dispatch\nnpm_tag=canary\nsha=dispatch-sha\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
