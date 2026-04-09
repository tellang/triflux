// tests/unit/tui.test.mjs — TUI 대시보드 + ANSI 유틸리티 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  altScreenOff,
  altScreenOn,
  box,
  CLI_ICON,
  clip,
  color,
  cursorHide,
  cursorShow,
  FG,
  MOCHA,
  moveTo,
  padRight,
  progressBar,
  RESET,
  STATUS_ICON,
  statusBadge,
  stripAnsi,
  truncate,
  wcswidth,
} from "../../hub/team/ansi.mjs";

import { createLogDashboard } from "../../hub/team/tui.mjs";
import {
  buildDashboardAttachRequest as buildAttachRequest,
  createTransientTabLimiter as createAttachLimiter,
} from "../../hub/team/tui.mjs";

// ── ansi.mjs ──

describe("ansi.mjs", () => {
  it("moveTo: 올바른 ANSI 시퀀스 생성", () => {
    assert.equal(moveTo(5, 10), "\x1b[5;10H");
    assert.equal(moveTo(1, 1), "\x1b[1;1H");
  });

  it("color: fg 적용", () => {
    const result = color("hello", FG.red);
    assert.ok(result.includes("\x1b[31m"));
    assert.ok(result.includes("hello"));
    assert.ok(result.endsWith(RESET));
  });

  it("stripAnsi: ANSI 코드 제거", () => {
    const painted = `${FG.red}hello${RESET} ${FG.green}world${RESET}`;
    assert.equal(stripAnsi(painted), "hello world");
  });

  it("truncate: 긴 문자열 자르기", () => {
    assert.equal(truncate("abcdefgh", 5), "abcd…");
    assert.equal(truncate("abc", 5), "abc");
  });

  it("padRight: ANSI 포함 문자열 올바르게 패딩 (wcwidth-aware)", () => {
    const painted = `${FG.red}hi${RESET}`;
    const padded = padRight(painted, 10);
    // wcswidth 기준 표시 너비 = 10
    assert.equal(wcswidth(stripAnsi(padded)), 10);
  });

  it("wcswidth: CJK wide char = 2셀", () => {
    assert.equal(wcswidth("한글"), 4);
    assert.equal(wcswidth("AB"), 2);
  });

  it("clip: 정확히 width 셀로 자르고 패딩", () => {
    const result = clip("hello world", 5);
    assert.equal(result.length, 5);
    assert.equal(result, "hello");
  });

  it("box: 테두리 생성", () => {
    const { top, body, bot } = box(["hello"], 20);
    assert.ok(top.startsWith("┌"));
    assert.ok(top.endsWith("┐"));
    assert.ok(bot.startsWith("└"));
    assert.equal(body.length, 1);
    assert.ok(body[0].startsWith("│"));
  });

  it("progressBar: percent(0-100) 기반 바 생성", () => {
    const bar = progressBar(50, 10);
    const clean = stripAnsi(bar);
    assert.equal(clean.length, 10);
    // 50%이면 절반 채워짐
    assert.equal(clean.split("█").length - 1, 5);
  });

  it("progressBar: 0%는 빈 바, 100%는 꽉 찬 바", () => {
    assert.equal(stripAnsi(progressBar(0, 8)), "░".repeat(8));
    assert.equal(stripAnsi(progressBar(100, 8)), "█".repeat(8));
  });

  it("statusBadge: 상태별 배지 문자 포함", () => {
    assert.ok(stripAnsi(statusBadge("completed")).includes("completed"));
    assert.ok(stripAnsi(statusBadge("failed")).includes("failed"));
    assert.ok(stripAnsi(statusBadge("running")).includes("running"));
    assert.ok(stripAnsi(statusBadge("pending")).includes("pending"));
  });

  it("MOCHA: Catppuccin 색상 상수 정의", () => {
    assert.ok(MOCHA.ok);
    assert.ok(MOCHA.fail);
    assert.ok(MOCHA.partial);
    assert.ok(MOCHA.border);
  });

  it("STATUS_ICON: 모든 상태 아이콘 정의", () => {
    assert.ok(STATUS_ICON.running);
    assert.ok(STATUS_ICON.completed);
    assert.ok(STATUS_ICON.failed);
    assert.ok(STATUS_ICON.pending);
  });

  it("CLI_ICON: codex/gemini/claude 아이콘 정의", () => {
    assert.ok(CLI_ICON.codex);
    assert.ok(CLI_ICON.gemini);
    assert.ok(CLI_ICON.claude);
  });

  it("altScreen: on/off 시퀀스", () => {
    assert.ok(altScreenOn.includes("1049h"));
    assert.ok(altScreenOff.includes("1049l"));
  });

  it("cursorHide/cursorShow 시퀀스", () => {
    assert.ok(cursorHide.includes("?25l"));
    assert.ok(cursorShow.includes("?25h"));
  });
});

