import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildAgentsRowCommand,
  createAgentsRowOwnership,
  exposeLiveSession,
  openAgentsRow,
  resolveTmuxPane,
} from "../../hub/team/agents-row.mjs";
import { runHeadless } from "../../hub/team/headless.mjs";

const pane = {
  socketPath: "/tmp/tmux-501/default",
  sessionId: "$3",
  paneId: "%12",
  sessionName: "tfx-hl-x",
};
const display = () => "/tmp/tmux-501/default\t$3\t%12\ttfx-hl-x\n";

function fakeClaude(calls, short = "527b4ae1") {
  return async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "--bg") {
      return { stdout: `backgrounded · ${short} · ${args[2]}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("agents row", () => {
  it("pane 대상은 서버 안에서 유일한 ID 로만 받는다", () => {
    assert.deepEqual(resolveTmuxPane("tfx-hl-x:0.1", { tmux: display }), pane);
    assert.throws(
      () => resolveTmuxPane("gone", { tmux: () => "/s\tname\tpane\tx" }),
      /tmux pane/u,
    );
  });

  it("헤드리스 행은 읽기 전용 attach, 대화형 행은 응답 필터 중계를 쓴다", () => {
    const ro = buildAgentsRowCommand({ tmuxBin: "/bin/tmux", pane });
    assert.equal(ro.readOnly, true);
    assert.match(ro.command, /attach-session -t '%12' -r; if /u);
    // 방이 사라지거나 같은 pane 번호가 다른 세션 것이 되면 반복을 멈추고 행을 지운다.
    assert.match(
      ro.command,
      /^n=0; while \[ "\$\(.*'%12' '#\{session_id\}' 2>\/dev\/null\)" = '\$3' \]/u,
    );
    assert.match(ro.command, /rm "\$\{CLAUDE_JOB_DIR##\*\/\}"/u);

    const relay = buildAgentsRowCommand({
      tmuxBin: "/bin/tmux",
      pane,
      interactive: true,
      python: "/usr/bin/python3",
    });
    assert.equal(relay.readOnly, false);
    assert.match(relay.command, /agents-row-attach\.py' -- env -u TMUX/u);
    assert.doesNotMatch(relay.command, / -r;/u);
  });

  it("python3 가 실행되지 않으면(macOS 스텁 등) 읽기 전용으로 열고 행 이름에 표시한다", async () => {
    const calls = [];
    const claude = fakeClaude(calls);
    const row = await openAgentsRow({
      name: "10.8 codex",
      target: "live:0.0",
      interactive: true,
      _deps: {
        tmux: display,
        execFile: async (bin, args, opts) => {
          if (bin === "/bin/python3") throw new Error("xcode-select stub");
          return claude(bin, args, opts);
        },
        resolveExecutable: (name) => `/bin/${name}`,
      },
    });
    assert.deepEqual(row.short, "527b4ae1");
    assert.equal(row.readOnly, true);
    assert.equal(row.name, "10.8 codex [read-only]");
    assert.deepEqual(calls[0].slice(0, 4), [
      "/bin/claude",
      "--bg",
      "--name",
      "10.8 codex [read-only]",
    ]);
  });

  it("tfx-live 노출은 Claude, 원격, 끈 경우를 건너뛰고 실패는 경고로만 돌려준다", async () => {
    const opened = [];
    const _deps = {
      tmux: () => {
        opened.push("tmux");
        return "bad";
      },
    };
    const base = { cli: "codex", session: "s", ready: true };
    assert.deepEqual(
      await exposeLiveSession({ ...base, cli: "claude" }, _deps),
      {},
    );
    assert.deepEqual(
      await exposeLiveSession({ ...base, remote: "m2" }, _deps),
      {},
    );
    process.env.TFX_AGENTS_ROW = "0";
    try {
      assert.deepEqual(await exposeLiveSession(base, _deps), {});
    } finally {
      delete process.env.TFX_AGENTS_ROW;
    }
    assert.deepEqual(opened, []);
    const failed = await exposeLiveSession(base, _deps);
    assert.match(failed.agentsRowWarning, /tmux pane/u);
  });

  it("소유한 행만 한 번 닫는다", async () => {
    const closed = [];
    const rows = createAgentsRowOwnership(async (short) => closed.push(short));
    rows.add("aaaa1111");
    rows.add("");
    await rows.release();
    await rows.release();
    assert.deepEqual(closed, ["aaaa1111"]);
  });
});

describe("runHeadless agents rows", () => {
  const dispatchProgressive = async (_session, assignments) =>
    assignments.map((_, i) => ({
      paneId: `s:0.${i + 1}`,
      paneName: `worker-${i + 1}`,
      displayName: `worker-${i + 1}`,
      cli: "codex",
      resultFile: "/nonexistent",
      token: "t",
    }));

  const run = (awaitAll, openAgentsRow, closed, events = []) =>
    runHeadless(
      "rows",
      [
        { cli: "codex", prompt: "a" },
        { cli: "codex", prompt: "b" },
      ],
      {
        nativeBridge: true,
        onProgress: (event) => events.push(event),
        _deps: {
          platform: "darwin",
          dispatchProgressive,
          awaitAll,
          openAgentsRow,
          killPsmuxSession: () => {},
        },
        _agentsRows: createAgentsRowOwnership(async (s) => closed.push(s)),
      },
    );

  it("워커마다 행을 열고, 한 행 실패는 경고만 남긴 채 실행을 계속한다", async () => {
    const closed = [];
    const events = [];
    const result = await run(
      async () => [],
      async ({ target }) => {
        if (target === "s:0.2") throw new Error("untrusted cwd");
        return { short: "aaaa1111" };
      },
      closed,
      events,
    );
    // 성공하면 행은 호출자(cleanup, interactive kill)가 닫는다.
    assert.equal(result.agentsRows.size, 1);
    assert.deepEqual(closed, []);
    assert.ok(
      events.some(
        (e) => e.type === "observer_warning" && e.stage === "agents_row",
      ),
    );
  });

  it("실행이 실패하면 연 행을 바로 닫는다", async () => {
    const closed = [];
    await assert.rejects(
      run(
        async () => {
          throw new Error("worker wait failed");
        },
        async () => ({ short: "bbbb2222" }),
        closed,
      ),
      /worker wait failed/u,
    );
    assert.deepEqual(closed, ["bbbb2222"]);
  });
});

describe("agents-row-attach.py 응답 필터", () => {
  const helper = join(
    import.meta.dirname,
    "../../hub/team/agents-row-attach.py",
  );
  let python = "";
  try {
    python = execFileSync("sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* python3 없음 */
  }

  // 2026-10-08 재현: 재진입 때 방 pane 에 들어온 바깥 터미널 응답 그대로
  const leaked =
    "\x1b[?1;2;4c\x1b[>84;0;0c\x1bP>|tmux 3.7c\x1b\\\x1b[8;50;200t\x1b[4;1600;3200t";

  it("터미널 응답은 지우고 타이핑과 키 시퀀스는 그대로 둔다", {
    skip: !python,
  }, () => {
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("h", sys.argv[1])
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
chunks = json.loads(sys.argv[2])
out, pending = b"", b""
for c in chunks:
    o, pending = h.strip_replies(pending + c.encode())
    out += o
print(json.dumps([out.decode(), pending.decode()]))
`;
    const run = (chunks) =>
      JSON.parse(
        execFileSync(
          python,
          ["-B", "-c", script, helper, JSON.stringify(chunks)],
          {
            encoding: "utf8",
          },
        ),
      );
    assert.deepEqual(run([`ab${leaked}한글\x1b[A\x1b[200~p\x1b[201~`]), [
      "ab한글\x1b[A\x1b[200~p\x1b[201~",
      "",
    ]);
    // read 경계에서 잘린 응답도 이어 붙여 지운다
    const cut = leaked.length - 9;
    assert.deepEqual(
      run([`x${leaked.slice(0, cut)}`, `${leaked.slice(cut)}y`]),
      ["xy", ""],
    );
    // Esc 단독 입력은 붙잡지 않는다
    assert.deepEqual(run(["\x1b"]), ["\x1b", ""]);
  });
});
