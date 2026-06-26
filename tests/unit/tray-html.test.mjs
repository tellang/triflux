// tests/unit/tray-html.test.mjs — tray frontend rendering regressions

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function loadTrayRenderer() {
  const html = readFileSync("hub/public/tray.html", "utf8");
  const script =
    html
      .match(/<script>([\s\S]*)<\/script>/)?.[1]
      ?.replace(/setInterval\(fetchState, 3000\);\s*fetchState\(\);/u, "") ||
    "";
  const tabSessions = { innerHTML: "" };
  const tabGateway = { innerHTML: "" };
  const nativeMessages = [];
  const requests = [];
  const context = {
    console,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    document: {
      getElementById(id) {
        if (id === "tab-sessions") return tabSessions;
        if (id === "tab-gateway") return tabGateway;
        return { classList: { add() {}, remove() {} }, innerHTML: "" };
      },
      querySelectorAll: () => [],
      querySelector: () => ({ innerHTML: "" }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, focus() {}, select() {}, value: "" }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    window: {
      webkit: {
        messageHandlers: {
          tray: {
            postMessage(message) {
              nativeMessages.push(message);
            },
          },
        },
      },
    },
    __requests: requests,
    __nativeMessages: nativeMessages,
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { context, tabSessions };
}

describe("tray Sessions frontend", () => {
  it("renders projects with CTO rows and nested worker rows instead of Hub-as-CTO", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [
        {
          sessionId: "cto-123456",
          status: "active",
          cwd: "/Users/tellang/Projects/tools/triflux",
          taskSummary: "cto condition design",
        },
      ],
      cto: {
        live_sessions: [
          {
            sessionId: "claude-101",
            phase: "active",
            agent_id: "claude",
            agent: {
              id: "claude",
              label: "Claude",
              icon: "C",
              color: "#d19a66",
            },
            pid: 101,
          },
          {
            sessionId: "codex-202",
            phase: "active",
            agent_id: "codex",
            agent: {
              id: "codex",
              label: "Codex",
              icon: "X",
              color: "#ffffff",
            },
            pid: 202,
          },
          {
            sessionId: "antigravity-303",
            phase: "active",
            agent_id: "antigravity",
            agent: {
              id: "antigravity",
              label: "Antigravity",
              icon: "A",
              color: "#61afef",
            },
            pid: 303,
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 3, clients: [] } },
    });

    assert.doesNotMatch(tabSessions.innerHTML, /CTO \/ Hub/u);
    assert.match(
      tabSessions.innerHTML,
      /<summary class="project-summary"[^>]*>[\s\S]*triflux/u,
    );
    assert.match(
      tabSessions.innerHTML,
      /<div class="project-path">~\/Projects\/tools\/triflux<\/div>/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /Project ·/u);
    assert.match(tabSessions.innerHTML, /cto condition design/u);
    assert.match(tabSessions.innerHTML, /<div class="runtime-card"/u);
    assert.match(tabSessions.innerHTML, /data-agent-id="claude"/u);
    assert.match(tabSessions.innerHTML, /data-agent-id="codex"/u);
    assert.match(tabSessions.innerHTML, /data-agent-id="antigravity"/u);
  });

  it("does not render every active session as a CTO T card", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [
        {
          sessionId: "codex-active-1",
          status: "active",
          cwd: "/Users/tellang/Projects/tools/triflux",
          taskSummary: "ordinary codex session",
        },
        {
          sessionId: "claude-active-2",
          status: "active",
          cwd: "/Users/tellang/Projects/tools/triflux",
          taskSummary: "ordinary claude session",
        },
        {
          sessionId: "old-stale-session",
          status: "stale",
          cwd: "/Users/tellang/Projects/tools/triflux",
          taskSummary: "stale should not become CTO",
        },
      ],
      cto: {
        live_sessions: [],
        active_shards: [],
      },
      runtime: { summary: { total: 0, clients: [] } },
    });

    assert.doesNotMatch(
      tabSessions.innerHTML,
      /data-open-key="cto:codex-active-1"/u,
    );
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /data-open-key="cto:claude-active-2"/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /old-stale-session/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /<span class="agent-badge">T<\/span>/u,
    );
    assert.match(tabSessions.innerHTML, /ordinary codex session/u);
    assert.match(tabSessions.innerHTML, /ordinary claude session/u);
  });

  it("renders one project-level CTO card from role succession state", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [
        {
          sessionId: "codex-worker",
          status: "active",
          cwd: "/Users/tellang/Projects/tools/triflux/.worktrees/fix-441",
          taskSummary: "worker in a worktree",
        },
      ],
      cto: {
        roles: {
          cto: {
            status: "active",
            leader_agent_id: "cto-agent",
            leader_epoch: 4,
            pending_count: 2,
            candidate_count: 2,
            live_candidate_count: 1,
            candidate_source: "explicit",
          },
        },
        live_sessions: [
          {
            sessionId: "cto-agent",
            phase: "active",
            agent_id: "cto-agent",
            cwd: "/Users/tellang/Projects/tools/triflux/.worktrees/fix-441",
            taskSummary: "actual CTO leader",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /CTO Succession/u);
    assert.match(tabSessions.innerHTML, /epoch 4 · pending 2/u);
    assert.match(tabSessions.innerHTML, /data-open-key="cto:cto-agent"/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /data-open-key="cto:codex-worker"/u,
    );
    const ctoCardMatches = tabSessions.innerHTML.match(
      /<details class="session-card"/gu,
    );
    assert.equal(ctoCardMatches?.length, 1);
    const projectNameMatches = tabSessions.innerHTML.match(
      /<span class="project-name">triflux<\/span>/gu,
    );
    assert.equal(projectNameMatches?.length, 1);
  });

  it("renders standby CTO candidates as agents, not extra CTO cards", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        roles: {
          cto: {
            status: "active",
            leader_agent_id: "cto-leader",
            leader_epoch: 6,
            pending_count: 1,
            candidate_count: 2,
            live_candidate_count: 2,
          },
        },
        live_sessions: [
          {
            sessionId: "cto-leader",
            phase: "active",
            agent_id: "cto-leader",
            cwd: "/Users/tellang/Projects/tools/triflux",
            role: "cto",
            taskSummary: "elected CTO leader",
          },
          {
            sessionId: "cto-standby",
            phase: "active",
            agent_id: "cto-standby",
            cwd: "/Users/tellang/Projects/tools/triflux",
            role: "cto",
            taskSummary: "hot standby candidate",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 2, clients: [] } },
    });

    const ctoCards = tabSessions.innerHTML.match(
      /<details class="session-card"/gu,
    );
    assert.equal(ctoCards?.length, 1);
    assert.match(tabSessions.innerHTML, /data-open-key="cto:cto-leader"/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /data-open-key="cto:cto-standby"/u,
    );
    assert.match(tabSessions.innerHTML, /hot standby candidate/u);
    assert.match(tabSessions.innerHTML, /<div class="detail-label">Agents/u);
  });

  it("deduplicates rows that appear in both synapse sessions and CTO live overlay", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: { id: "hub-abcdef", projectRoot: "/repo" },
      sessions: [
        {
          sessionId: "worker-duplicate",
          status: "active",
          cwd: "/repo",
          taskSummary: "same worker prompt",
        },
      ],
      cto: {
        live_sessions: [
          {
            sessionId: "worker-duplicate",
            phase: "active",
            cwd: "/repo",
            taskSummary: "same worker prompt",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    const promptOccurrences =
      tabSessions.innerHTML.match(/same worker prompt/gu) || [];
    assert.equal(promptOccurrences.length, 2);
  });

  it("coalesces sibling linked worktrees when the hub project root is itself a worktree", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot:
          "/Users/tellang/Projects/tools/triflux/.worktrees/fix-cto-succession-441",
      },
      sessions: [
        {
          sessionId: "worker-a",
          status: "active",
          cwd: "/Users/tellang/Projects/tools/triflux/.worktrees/other-branch",
          taskSummary: "sibling worktree worker",
        },
      ],
      cto: {
        roles: {
          cto: {
            status: "active",
            leader_agent_id: "cto-agent",
            leader_epoch: 5,
            pending_count: 0,
            candidate_count: 1,
            live_candidate_count: 1,
          },
        },
        live_sessions: [
          {
            sessionId: "cto-agent",
            phase: "active",
            agent_id: "cto-agent",
            cwd: "/Users/tellang/Projects/tools/triflux/.worktrees/fix-cto-succession-441",
            taskSummary: "CTO leader in current worktree",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 2, clients: [] } },
    });

    const projectNameMatches = tabSessions.innerHTML.match(
      /<span class="project-name">triflux<\/span>/gu,
    );
    assert.equal(projectNameMatches?.length, 1);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /<span class="project-name">other-branch<\/span>/u,
    );
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /<span class="project-name">fix-cto-succession-441<\/span>/u,
    );
    assert.match(tabSessions.innerHTML, /sibling worktree worker/u);
  });

  it("renders compact CTO Hygiene from the provided tray payload", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: { id: "hub-abcdef", projectRoot: "/repo" },
      sessions: [],
      cto: {
        live_sessions: [],
        active_shards: [],
        hygiene: {
          active_tasks: 2,
          stale_sessions: 1,
          orphan_worktrees: 1,
          superseded_checkpoints: 3,
          unknown_owner: 2,
          action_count: 2,
          actions: [
            {
              kind: "session",
              id: "stale-session",
              status: "stale",
              action: "review_or_archive_session",
            },
          ],
        },
      },
      runtime: { summary: { total: 0, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /CTO Hygiene/u);
    assert.match(tabSessions.innerHTML, /Active tasks/u);
    assert.match(
      tabSessions.innerHTML,
      />2<span class="stat-unit">open<\/span>/u,
    );
    assert.match(tabSessions.innerHTML, /Stale sessions/u);
    assert.match(tabSessions.innerHTML, /stale-session/u);
    assert.match(tabSessions.innerHTML, /review_or_archive_session/u);
    assert.doesNotMatch(tabSessions.innerHTML, /apply/i);
    assert.equal(context.__requests.length, 0);
  });

  it("renders session detail as a single-column prompt and agents stream with C/X/A badges", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tpcg-mailrouter",
      },
      sessions: [
        {
          sessionId: "cto-long-123456",
          status: "active",
          cwd: "/Users/tellang/Projects/tpcg-mailrouter",
          taskSummary:
            "Long CTO prompt ".repeat(20) + "with implementation details",
        },
      ],
      cto: {
        live_sessions: [
          {
            sessionId: "claude-101",
            phase: "active",
            agent_id: "claude",
            agent: { id: "claude", label: "Claude", icon: "C" },
            pid: 101,
            cwd: "/Users/tellang/Projects/tpcg-mailrouter",
            taskSummary: "Claude worker prompt ".repeat(12),
          },
          {
            sessionId: "codex-202",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 202,
            cwd: "/Users/tellang/Projects/tpcg-mailrouter",
            taskSummary: "Codex worker prompt",
          },
          {
            sessionId: "antigravity-303",
            phase: "active",
            agent_id: "antigravity",
            agent: { id: "antigravity", label: "Antigravity", icon: "A" },
            pid: 303,
            cwd: "/Users/tellang/Projects/tpcg-mailrouter",
            taskSummary: "Antigravity worker prompt",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 3, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /<details class="project-group"/u);
    assert.match(tabSessions.innerHTML, /data-open-key="project:/u);
    assert.match(tabSessions.innerHTML, /<details class="session-card"/u);
    assert.match(tabSessions.innerHTML, /data-open-key="cto:cto-long-123456"/u);
    assert.match(tabSessions.innerHTML, /<div class="session-detail">/u);
    assert.match(tabSessions.innerHTML, /<div class="detail-label">Prompt/u);
    assert.match(tabSessions.innerHTML, /<div class="detail-label">Agents/u);
    assert.doesNotMatch(tabSessions.innerHTML, /chat-column/u);
    assert.doesNotMatch(tabSessions.innerHTML, /worker-column|cto-column/u);
    assert.match(tabSessions.innerHTML, /<summary class="bubble-preview"/u);
    assert.match(tabSessions.innerHTML, /<pre class="bubble-full">/u);
    assert.match(
      tabSessions.innerHTML,
      /<span class="agent-badge agent-tag claude"[^>]*>C<\/span>/u,
    );
    assert.match(
      tabSessions.innerHTML,
      /<span class="agent-badge agent-tag codex"[^>]*>X<\/span>/u,
    );
    assert.match(
      tabSessions.innerHTML,
      /<span class="agent-badge agent-tag antigravity"[^>]*>A<\/span>/u,
    );
  });

  it("preserves open project, CTO, and bubble details across auto refresh", () => {
    const { context } = loadTrayRenderer();
    const project = { dataset: { openKey: "project:/repo" }, open: false };
    const cto = { dataset: { openKey: "cto:cto-1" }, open: false };
    const bubble = {
      dataset: { openKey: "bubble:worker:claude-1" },
      open: false,
    };

    context.restoreOpenDetails(
      {
        querySelectorAll(selector) {
          assert.equal(selector, "details[data-open-key]");
          return [project, cto, bubble];
        },
      },
      new Set(["project:/repo", "bubble:worker:claude-1"]),
    );

    assert.equal(project.open, true);
    assert.equal(cto.open, false);
    assert.equal(bubble.open, true);
  });

  it("keeps agent-tagged prompt summaries as chat when there is no runtime evidence", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "claude-handoff-1",
            phase: "active",
            agent_id: "claude",
            agent: { id: "claude", label: "Claude", icon: "C" },
            cwd: "/Users/tellang/Projects/tools/triflux",
            taskSummary:
              "Please inspect the tray session grouping and report the broken focus behavior.",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 0, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /<div class="bubble-card worker">/u);
    assert.match(
      tabSessions.innerHTML,
      /Please inspect the tray session grouping/u,
    );
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /<span class="runtime-command">claude<\/span>/u,
    );
  });

  it("renders runtime-only projects as useful cards instead of fake CTO prompt chat", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "codex-24978",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 24978,
            elapsed: "01:49:05",
            cwd: "/Users/tellang/Projects/session-vault",
            taskSummary:
              '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file="/Users/tellang/Projects/session-vault/.omx/state/sessions/abc/AGENTS.md"',
            command:
              '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file="/Users/tellang/Projects/session-vault/.omx/state/sessions/abc/AGENTS.md"',
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    assert.match(
      tabSessions.innerHTML,
      /<span class="project-name">session-vault<\/span>/u,
    );
    assert.match(tabSessions.innerHTML, /<div class="runtime-card"/u);
    assert.match(
      tabSessions.innerHTML,
      /<span class="agent-badge agent-tag codex"[^>]*>X<\/span>/u,
    );
    assert.match(
      tabSessions.innerHTML,
      /<span class="runtime-command">codex<\/span>/u,
    );
    assert.match(tabSessions.innerHTML, /data-pid="24978"/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /No prompt handoff events captured yet/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /<span class="chip">PID/u);
    assert.doesNotMatch(tabSessions.innerHTML, /CTO runtime overlay/u);
    assert.doesNotMatch(tabSessions.innerHTML, /node_modules\/.*codex-darwin/u);
    assert.doesNotMatch(tabSessions.innerHTML, /dangerously-bypass-approvals/u);
  });

  it("coalesces equivalent project paths that only differ by a trailing slash", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux/",
      },
      sessions: [
        {
          sessionId: "cto-current",
          status: "active",
          cwd: "/Users/tellang/Projects/tools/triflux",
          taskSummary: "current triflux session",
        },
      ],
      cto: {
        live_sessions: [
          {
            sessionId: "claude-runtime",
            phase: "active",
            agent_id: "claude",
            agent: { id: "claude", label: "Claude", icon: "C" },
            pid: 101,
            cwd: "",
            command: "claude",
            taskSummary: "claude",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    const projectNameMatches = tabSessions.innerHTML.match(
      /<span class="project-name">triflux<\/span>/gu,
    );
    assert.equal(projectNameMatches?.length, 1);
    assert.match(tabSessions.innerHTML, /current triflux session/u);
    assert.match(
      tabSessions.innerHTML,
      /<span class="runtime-command">claude<\/span>/u,
    );
  });

  it("keeps command-backed runtime rows out of chat and avoids focus without a session id", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 9123,
            cwd: "/Users/tellang/Projects/tools/triflux",
            taskSummary: "node scripts/worker.mjs --secret abc",
            command: "node scripts/worker.mjs --secret abc",
          },
          {
            sessionId: "codex-prompt-1",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 9124,
            cwd: "/Users/tellang/Projects/tools/triflux",
            promptText: "Investigate the failing tray runtime card test",
            command: "node scripts/worker.mjs --secret def",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 2, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /<div class="runtime-card"/u);
    assert.match(
      tabSessions.innerHTML,
      /Investigate the failing tray runtime card test/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /node scripts\/worker\.mjs/u);
    assert.doesNotMatch(tabSessions.innerHTML, /--secret/u);
    assert.doesNotMatch(tabSessions.innerHTML, /data-session-id=""/u);
    assert.doesNotMatch(tabSessions.innerHTML, /data-pid="9123"[^>]*>Focus/u);
  });

  it("treats command-shaped task summaries without command fields as runtime cards", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "codex-9125",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 9125,
            cwd: "/Users/tellang/Projects/tools/triflux",
            taskSummary: "node scripts/worker.mjs --secret abc",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /<div class="runtime-card"/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /No prompt handoff events captured yet/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /node scripts\/worker\.mjs/u);
    assert.doesNotMatch(tabSessions.innerHTML, /--secret abc/u);
  });

  it("treats runtime row task summaries as runtime metadata even when they are not denylisted commands", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "codex-9127",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 9127,
            cwd: "/Users/tellang/Projects/tools/triflux",
            taskSummary: "git status --porcelain",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /<div class="runtime-card"/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /No prompt handoff events captured yet/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /git status/u);
  });

  it("treats curl task summaries with authorization headers as runtime cards", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "codex-9126",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 9126,
            cwd: "/Users/tellang/Projects/tools/triflux",
            taskSummary:
              "curl https://example.com -H 'Authorization: Bearer abc'",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /<div class="runtime-card"/u);
    assert.doesNotMatch(
      tabSessions.innerHTML,
      /No prompt handoff events captured yet/u,
    );
    assert.doesNotMatch(tabSessions.innerHTML, /Authorization/u);
    assert.doesNotMatch(tabSessions.innerHTML, /Bearer/u);
  });

  it("suppresses prompt chat focus buttons when session id is empty", () => {
    const { context, tabSessions } = loadTrayRenderer();

    context.renderSessions({
      hub: {
        id: "hub-abcdef",
        projectRoot: "/Users/tellang/Projects/tools/triflux",
      },
      sessions: [],
      cto: {
        live_sessions: [
          {
            sessionId: "",
            phase: "active",
            agent_id: "codex",
            agent: { id: "codex", label: "Codex", icon: "X" },
            pid: 9130,
            cwd: "/Users/tellang/Projects/tools/triflux",
            promptText: "Real prompt text from handoff",
          },
        ],
        active_shards: [],
      },
      runtime: { summary: { total: 1, clients: [] } },
    });

    assert.match(tabSessions.innerHTML, /Real prompt text from handoff/u);
    assert.match(tabSessions.innerHTML, /<div class="bubble-card worker">/u);
    assert.doesNotMatch(tabSessions.innerHTML, /data-session-id=""/u);
    assert.doesNotMatch(tabSessions.innerHTML, /data-pid="9130"[^>]*>Focus/u);
  });

  it("does not keep the unused legacy agent line renderer", () => {
    const html = readFileSync("hub/public/tray.html", "utf8");

    assert.doesNotMatch(html, /function renderAgentLine/u);
  });

  it("focus button reports success and asks the native popover to close", async () => {
    const { context } = loadTrayRenderer();
    const button = { textContent: "Focus", disabled: false };

    await context.focusSession("claude-101", 101, "claude", button);

    assert.equal(context.__requests.length, 1);
    assert.equal(context.__requests[0].url, "/api/focus-session");
    assert.deepEqual(JSON.parse(context.__requests[0].options.body), {
      sessionId: "claude-101",
      pid: 101,
      agentId: "claude",
    });
    assert.equal(button.textContent, "Focus");
    assert.equal(button.disabled, false);
    assert.equal(
      JSON.stringify(context.__nativeMessages),
      JSON.stringify([{ type: "focus-complete" }]),
    );
  });
});