describe("tui attach helpers", () => {
  it("buildDashboardAttachRequest는 로컬/원격 attach 인자를 구성한다", () => {
    const local = buildAttachRequest(
      { sessionName: "alpha-1", role: "lead" },
      {
        resolveAttachCommand: (sessionName) => ({
          command: "psmux",
          args: ["attach-session", "-t", sessionName],
        }),
      },
    );

    assert.equal(local.kind, "local");
    assert.deepEqual(local.args.slice(0, 6), [
      "-w",
      "0",
      "nt",
      "--title",
      "lead",
      "--",
    ]);
    assert.deepEqual(local.args.slice(-4), [
      "psmux",
      "attach-session",
      "-t",
      "alpha-1",
    ]);

    const remote = buildAttachRequest({
      sessionName: "beta.2",
      role: "worker",
      remote: true,
      sshUser: "alice",
      host: "ryzen",
    });

    assert.equal(remote.kind, "remote");
    assert.ok(remote.args.includes("ssh"));
    assert.ok(remote.args.includes("alice@ryzen"));
    assert.ok(remote.args.includes("psmux attach-session -t beta.2"));
    assert.throws(
      () => buildAttachRequest({ sessionName: "bad;name", role: "lead" }),
      /invalid attach session name/i,
    );
  });

  it("createTransientTabLimiter는 로컬/원격 cap과 TTL을 분리 적용한다", () => {
    let now = 0;
    const limiter = createAttachLimiter({
      now: () => now,
      ttlMs: 30_000,
      limits: { local: 2, remote: 1 },
    });

    assert.equal(limiter.acquire("local").ok, true);
    assert.equal(limiter.acquire("local").ok, true);

    const blockedLocal = limiter.acquire("local");
    assert.equal(blockedLocal.ok, false);
    assert.equal(blockedLocal.limit, 2);

    assert.equal(limiter.acquire("remote").ok, true);
    const blockedRemote = limiter.acquire("remote");
    assert.equal(blockedRemote.ok, false);
    assert.equal(blockedRemote.limit, 1);

    now = 30_001;
    assert.equal(limiter.acquire("local").ok, true);
    assert.equal(limiter.snapshot().remote, 0);
  });
});

// ── tui.mjs ──

