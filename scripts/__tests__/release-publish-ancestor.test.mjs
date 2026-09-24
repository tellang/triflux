import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishRelease } from "../release/publish.mjs";

function commandStub({ ancestor = true } = {}) {
  const commands = [];
  const execFileSyncFn = (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "git" && args[0] === "rev-parse") {
      return args[1] === "HEAD" ? "older\n" : "newer\n";
    }
    if (command === "git" && args[0] === "merge-base") {
      if (!ancestor) throw new Error("not an ancestor");
      return "";
    }
    return "";
  };
  return { commands, execFileSyncFn };
}

function publishOptions(execFileSyncFn, allowAncestor) {
  return {
    rootDir: process.cwd(),
    dryRun: false,
    publishNpm: false,
    pushBranch: false,
    createGithubRelease: false,
    execFileSyncFn,
    allowAncestor,
  };
}

describe("tag-only ancestor guard", () => {
  it("allows a release commit that is an ancestor of the current branch", async () => {
    const { commands, execFileSyncFn } = commandStub();
    await publishRelease(publishOptions(execFileSyncFn, true));

    assert.ok(
      commands.some((command) =>
        command.startsWith("git merge-base --is-ancestor HEAD origin/"),
      ),
    );
    assert.ok(commands.some((command) => /^git push origin v\d/.test(command)));
  });

  it("rejects a release commit outside the current branch ancestry", async () => {
    const { commands, execFileSyncFn } = commandStub({ ancestor: false });
    await assert.rejects(
      publishRelease(publishOptions(execFileSyncFn, true)),
      /Refusing tag-only publish/,
    );
    assert.ok(!commands.some((command) => command.startsWith("git push")));
  });

  it("keeps the exact HEAD comparison without --allow-ancestor", async () => {
    const { commands, execFileSyncFn } = commandStub();
    await assert.rejects(
      publishRelease(publishOptions(execFileSyncFn, false)),
      /Refusing tag-only publish/,
    );
    assert.ok(
      !commands.some((command) => command.startsWith("git merge-base")),
    );
    assert.ok(!commands.some((command) => command.startsWith("git push")));
  });
});
