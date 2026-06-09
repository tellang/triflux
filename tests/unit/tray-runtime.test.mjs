// tests/unit/tray-runtime.test.mjs — live CLI process detection for tray CTO fallback

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  collectAntigravityConversations,
  collectRuntimeProcesses,
  parseLsofCwdOutput,
  summarizeRuntimeProcesses,
} from "../../hub/tray-runtime.mjs";

describe("tray runtime process detection", () => {
  it("counts user-facing Claude and Codex CLI sessions without helper processes", () => {
    const psOutput = `
      100     1 00:10:00 claude agents --permission-mode auto
      101     1 00:20:00 claude
      102     1 00:30:00 /Users/tellang/.local/bin/claude daemon run --origin transient
      200   199 00:05:00 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --dangerously-bypass-approvals-and-sandbox
      201   200 00:05:00 /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://
      300     1 00:01:00 /opt/homebrew/bin/antigravity --session abc
    `;

    const processes = collectRuntimeProcesses(psOutput);
    const summary = summarizeRuntimeProcesses(processes);

    assert.deepEqual(
      processes.map((process) => [process.client, process.pid]),
      [
        ["claude", 100],
        ["claude", 101],
        ["codex", 200],
        ["antigravity", 300],
      ],
    );
    assert.deepEqual(
      summary.clients.map((client) => [client.id, client.count, client.status]),
      [
        ["claude", 2, "on"],
        ["codex", 1, "on"],
        ["antigravity", 1, "on"],
      ],
    );
  });

  it("attaches project cwd and uses parent tmux cwd when child cwd is generic", () => {
    const psOutput = `
      3512     1 05:00:00 tmux new-session -d -s omc-tpcg-mailrouter -c /Users/tellang/Projects/tpcg-mailrouter
      65749 3512 05:09:27 claude agents --permission-mode auto
      45514 45484 01:17:56 /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file="/Users/tellang/Projects/tools/triflux/.omx/state/sessions/abc/AGENTS.md"
      52962 52941 05:41:17 /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file="/Users/tellang/Projects/tpcg-mailrouter/.omx/state/sessions/def/AGENTS.md"
    `;
    const cwdByPid = new Map([
      [3512, "/Users/tellang/Projects/tpcg-mailrouter"],
      [65749, "/Users/tellang/Projects"],
      [45514, "/Users/tellang/Projects/tools/triflux"],
      [52962, "/Users/tellang/Projects/tpcg-mailrouter"],
    ]);

    const processes = collectRuntimeProcesses(psOutput, { cwdByPid });

    assert.deepEqual(
      processes.map((process) => [process.pid, process.cwd]),
      [
        [65749, "/Users/tellang/Projects/tpcg-mailrouter"],
        [45514, "/Users/tellang/Projects/tools/triflux"],
        [52962, "/Users/tellang/Projects/tpcg-mailrouter"],
      ],
    );
  });

  it("parses lsof -Fn cwd output by pid", () => {
    assert.deepEqual(
      [
        ...parseLsofCwdOutput(
          "p45514\nfcwd\nn/Users/tellang/Projects/tools/triflux\n",
        ).entries(),
      ],
      [[45514, "/Users/tellang/Projects/tools/triflux"]],
    );
  });

  it("counts recent Antigravity conversation cache rows when no agy process is running", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-agy-cache-"));
    mkdirSync(join(dir, "cache"), { recursive: true });
    mkdirSync(join(dir, "conversations"), { recursive: true });
    writeFileSync(
      join(dir, "cache", "last_conversations.json"),
      JSON.stringify({
        "/Users/tellang/Projects/tools/triflux":
          "b948f5a5-f029-4762-8540-33e34d7daca8",
        "/Users/tellang/Projects/tools/triflux/.claude/worktrees/agy-hud":
          "5f7eb810-71eb-4cef-a34b-824c8b1366a1",
        "/Users/tellang/Projects/tpcg-mailrouter":
          "0c40f5b8-cbeb-400a-8a75-292c2a46f0a3",
      }),
    );
    for (const [index, id] of [
      "b948f5a5-f029-4762-8540-33e34d7daca8",
      "5f7eb810-71eb-4cef-a34b-824c8b1366a1",
      "0c40f5b8-cbeb-400a-8a75-292c2a46f0a3",
    ].entries()) {
      const filePath = join(dir, "conversations", `${id}.db`);
      writeFileSync(filePath, "");
      const mtime = new Date(Date.now() - index * 60_000);
      utimesSync(filePath, mtime, mtime);
    }

    const conversations = collectAntigravityConversations({ baseDir: dir });
    const summary = summarizeRuntimeProcesses(conversations);

    assert.deepEqual(
      conversations.map((conversation) => [
        conversation.client,
        conversation.conversationId,
        conversation.cwd,
        conversation.source,
        conversation.focusable,
      ]),
      [
        [
          "antigravity",
          "b948f5a5-f029-4762-8540-33e34d7daca8",
          "/Users/tellang/Projects/tools/triflux",
          "conversation",
          false,
        ],
        [
          "antigravity",
          "5f7eb810-71eb-4cef-a34b-824c8b1366a1",
          "/Users/tellang/Projects/tools/triflux/.claude/worktrees/agy-hud",
          "conversation",
          false,
        ],
        [
          "antigravity",
          "0c40f5b8-cbeb-400a-8a75-292c2a46f0a3",
          "/Users/tellang/Projects/tpcg-mailrouter",
          "conversation",
          false,
        ],
      ],
    );
    assert.deepEqual(summary.clients[2], {
      id: "antigravity",
      label: "Antigravity",
      icon: "A",
      color: "#61afef",
      count: 3,
      status: "on",
    });
  });
});
