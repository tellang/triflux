import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
        [
          "git tag",
          "git push branch",
          "git push tag",
          "wait for tag",
          "gh release create",
        ],
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
          if (command === "git" && args[0] === "ls-remote") {
            return "abc123\trefs/tags/v1.2.3\n";
          }
          if (command === "gh" && args[0] === "release") {
            return '{"tagName":"v1.2.3"}\n';
          }
          return "";
        },
      });
      assert.equal(resumedPublish.allowExistingArtifacts, true);
      assert.deepEqual(executed, [
        "git rev-parse --verify v1.2.3",
        "git push origin HEAD",
        "git push origin v1.2.3",
        "git ls-remote --tags origin v1.2.3",
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

  it("tag-only(CI) 모드는 preflight로 HEAD==origin/main을 검증하고 branch push를 생략한다", async () => {
    const root = makeRepo();
    const prevRef = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = "main";
    try {
      assertVersionSync({ rootDir: root, fix: true });
      const executed = [];
      await publishRelease({
        rootDir: root,
        version: "1.2.3",
        dryRun: false,
        publishNpm: false,
        pushBranch: false,
        createGithubRelease: false,
        tagPoll: { attempts: 1, sleepFn: async () => {} },
        execFileSyncFn: (command, args) => {
          executed.push([command, ...args].join(" "));
          if (command === "git" && args[0] === "rev-parse") {
            return "deadbeef\n";
          }
          return "";
        },
      });
      assert.ok(executed.includes("git fetch origin main"));
      assert.ok(executed.includes("git rev-parse HEAD"));
      assert.ok(executed.includes("git rev-parse origin/main"));
      assert.ok(executed.includes("git push origin v1.2.3"));
      assert.ok(!executed.includes("git push origin HEAD"));
    } finally {
      if (prevRef === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = prevRef;
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
    assert.match(
      releaseWorkflow,
      /TFX_MACHINE_PROFILE_PATH:\s*\$\{\{ runner\.temp \}\}\/triflux-release-ci-machine-profile\.env/,
    );
    assert.match(releaseWorkflow, /--skip-npm.*--allow-existing/);
    assert.match(releaseWorkflow, /--tag-only/);
    assert.match(
      releaseWorkflow,
      /gh workflow run npm-publish\.yml --ref "v\$RELEASE_VERSION"/,
    );
    assert.match(releaseWorkflow, /npm-publish\.yml/);
    assert.match(releaseWorkflow, /workflow_dispatch/);
    assert.match(releaseWorkflow, /publish_ref="v\$RELEASE_VERSION"/);
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
    assert.doesNotMatch(npmPublishWorkflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
    assert.match(npmPublishWorkflow, /id-token:\s*write/);
    assert.match(npmPublishWorkflow, /workflow_dispatch:\s+inputs:\s+npm_tag:/);
    assert.equal(
      (
        npmPublishWorkflow.match(
          /npm publish --provenance --access public --tag "\$NPM_TAG"/g,
        ) || []
      ).length,
      3,
    );
    assert.equal(
      (npmPublishWorkflow.match(/already published; skipping/g) || []).length,
      3,
    );
  });

  it("auto releases only successful main push CI from this repository", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    assert.match(
      workflow,
      /workflow_run:\s+workflows: \[ci\]\s+types: \[completed\]\s+branches: \[main\]/,
    );
    assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
    assert.match(
      workflow,
      /github\.event\.workflow_run\.conclusion == 'success'/,
    );
    assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(
      workflow,
      /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
    );
    assert.match(
      workflow,
      /concurrency:\s+group: release\s+cancel-in-progress: false/,
    );
    assert.match(workflow, /ref:.*workflow_run\.head_sha.*github\.sha/);
    assert.doesNotMatch(workflow, /^concurrency:/m);
    assert.match(workflow, /^ {2}resolve:/m);
    assert.match(
      workflow,
      /^ {2}release:\n {4}needs: resolve\n {4}if: needs\.resolve\.outputs\.release == 'true'/m,
    );
    assert.match(workflow, /ref: \$\{\{ needs\.resolve\.outputs\.sha \}\}/);
    for (const output of [
      "release",
      "version",
      "channel",
      "mode",
      "npm_tag",
      "sha",
    ]) {
      assert.ok(
        workflow.includes(`${output}: \${{ steps.resolve.outputs.${output} }}`),
      );
    }
    assert.match(
      workflow,
      /if \[\[ "\$RELEASE_MODE" == "auto" \]\]; then\s+args\+=\(--allow-ancestor\)/,
    );
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /fetch-tags: true/);
    assert.match(workflow, /id: resolve/);
    assert.match(workflow, /resolve-auto-release\.mjs/);
    assert.match(
      workflow,
      /if \[\[ "\$RELEASE_MODE" == "auto" \]\]; then\s+args\+=\(--skip-tests\)/,
    );
    assert.match(workflow, /git rev-parse "\$publish_ref\^\{commit\}"/);
    assert.match(workflow, /\.headBranch == \$publish_ref/);
    assert.match(workflow, /\.headSha == \$sha/);
    assert.match(workflow, /id: dispatch/);
    assert.doesNotMatch(workflow, /started_at|createdAt|-120 seconds/);
    assert.match(workflow, /BASH_REMATCH\[1\]/);
    assert.match(workflow, /gh run view "\$run_id" --json status,conclusion/);
    assert.match(workflow, /previous_ids/);
    assert.match(workflow, /index\(\$id\)/);
    assert.match(workflow, /gh workflow run npm-publish\.yml.*-f npm_tag=/);
    assert.match(
      workflow,
      /NPM_TAG: \$\{\{ needs\.resolve\.outputs\.npm_tag \}\}/,
    );
    assert.match(
      workflow,
      /verify\.mjs.*--npm-wait-seconds 900 --npm-pending-ok/,
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
      assert.deepEqual(testCall.options.stdio, [
        "ignore",
        "inherit",
        "inherit",
      ]);
      assert.equal(testCall.options.timeout, 10 * 60 * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepareRelease reports a failed step without captured test output", async () => {
    const root = makeRepo();
    try {
      assertVersionSync({ rootDir: root, fix: true });
      const largeOutput = "failing test output\n".repeat(10_000);
      const execStub = (command, args) => {
        if (command === "git" && args[0] === "status") return "";
        if (command === "git" && args[0] === "describe") return "v1.2.2";
        if (command === "git" && args[0] === "log")
          return "abc1234 feat: sample\n";
        if (args[0]?.endsWith("test-lock.mjs")) {
          const error = new Error("test command failed");
          error.status = 17;
          error.stdout = largeOutput;
          error.stderr = largeOutput;
          throw error;
        }
        return "";
      };

      await assert.rejects(
        prepareRelease({
          rootDir: root,
          version: "1.2.3",
          allowDirty: true,
          dryRun: false,
          execFileSyncFn: execStub,
        }),
        (error) => {
          assert.equal(
            error.message,
            "[prepare] step=npm-test failed (exit code=17)",
          );
          assert.equal(error.cause.message, "test command failed");
          assert.doesNotMatch(error.message, /failing test output/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepareRelease preserves timeout and signal diagnostics", async () => {
    const root = makeRepo();
    try {
      assertVersionSync({ rootDir: root, fix: true });
      for (const failure of [
        { code: "ETIMEDOUT", expected: "timeout after 600000ms" },
        { signal: "SIGKILL", expected: "signal=SIGKILL" },
      ]) {
        const execStub = (command, args) => {
          if (command === "git" && args[0] === "status") return "";
          if (command === "git" && args[0] === "describe") return "v1.2.2";
          if (command === "git" && args[0] === "log")
            return "abc1234 feat: sample\n";
          if (args[0]?.endsWith("test-lock.mjs")) {
            const error = new Error("test command failed");
            Object.assign(error, failure);
            throw error;
          }
          return "";
        };

        await assert.rejects(
          prepareRelease({
            rootDir: root,
            version: "1.2.3",
            allowDirty: true,
            dryRun: false,
            execFileSyncFn: execStub,
          }),
          (error) => {
            assert.match(error.message, new RegExp(failure.expected));
            assert.equal(error.cause.code, failure.code);
            assert.equal(error.cause.signal, failure.signal);
            return true;
          },
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function workflowStep(file, name) {
  const workflow = readFileSync(
    new URL(`../../.github/workflows/${file}`, import.meta.url),
    "utf8",
  );
  const step = workflow
    .split(`      - name: ${name}\n`)[1]
    ?.split(/\n {6}- name: /)[0];
  assert.ok(step, `missing workflow step: ${name}`);
  const script = step.split("        run: |\n")[1];
  assert.ok(script, `missing shell script: ${name}`);
  return script.replace(/^ {10}/gm, "");
}

it("waits for the dispatched run ID and excludes previous runs in the URL-less fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-dispatch-"));
  const output = join(root, "output");
  const calls = join(root, "calls");
  const fakeCommands = `
    gh() {
      printf '%s\\n' "$*" >> "$GH_CALLS"
      case "$1 $2" in
        'api --paginate') printf '41\\n' ;;
        'workflow run') printf '%s\\n' "$DISPATCH_REPLY" ;;
        'run list') printf '%s\\n' '[{"databaseId":41,"headBranch":"v1.2.3","headSha":"head"},{"databaseId":42,"headBranch":"v1.2.3","headSha":"head"},{"databaseId":43,"headBranch":"v1.2.3","headSha":"other"}]' ;;
        'run view')
          [[ "$3" == 42 ]] || return 91
          [[ "$4" == --log-failed ]] && return 0
          printf '{"status":"completed","conclusion":"%s"}\\n' "$CONCLUSION" ;;
        *) return 92 ;;
      esac
    }
    git() { printf 'head\\n'; }
    sleep() { return 93; }
  `;
  try {
    for (const [reply, conclusion, status] of [
      ["Created https://github.com/test/repo/actions/runs/42", "success", 0],
      ["", "success", 0],
      ["Created https://github.com/test/repo/actions/runs/42", "failure", 1],
    ]) {
      rmSync(output, { force: true });
      rmSync(calls, { force: true });
      const env = {
        ...process.env,
        GITHUB_OUTPUT: output,
        GH_CALLS: calls,
        GITHUB_REPOSITORY: "test/repo",
        RELEASE_VERSION: "1.2.3",
        NPM_TAG: "canary",
        DISPATCH_REPLY: reply,
        CONCLUSION: conclusion,
      };
      const dispatch = spawnSync(
        "bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          fakeCommands + workflowStep("release.yml", "Dispatch npm publish"),
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(dispatch.status, 0, dispatch.stderr);
      const outputs = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ]),
      );
      assert.deepEqual(JSON.parse(outputs.previous_ids), [41]);
      assert.equal(outputs.run_id || "", reply ? "42" : "");
      const wait = spawnSync(
        "bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          fakeCommands + workflowStep("release.yml", "Wait for npm publish"),
        ],
        {
          env: {
            ...env,
            DISPATCH_RUN_ID: outputs.run_id || "",
            PREVIOUS_RUN_IDS: outputs.previous_ids,
          },
          encoding: "utf8",
        },
      );
      assert.equal(wait.status, status, wait.stderr);
      const log = readFileSync(calls, "utf8");
      assert.match(
        log,
        /workflow run npm-publish.yml --ref v1.2.3 -f npm_tag=canary/,
      );
      assert.match(log, /run view 42 --json status,conclusion/);
      assert.doesNotMatch(log, /run view 41/);
      assert.equal(log.includes("run list"), !reply);
      assert.equal(log.includes("--log-failed"), conclusion === "failure");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("resolves npm tags for dispatch and tag pushes and rejects unknown tags", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-npm-tag-"));
  const output = join(root, "env");
  try {
    for (const [input, version, expected] of [
      ["", "1.2.3", "latest"],
      ["", "1.2.3-rc.1", "canary"],
      ["canary", "1.2.3", "canary"],
      ["latest", "1.2.3-rc.1", "latest"],
      ["invalid", "1.2.3", null],
    ]) {
      rmSync(output, { force: true });
      const result = spawnSync(
        "bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          `node() { printf '%s\\n' "$TEST_VERSION"; }\n${workflowStep("npm-publish.yml", "Resolve npm tag")}`,
        ],
        {
          env: {
            ...process.env,
            INPUT_NPM_TAG: input,
            TEST_VERSION: version,
            GITHUB_ENV: output,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, expected ? 0 : 1, result.stderr);
      if (expected)
        assert.equal(readFileSync(output, "utf8"), `NPM_TAG=${expected}\n`);
      else assert.match(result.stdout + result.stderr, /Invalid npm tag/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
