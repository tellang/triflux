import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { ensureAgyHooks } from "../../scripts/ensure-agy-hooks.mjs";

const tmpRoots = [];

function makeGeminiConfigHome() {
  const root = mkdtempSync(join(tmpdir(), "tfx-agy-hooks-test-"));
  const configHome = join(root, ".gemini", "config");
  mkdirSync(configHome, { recursive: true });
  tmpRoots.push(root);
  return configHome;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureAgyHooks", () => {
  it("skips cleanly when the gemini config home is absent", () => {
    const geminiConfigHome = join(
      mkdtempSync(join(tmpdir(), "tfx-agy-hooks-missing-")),
      ".gemini",
      "config",
    );
    const result = ensureAgyHooks({ geminiConfigHome });

    assert.equal(result.skipped, true);
    assert.equal(result.changed, false);
    assert.equal(existsSync(geminiConfigHome), false);
  });

  it("writes an agy 1.0.7 PreInvocation group, preserves other groups, backs up, and is idempotent", () => {
    const geminiConfigHome = makeGeminiConfigHome();
    const hooksPath = join(geminiConfigHome, "hooks.json");
    // Pre-existing user hook group that must survive the upsert.
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          "my-linter": {
            enabled: true,
            PreInvocation: [
              {
                type: "command",
                command: "./pre.sh",
                timeout: 5,
              },
            ],
            PostInvocation: [
              {
                type: "command",
                command: "./post-invocation.sh",
                timeout: 5,
              },
            ],
            PostToolUse: [
              {
                matcher: "run_command",
                hooks: [{ type: "command", command: "./lint.sh", timeout: 10 }],
              },
            ],
            Stop: [
              {
                type: "command",
                command: "./stop.sh",
                timeout: 5,
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const opts = {
      geminiConfigHome,
      hookScriptPath: "/repo/hooks/agy-session-hook.mjs",
      nodeBin: "/opt/node",
      backupTimestamp: "20260608T010203",
    };
    const first = ensureAgyHooks(opts);
    const afterFirst = readFileSync(hooksPath, "utf8");
    const second = ensureAgyHooks(opts);

    assert.equal(first.skipped, false);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(hooksPath, "utf8"), afterFirst);
    assert.equal(
      existsSync(`${hooksPath}.bak-tfx-agy-hooks-20260608T010203`),
      true,
    );

    const parsed = JSON.parse(afterFirst);
    // user group preserved
    assert.equal(
      parsed["my-linter"].PostToolUse[0].hooks[0].command,
      "./lint.sh",
    );
    // user group preserved with agy's group-shaped hook contract
    assert.deepEqual(parsed["my-linter"], {
      enabled: true,
      PreInvocation: [
        {
          type: "command",
          command: "./pre.sh",
          timeout: 5,
        },
      ],
      PostInvocation: [
        {
          type: "command",
          command: "./post-invocation.sh",
          timeout: 5,
        },
      ],
      PostToolUse: [
        {
          matcher: "run_command",
          hooks: [{ type: "command", command: "./lint.sh", timeout: 10 }],
        },
      ],
      Stop: [
        {
          type: "command",
          command: "./stop.sh",
          timeout: 5,
        },
      ],
    });
    // triflux group present with the expected agy 1.0.7 PreInvocation command
    assert.deepEqual(parsed["triflux-session"], {
      enabled: true,
      PreInvocation: [
        {
          type: "command",
          command: '/opt/node "/repo/hooks/agy-session-hook.mjs"',
          timeout: 15,
        },
      ],
    });
  });

  it("creates hooks.json from scratch when none exists (no backup written)", () => {
    const geminiConfigHome = makeGeminiConfigHome();
    const hooksPath = join(geminiConfigHome, "hooks.json");

    const result = ensureAgyHooks({
      geminiConfigHome,
      hookScriptPath: "/repo/hooks/agy-session-hook.mjs",
      nodeBin: "/opt/node",
      backupTimestamp: "20260608T010203",
    });

    assert.equal(result.changed, true);
    assert.equal(existsSync(hooksPath), true);
    assert.equal(
      existsSync(`${hooksPath}.bak-tfx-agy-hooks-20260608T010203`),
      false,
    );
    const parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.ok(parsed["triflux-session"].PreInvocation);
  });

  it("re-seeds the triflux group when a corrupt hooks.json is present", () => {
    const geminiConfigHome = makeGeminiConfigHome();
    const hooksPath = join(geminiConfigHome, "hooks.json");
    writeFileSync(hooksPath, "{ not valid json", "utf8");

    const result = ensureAgyHooks({
      geminiConfigHome,
      hookScriptPath: "/repo/hooks/agy-session-hook.mjs",
      nodeBin: "/opt/node",
      backupTimestamp: "20260608T010203",
    });

    assert.equal(result.changed, true);
    // corrupt original is backed up before overwrite
    assert.equal(
      existsSync(`${hooksPath}.bak-tfx-agy-hooks-20260608T010203`),
      true,
    );
    const parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.ok(parsed["triflux-session"].PreInvocation);
  });

  it("skips the real-HOME install while the test runner is active (TEST_LOCK_PID)", () => {
    const prevPid = process.env.TEST_LOCK_PID;
    process.env.TEST_LOCK_PID = "test-guard";
    try {
      // No geminiConfigHome seam -> defaults to the real ~/.gemini/config. The
      // guard must short-circuit before touching it. (The other tests pass an
      // explicit seam and still write, proving the seam bypasses this guard.)
      const result = ensureAgyHooks();
      assert.equal(result.skipped, true);
      assert.equal(result.changed, false);
    } finally {
      if (prevPid === undefined) delete process.env.TEST_LOCK_PID;
      else process.env.TEST_LOCK_PID = prevPid;
    }
  });
});