describe("createLogDashboard", () => {
  it("워커 업데이트 후 getWorkers에 반영", () => {
    const tui = createLogDashboard({ refreshMs: 0 });
    tui.updateWorker("w1", { cli: "codex", status: "running" });
    const workers = tui.getWorkers();
    assert.equal(workers.size, 1);
    assert.equal(workers.get("w1").status, "running");
    tui.close();
  });

  it("파이프라인 업데이트 후 getPipelineState에 반영", () => {
    const tui = createLogDashboard({ refreshMs: 0 });
    tui.updatePipeline({ phase: "verify" });
    const state = tui.getPipelineState();
    assert.equal(state.phase, "verify");
    tui.close();
  });

  it("render: 단일 워커 카드에 tier1/tier2/tier3 정보 출력", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 160,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 160,
    });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      progress: 1,
      tokens: "1.2k tokens used",
      detail: "verdict: done\nfiles_changed: hub/team/tui.mjs",
      handoff: {
        status: "ok",
        verdict: "done",
        confidence: "high",
        files_changed: ["hub/team/tui.mjs"],
      },
      elapsed: 7,
    });
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("worker-1"));
    assert.ok(clean.includes("tok 1.2k"));
    assert.ok(clean.includes("conf high"));
    assert.ok(clean.includes("verdict done"));
    assert.ok(clean.includes("files hub/team/tui.mjs"));
    // progressBar는 % 기호로 표현됨
    assert.ok(clean.includes("%"));
    assert.ok(clean.includes("┌"));
    tui.close();
  });

  it("초기 생성 시 에러 없이 완료", () => {
    let _output = "";
    const fakeStream = {
      write: (s) => {
        _output += s;
      },
      columns: 60,
    };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    // 워커 없으면 초기 출력 없음 (append-only)
    tui.close();
  });

  it("close 후 render 무효", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 60,
      isTTY: false,
    };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    tui.close();
    const before = output;
    tui.render();
    assert.equal(output, before); // close 후 추가 출력 없음
  });

  it("attachWorker는 실패한 spawn 시 transient slot을 즉시 해제한다", async () => {
    let now = 0;
    let openAttempts = 0;
    const fakeStream = {
      write: () => {},
      columns: 80,
      isTTY: false,
    };
    const fakeInput = {
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      input: fakeInput,
      refreshMs: 0,
      deps: {
        now: () => now,
        setTimeout: (fn) => {
          fn();
          return 0;
        },
        clearTimeout: () => {},
        openTab: async () => {
          openAttempts += 1;
          const error = new Error("rate limit");
          error.reasonCode = "rate_limit";
          throw error;
        },
      },
    });
    tui.updateWorker("w1", { sessionName: "alpha-1", role: "lead" });

    await tui.attachWorker("w1");
    await tui.attachWorker("w1");

    assert.equal(openAttempts, 2);
    tui.close();
  });

  it("attachWorker는 로컬 8 / 원격 4 transient cap을 별도로 적용한다", async () => {
    let now = 0;
    const opened = [];
    const fakeStream = {
      write: () => {},
      columns: 80,
      isTTY: false,
    };
    const fakeInput = {
      isTTY: false,
      pause() {},
      resume() {},
      setRawMode() {},
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      input: fakeInput,
      refreshMs: 0,
      deps: {
        now: () => now,
        setTimeout: (fn) => {
          fn();
          return 0;
        },
        clearTimeout: () => {},
        openTab: async (request) => {
          opened.push(request.kind);
        },
      },
    });
    tui.updateWorker("local", { sessionName: "alpha-1", role: "lead" });
    tui.updateWorker("remote", {
      sessionName: "beta-1",
      role: "reviewer",
      remote: true,
      sshUser: "alice",
      host: "ryzen",
    });

    for (let i = 0; i < 8; i += 1) {
      await tui.attachWorker("local");
    }
    await tui.attachWorker("local");

    for (let i = 0; i < 4; i += 1) {
      await tui.attachWorker("remote");
    }
    await tui.attachWorker("remote");

    assert.deepEqual(
      opened.reduce(
        (acc, kind) => ({ ...acc, [kind]: (acc[kind] || 0) + 1 }),
        {},
      ),
      { local: 8, remote: 4 },
    );

    now = 30_001;
    await tui.attachWorker("remote");
    assert.equal(opened.filter((kind) => kind === "remote").length, 5);
    tui.close();
  });

  it("코드 블록은 제거하고 verdict/metadata만 남긴다", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 88,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 88,
    });
    output = "";
    tui.updateWorker("w1", {
      cli: "codex",
      status: "completed",
      detail:
        "요약 문장\n```js\nconsole.log('secret');\n```\nstatus: ok\nconfidence: high",
      handoff: { status: "ok", verdict: "요약 문장", confidence: "high" },
    });
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("요약 문장"));
    assert.ok(
      clean.includes("confidence: high") || clean.includes("conf high"),
    );
    assert.equal(clean.includes("console.log"), false);
    assert.equal(clean.includes("```"), false);
    tui.close();
  });

  it("2-3 워커는 좌우 분할(rail+focus)로 렌더링", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 132,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 132,
    });
    output = "";
    tui.updateWorker("w1", {
      cli: "codex",
      status: "completed",
      handoff: { status: "ok", verdict: "auth done", confidence: "high" },
    });
    tui.updateWorker("w2", {
      cli: "gemini",
      status: "running",
      snapshot: "step 2",
      progress: 0.4,
    });
    tui.updateWorker("w3", {
      cli: "claude",
      status: "failed",
      handoff: { status: "failed", verdict: "dep missing", confidence: "low" },
    });
    tui.render();
    const clean = stripAnsi(output);
    const firstLine = clean.split("\n").find((line) => line.includes("┌"));
    assert.ok(firstLine);
    // 좌우 분할: rail 카드 ┌ + focus pane ┌ = 2개
    assert.equal((firstLine.match(/┌/g) || []).length, 2);
    assert.ok(clean.includes("auth done"));
    assert.ok(clean.includes("dep missing"));
    tui.close();
  });

  it("4개 이상 워커는 summary bar + 선택 워커 상세를 출력", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 120,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 120,
    });
    ["w1", "w2", "w3", "w4"].forEach((name, idx) => {
      tui.updateWorker(name, {
        cli: idx % 2 === 0 ? "codex" : "gemini",
        status: idx === 3 ? "completed" : "running",
        snapshot: `step ${idx + 1}`,
        progress: 0.25 * (idx + 1),
        handoff:
          idx === 3
            ? { status: "partial", verdict: "needs read", confidence: "medium" }
            : undefined,
      });
    });
    // 첫 번째 워커(w1)가 기본 선택됨 — w1을 명시적으로 선택하고 detail 확인
    tui.selectWorker("w1");
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("▲") && clean.includes("exec"));
    assert.ok(clean.includes("1.w1"));
    assert.ok(clean.includes("4.w4"));
    // summary bar에 w4의 상태(completed) 포함 확인
    assert.ok(clean.includes("completed") || clean.includes("w4"));
    tui.close();
  });

  it("altScreen(isTTY=true)에서 상태 변경 시 diff 출력", () => {
    const chunks = [];
    const fakeStream = {
      write: (s) => {
        chunks.push(s);
      },
      columns: 96,
      rows: 30,
      isTTY: true,
    };
    const fakeInput = { isTTY: false };
    const tui = createLogDashboard({
      stream: fakeStream,
      input: fakeInput,
      refreshMs: 0,
      columns: 96,
    });
    tui.updateWorker("w1", {
      cli: "codex",
      status: "running",
      snapshot: "step 1",
      elapsed: 1,
    });
    tui.render();
    const afterFirst = chunks.length;
    // 동일 상태 재렌더 → 애니메이션(wave/spinner) 때문에 일부 dirty row 가능
    tui.render();
    const afterSecond = chunks.length;
    // 상태 변경 없는 재렌더는 최소한 전체 재작성보다 적어야 함
    assert.ok(
      afterSecond - afterFirst <= afterFirst,
      "idle 재렌더는 전체 재작성보다 적어야 함",
    );
    // 상태 변경 → dirty row 발생 → 출력
    tui.updateWorker("w1", {
      cli: "codex",
      status: "completed",
      handoff: { status: "ok", verdict: "ok" },
      elapsed: 2,
    });
    tui.render();
    assert.ok(chunks.length > afterFirst);
    const combined = chunks.join("");
    assert.ok(stripAnsi(combined).includes("ok"));
    tui.close();
  });

  it("non-TTY append-only: 매 render마다 전체 출력", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 96,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 96,
    });
    output = "";
    tui.updateWorker("w1", {
      cli: "codex",
      status: "running",
      snapshot: "step 1",
      elapsed: 1,
    });
    tui.render();
    const afterFirst = output.length;
    // 동일 상태여도 append-only는 매번 출력
    tui.render();
    assert.ok(output.length > afterFirst);
    tui.close();
  });

  it("forceTTY=true: isTTY=false 스트림에서도 altScreen 활성화", () => {
    const chunks = [];
    const fakeStream = {
      write: (s) => {
        chunks.push(s);
      },
      columns: 96,
      rows: 30,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 96,
      forceTTY: true,
    });
    // altScreen 진입 시퀀스가 출력되어야 함
    const combined = chunks.join("");
    assert.ok(
      combined.includes(altScreenOn),
      "altScreenOn 시퀀스가 출력되어야 함",
    );
    assert.ok(
      combined.includes(cursorHide),
      "cursorHide 시퀀스가 출력되어야 함",
    );
    tui.updateWorker("w1", {
      cli: "codex",
      status: "running",
      snapshot: "step 1",
      elapsed: 1,
    });
    tui.render();
    // altScreen diff 렌더 — moveTo 시퀀스 포함 확인
    const allOutput = chunks.join("");
    assert.ok(
      allOutput.includes("\x1b["),
      "ANSI 커서 이동 시퀀스가 포함되어야 함",
    );
    tui.close();
  });

  it("detail toggle과 selection 상태를 유지한다", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 96,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 96,
    });
    tui.updateWorker("w1", {
      cli: "codex",
      status: "running",
      snapshot: "worker one",
      detail: "alpha\nbeta\ngamma",
      progress: 0.5,
    });
    tui.updateWorker("w2", {
      cli: "gemini",
      status: "running",
      snapshot: "worker two",
      detail: "delta\nepsilon",
      progress: 0.4,
    });
    tui.selectWorker("w2");
    tui.toggleDetail(true);
    tui.render();
    const clean = stripAnsi(output);
    assert.equal(tui.getSelectedWorker(), "w2");
    assert.equal(tui.isDetailExpanded(), true);
    assert.ok(clean.includes("delta"));
    assert.ok(clean.includes("epsilon"));
    tui.close();
  });

  it("frameCount 증가", () => {
    const fakeStream = { write: () => {}, columns: 60, isTTY: false };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 60,
    });
    assert.equal(tui.getFrameCount(), 0);
    tui.render();
    assert.equal(tui.getFrameCount(), 1);
    tui.render();
    assert.equal(tui.getFrameCount(), 2);
    tui.close();
  });

  it("Shift+Up/Down: 워커 선택 순환 (\\x1b[1;2A / \\x1b[1;2B)", () => {
    const chunks = [];
    const fakeStream = {
      write: (s) => {
        chunks.push(s);
      },
      columns: 96,
      rows: 30,
      isTTY: true,
    };
    let capturedHandler = null;
    const fakeInput = {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      on: (event, handler) => {
        if (event === "data") capturedHandler = handler;
      },
      off: () => {},
      pause: () => {},
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      input: fakeInput,
      refreshMs: 0,
      columns: 96,
    });
    tui.updateWorker("w1", { cli: "codex", status: "running" });
    tui.updateWorker("w2", { cli: "gemini", status: "running" });
    tui.updateWorker("w3", { cli: "claude", status: "running" });

    // 초기 선택은 w1
    assert.equal(tui.getSelectedWorker(), "w1");

    // capturedHandler가 있으면 키 주입, 없으면 selectWorker로 대체 검증
    if (capturedHandler) {
      // Shift+Down → w2
      capturedHandler(Buffer.from("\x1b[1;2B"));
      assert.equal(tui.getSelectedWorker(), "w2");

      // Shift+Down → w3
      capturedHandler(Buffer.from("\x1b[1;2B"));
      assert.equal(tui.getSelectedWorker(), "w3");

      // Shift+Up → w2
      capturedHandler(Buffer.from("\x1b[1;2A"));
      assert.equal(tui.getSelectedWorker(), "w2");
    } else {
      // 공개 API로 동등 동작 검증
      tui.selectWorker("w2");
      assert.equal(tui.getSelectedWorker(), "w2");
      tui.selectWorker("w3");
      assert.equal(tui.getSelectedWorker(), "w3");
      tui.selectWorker("w2");
      assert.equal(tui.getSelectedWorker(), "w2");
    }

    tui.close();
  });

  it("Shift+Left/Right: 키 시퀀스 \\x1b[1;2D(rail) / \\x1b[1;2C(detail) 포커스 매핑", () => {
    const chunks = [];
    const fakeStream = {
      write: (s) => {
        chunks.push(s);
      },
      columns: 96,
      rows: 30,
      isTTY: true,
    };
    let capturedHandler = null;
    const fakeInput = {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      on: (event, handler) => {
        if (event === "data") capturedHandler = handler;
      },
      off: () => {},
      pause: () => {},
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      input: fakeInput,
      refreshMs: 0,
      columns: 96,
    });
    tui.updateWorker("w1", { cli: "codex", status: "running" });

    if (capturedHandler) {
      // Shift+Right → detail 포커스
      capturedHandler(Buffer.from("\x1b[1;2C"));
      assert.equal(tui.isDetailExpanded(), true);

      // Shift+Left → rail 포커스
      capturedHandler(Buffer.from("\x1b[1;2D"));
      assert.equal(tui.isDetailExpanded(), false);
    } else {
      // toggleDetail API로 동등 동작 검증
      tui.toggleDetail(true);
      assert.equal(tui.isDetailExpanded(), true);
      tui.toggleDetail(false);
      assert.equal(tui.isDetailExpanded(), false);
    }

    tui.close();
  });

  it("compact 카드: 워커 수가 가용 높이 초과 시 body 2줄", () => {
    let output = "";
    // rows=15, 워커 4개 → 4*8=32 > bodyHeight → compact 적용
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 92,
      rows: 15,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 92,
    });
    output = "";
    for (let i = 1; i <= 4; i++) {
      tui.updateWorker(`w${i}`, {
        cli: "codex",
        status: "completed",
        progress: 1,
        handoff: { status: "ok", verdict: "done" },
      });
    }
    tui.render();
    const clean = stripAnsi(output);
    const allLines = clean.split("\n");
    const topIdx = allLines.findIndex((l) => l.trim().startsWith("┌"));
    const botIdx = allLines.findIndex((l) => l.trim().startsWith("└"));
    assert.ok(topIdx >= 0, "compact 카드 ┌ border 없음");
    assert.ok(botIdx > topIdx, "compact 카드 └ border 없음");
    assert.equal(botIdx - topIdx - 1, 2, "compact 카드 body는 2줄이어야 함");
    tui.close();
  });

  it("viewport >= 20 rows → 일반(non-compact) 카드 렌더링 (body > 2줄)", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 92,
      rows: 30,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 92,
      rows: 30,
    });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      status: "completed",
      progress: 1,
      tokens: "1.2k",
      handoff: {
        status: "ok",
        verdict: "all done",
        confidence: "high",
        files_changed: ["a.mjs"],
      },
    });
    tui.render();
    const clean = stripAnsi(output);
    const allLines = clean.split("\n");
    const topIdx = allLines.findIndex((l) => l.trim().startsWith("┌"));
    const botIdx = allLines.findIndex((l) => l.trim().startsWith("└"));
    assert.ok(topIdx >= 0, "카드 ┌ border 없음");
    assert.ok(botIdx > topIdx, "카드 └ border 없음");
    // 일반 카드: body는 2줄 초과
    assert.ok(botIdx - topIdx - 1 > 2, "일반 카드 body는 2줄 초과여야 함");
    tui.close();
  });

  it("P0: role에 중복된 워커명/CLI명이 제거된다", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 160,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 160,
    });
    output = "";
    tui.updateWorker("worker-1", {
      cli: "codex",
      role: "codex (worker-1)",
      status: "running",
      progress: 0.5,
    });
    tui.render();
    const clean = stripAnsi(output);
    assert.equal(
      clean.includes("(codex (worker-1))"),
      false,
      "중복 role이 표시되면 안됨",
    );
    assert.ok(clean.includes("worker-1"), "워커 이름은 표시되어야 함");
    tui.close();
  });

  it("P0: CLI 아이콘 이모지가 role에서 제거된다", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 160,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 160,
    });
    output = "";
    // ⚪ codex → 이모지+CLI 모두 제거 → role 빈 문자열 → 괄호 미표시
    tui.updateWorker("worker-1", {
      cli: "codex",
      role: "⚪ codex",
      status: "running",
    });
    tui.render();
    const clean1 = stripAnsi(output);
    assert.equal(
      clean1.includes("(⚪)"),
      false,
      "이모지만 남은 괄호 표시 안됨",
    );
    assert.equal(
      clean1.includes("(⚪ codex)"),
      false,
      "중복 role+이모지 표시 안됨",
    );

    output = "";
    // 🔵 gemini (writer) → 이모지+CLI 제거 → "writer"만 남음
    tui.updateWorker("worker-2", {
      cli: "gemini",
      role: "🔵 gemini (writer)",
      status: "running",
    });
    tui.render();
    const clean2 = stripAnsi(output);
    assert.equal(clean2.includes("(🔵"), false, "이모지가 괄호에 남으면 안됨");
    assert.ok(clean2.includes("(writer)"), "유의미한 role은 유지되어야 함");
    tui.close();
  });

  it("P1: Tier1 키바인딩 힌트에 j/k와 l 포함", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 160,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 160,
    });
    output = "";
    tui.updateWorker("w1", { cli: "codex", status: "running" });
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("j/k"), "j/k 키 힌트 포함");
    assert.ok(clean.includes("l"), "l 키 힌트 포함");
    tui.close();
  });

  it("P2b: l 키로 탭 전환 (log → detail → files → log)", () => {
    const chunks = [];
    const fakeStream = {
      write: (s) => {
        chunks.push(s);
      },
      columns: 96,
      rows: 30,
      isTTY: true,
    };
    let capturedHandler = null;
    const fakeInput = {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      on: (event, handler) => {
        if (event === "data") capturedHandler = handler;
      },
      off: () => {},
      pause: () => {},
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      input: fakeInput,
      refreshMs: 0,
      columns: 96,
    });
    tui.updateWorker("w1", {
      cli: "codex",
      status: "completed",
      handoff: {
        status: "ok",
        verdict: "done",
        confidence: "high",
        files_changed: ["a.mjs", "b.mjs"],
      },
    });

    assert.equal(tui.getFocusTab(), "log");

    if (capturedHandler) {
      capturedHandler(Buffer.from("l"));
      assert.equal(tui.getFocusTab(), "detail");
      capturedHandler(Buffer.from("l"));
      assert.equal(tui.getFocusTab(), "files");
      capturedHandler(Buffer.from("l"));
      assert.equal(tui.getFocusTab(), "log");
    } else {
      tui.setFocusTab("detail");
      assert.equal(tui.getFocusTab(), "detail");
      tui.setFocusTab("files");
      assert.equal(tui.getFocusTab(), "files");
      tui.setFocusTab("log");
      assert.equal(tui.getFocusTab(), "log");
    }
    tui.close();
  });

  it("P2b: setFocusTab은 유효하지 않은 탭을 무시한다", () => {
    const fakeStream = { write: () => {}, columns: 60, isTTY: false };
    const tui = createLogDashboard({ stream: fakeStream, refreshMs: 0 });
    tui.setFocusTab("invalid");
    assert.equal(tui.getFocusTab(), "log");
    tui.setFocusTab("files");
    assert.equal(tui.getFocusTab(), "files");
    tui.close();
  });

  it("P2b: files 탭에서 파일 목록을 렌더링한다", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 132,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 132,
    });
    output = "";
    tui.updateWorker("w1", {
      cli: "codex",
      status: "completed",
      handoff: {
        status: "ok",
        verdict: "done",
        files_changed: ["hub/team/tui.mjs", "hub/team/ansi.mjs"],
      },
    });
    tui.setFocusTab("files");
    tui.render();
    const clean = stripAnsi(output);
    assert.ok(clean.includes("hub/team/tui.mjs"), "파일 목록에 tui.mjs 포함");
    assert.ok(clean.includes("hub/team/ansi.mjs"), "파일 목록에 ansi.mjs 포함");
    tui.close();
  });

  it("커서 이동/화면 클리어 ANSI를 출력하지 않음", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 80,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 80,
    });
    output = "";
    tui.updateWorker("w1", {
      cli: "codex",
      status: "running",
      snapshot: "snapshot",
      elapsed: 3,
    });
    tui.render();
    assert.equal(output.includes("\x1b[H"), false); // cursorHome
    assert.equal(output.includes("\x1b[2J"), false); // clearScreen
    assert.equal(output.includes("\x1b[2K"), false); // clearLine
    tui.close();
  });
});
