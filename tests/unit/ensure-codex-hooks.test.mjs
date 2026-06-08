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

import {
  computeTrustedHookHash,
  ensureCodexHooks,
} from "../../scripts/ensure-codex-hooks.mjs";

const tmpRoots = [];

function makeCodexHome() {
  const root = mkdtempSync(join(tmpdir(), "tfx-codex-hooks-test-"));
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { recursive: true });
  tmpRoots.push(root);
  return codexHome;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureCodexHooks", () => {
  it("skips cleanly when codexHome is absent", () => {
    const codexHome = join(
      mkdtempSync(join(tmpdir(), "tfx-codex-hooks-missing-")),
      ".codex",
    );
    const result = ensureCodexHooks({ codexHome });

    assert.equal(result.skipped, true);
    assert.equal(existsSync(codexHome), false);
  });

  it("merges PascalCase hooks, preserves existing entries, pre-seeds trusted hashes, and is idempotent", () => {
    const codexHome = makeCodexHome();
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [
                  { type: "command", command: "omc session", timeout: 7 },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "superpowers prompt",
                    timeout: 9,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "gpt-5.5"',
        "",
        "[hooks.state]",
        '"existing:key:0:0" = { trusted_hash = "sha256:keep" }',
        '"/tmp/elsewhere/hooks.json:session_start:0:0" = { trusted_hash = "sha256:other" }',
        `"${join(codexHome, "hooks.json")}:session_start:0:0" = { trusted_hash = "sha256:stale" }`,
        "",
      ].join("\n"),
      "utf8",
    );

    const opts = {
      codexHome,
      hookScriptPath: "/repo/hooks/codex-session-hook.mjs",
      nodeBin: "/opt/node",
      backupTimestamp: "20260608T010203",
    };
    const first = ensureCodexHooks(opts);
    const hooksAfterFirst = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const configAfterFirst = readFileSync(
      join(codexHome, "config.toml"),
      "utf8",
    );
    const second = ensureCodexHooks(opts);

    assert.equal(first.skipped, false);
    assert.ok(first.changedHooks);
    assert.ok(first.changedConfig);
    assert.equal(second.changedHooks, false);
    assert.equal(second.changedConfig, false);
    assert.equal(
      readFileSync(join(codexHome, "hooks.json"), "utf8"),
      hooksAfterFirst,
    );
    assert.equal(
      readFileSync(join(codexHome, "config.toml"), "utf8"),
      configAfterFirst,
    );
    assert.equal(
      existsSync(
        join(codexHome, "config.toml.bak-tfx-codex-hooks-20260608T010203"),
      ),
      true,
    );

    const hooksJson = JSON.parse(hooksAfterFirst);
    assert.equal(hooksJson.hooks.SessionStart.length, 2);
    assert.equal(hooksJson.hooks.UserPromptSubmit.length, 2);
    assert.equal(
      hooksJson.hooks.SessionStart[0].hooks[0].command,
      "omc session",
    );
    assert.equal(
      hooksJson.hooks.UserPromptSubmit[0].hooks[0].command,
      "superpowers prompt",
    );

    const sessionStart = hooksJson.hooks.SessionStart[1];
    const promptSubmit = hooksJson.hooks.UserPromptSubmit[1];
    assert.equal(sessionStart.matcher, "startup|resume|clear");
    assert.deepEqual(sessionStart.hooks[0], {
      type: "command",
      command: '/opt/node "/repo/hooks/codex-session-hook.mjs" register',
      timeout: 15,
    });
    assert.deepEqual(promptSubmit, {
      hooks: [
        {
          type: "command",
          command: '/opt/node "/repo/hooks/codex-session-hook.mjs" heartbeat',
          timeout: 10,
        },
      ],
    });

    assert.match(
      configAfterFirst,
      /"existing:key:0:0" = \{ trusted_hash = "sha256:keep" \}/,
    );
    assert.match(
      configAfterFirst,
      /"\/tmp\/elsewhere\/hooks\.json:session_start:0:0" = \{ trusted_hash = "sha256:other" \}/,
    );
    assert.doesNotMatch(configAfterFirst, /sha256:stale/);
    assert.match(
      configAfterFirst,
      /"\S+hooks\.json:session_start:1:0" = \{ trusted_hash = "sha256:[0-9a-f]{64}" \}/,
    );
    assert.match(
      configAfterFirst,
      /"\S+hooks\.json:user_prompt_submit:1:0" = \{ trusted_hash = "sha256:[0-9a-f]{64}" \}/,
    );
  });

  it("uses the reverse-engineered canonical trust hash algorithm", () => {
    assert.equal(
      computeTrustedHookHash({
        eventName: "session_start",
        matcher: "startup|resume|clear",
        command: '/opt/node "/repo/hooks/codex-session-hook.mjs" register',
        timeout: 15,
      }),
      "sha256:21bceb27ada25436fa2179874fa094340eced3de296e985c648d5fc59b6a9364",
    );
    assert.equal(
      computeTrustedHookHash({
        eventName: "user_prompt_submit",
        command: '/opt/node "/repo/hooks/codex-session-hook.mjs" heartbeat',
        timeout: 10,
      }),
      "sha256:ea83cfae94429303fca497e00aeb83bfbfd4c82ecd5a740d8f221498210c7475",
    );
  });
});
