import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  openAutomaticIterm,
  parseCli,
  startOpts,
} from "../../bin/tfx-live.mjs";
import {
  closeManagedIterm,
  createLayoutBridge,
  decideLayout,
  layoutCandidates,
  layoutInput,
  layoutStatePath,
  readableTree,
  reconcilePlan,
  runItermLayout,
} from "../../hub/team/iterm-layout.mjs";

const pane = (id, more = {}) => ({
  id,
  owned: true,
  pinned: false,
  group: "g",
  cols: 250,
  rows: 90,
  minCols: 100,
  minRows: 28,
  cwd: "/repo/wt",
  ...more,
});
const snapshot = (panes = [pane("a")], more = {}) => ({
  project: "p",
  leaderId: "a",
  focusId: "user",
  fingerprint: "v1",
  windows: [
    {
      id: "w",
      tabs: [
        {
          id: "t",
          cols: 250,
          rows: 90,
          tree:
            panes.length === 1
              ? { session_id: panes[0].id }
              : {
                  vertical: true,
                  children: panes.map((s) => ({ session_id: s.id })),
                },
          sessions: panes,
        },
      ],
    },
  ],
  ...more,
});
const input = (more = {}) =>
  layoutInput({ group: "g", cwd: "/repo/wt", ...more }, {});

test("실제 최소 cols/rows와 관련 그룹을 만족하는 양방향 split만 후보가 된다", () => {
  const wide = layoutCandidates(snapshot(), input());
  assert.ok(wide.some((c) => c.kind === "split" && c.vertical));
  assert.ok(wide.some((c) => c.kind === "split" && !c.vertical));
  for (const bad of [
    pane("a", { cols: 199, rows: 55 }),
    pane("a", { group: "other" }),
    pane("a", { owned: false }),
    pane("a", { pinned: true }),
  ])
    assert.ok(
      !layoutCandidates(snapshot([bad]), input()).some(
        (c) => c.kind === "split",
      ),
    );
  assert.ok(
    !layoutCandidates(snapshot([pane("a")], { focusId: "a" }), input()).some(
      (c) => c.kind === "split",
    ),
  );
  const integrated = snapshot();
  integrated.windows[0].tabs[0].tmux = true;
  assert.ok(
    !layoutCandidates(integrated, input()).some((c) => c.kind === "split"),
  );
});

test("리드는 넓은 전용 탭, 저개입 반복 워커는 background로 폴백한다", async () => {
  const lead = await decideLayout(
    snapshot(),
    input({ role: "lead", task: "리드 작업" }),
    {
      env: { TFX_JEV: "0" },
    },
  );
  assert.equal(lead.candidate.kind, "tab");
  assert.ok(!lead.candidates.some((c) => c.kind === "background"));
  assert.equal(lead.reason, "jev_disabled");
  const low = await decideLayout(
    snapshot(),
    input({ human: "low", task: "주기적으로 상태 감시" }),
    { env: { TFX_JEV: "0" } },
  );
  assert.equal(low.candidate.kind, "background");
});

test("Jev는 후보 ID만 선택하고 신뢰도, 장애, 잘못된 ID는 이유와 함께 폴백한다", async () => {
  for (const [result, reason] of [
    [{ choice: "background", confidence: 0.95 }, "jev_selected"],
    [{ choice: "background", confidence: 0.2 }, "low_confidence"],
    [{ choice: "rm -rf /", confidence: 1 }, "invalid_candidate"],
    [null, "jev_unavailable"],
  ]) {
    const actual = await decideLayout(
      snapshot(),
      input({ task: "반복 감시" }),
      {
        env: {},
        client: async () => result,
        statsFile: false,
      },
    );
    assert.equal(actual.reason, reason);
    assert.equal(actual.source, reason === "jev_selected" ? "jev" : "rules");
    assert.ok(actual.candidates.some((c) => c.id === actual.candidate.id));
  }
  const failed = await decideLayout(snapshot(), input({ task: "반복 감시" }), {
    env: {},
    client: async () => {
      throw new Error("failure");
    },
    statsFile: false,
  });
  assert.equal(failed.reason, "jev_unavailable");
});

test("Jev 입력은 역할/작업/관계/실제 화면을 포함하고 사용자 지정은 API보다 우선한다", async () => {
  let context;
  await decideLayout(snapshot(), input({ task: "대화형 검토" }), {
    env: {},
    client: async (request) => {
      context = JSON.parse(request.context);
      assert.ok(request.options.includes("background"));
      return { choice: "background", confidence: 0.8 };
    },
    statsFile: false,
  });
  assert.equal(context.input.task, "대화형 검토");
  assert.equal(context.snapshot.windows[0].tabs[0].sessions[0].cols, 250);
  assert.equal(context.input.cwd, "/repo/wt");
  const explicit = await decideLayout(snapshot(), input({ layout: "tab" }), {
    env: {},
    client: () => assert.fail("명시 배치에서 Jev 호출"),
  });
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.candidate.kind, "tab");
  const unavailable = await decideLayout(
    snapshot([pane("a", { cols: 90 })]),
    input({ layout: "split-vertical" }),
    {},
  );
  assert.equal(unavailable.reason, "focus_preserve_overrides_layout");
  assert.equal(unavailable.candidate.kind, "tab");
});

test("프로젝트 분리도 preserve에서는 비활성 탭을 사용한다", () => {
  const actual = layoutCandidates(
    snapshot([pane("a", { owned: false, project: "other" })]),
    input(),
  );
  assert.ok(!actual.some((c) => c.kind === "window" || c.kind === "split"));
  assert.ok(actual.some((c) => c.kind === "tab"));
});

test("가독성 트리는 혼합 분할을 만들고 과밀하면 새 탭 이동을 계획한다", () => {
  const panes = ["a", "b", "c", "d"].map((id) => pane(id));
  const tree = readableTree(panes, 250, 90);
  assert.ok(tree);
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].vertical, !tree.vertical);
  assert.equal(readableTree(panes, 180, 40), null);
  const state = snapshot(panes);
  state.windows[0].tabs[0].cols = 180;
  state.windows[0].tabs[0].rows = 60;
  const plan = reconcilePlan(state);
  assert.ok(plan.changed);
  assert.equal(plan.overflow.length, 2);
  assert.equal(plan.tabs.length, 1);
  state.windows[0].tabs[0].cols = 90;
  const impossible = reconcilePlan(state);
  assert.equal(impossible.changed, false);
  assert.equal(impossible.overflow.length, 0);
  assert.equal(
    impossible.skipped[0].reason,
    "screen_below_readability_minimum",
  );
});

test("reconcile은 사람이 이동한 탭/포커스/사용자 pane/명시 배치와 tmux integration을 보존한다", () => {
  for (const more of [
    { pinned: true },
    { owned: false },
    { explicit: true },
    { id: "user" },
  ]) {
    const state = snapshot([pane("a"), pane("b", more)]);
    assert.equal(reconcilePlan(state).changed, false);
  }
  const state = snapshot([pane("a"), pane("b")]);
  state.windows[0].tabs[0].tmux = true;
  assert.equal(reconcilePlan(state).changed, false);
  assert.equal(reconcilePlan(snapshot()).changed, false);
  const uneven = snapshot([pane("a", { cols: 90 }), pane("b", { cols: 159 })]);
  assert.equal(reconcilePlan(uneven).changed, true);
});

test("runner는 판단/적용/실측을 구분하고 stale snapshot 한 번만 재판단한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iterm-layout-"));
  try {
    const calls = [];
    let applies = 0;
    const result = await runItermLayout(
      {
        project: { key: "p" },
        group: "g",
        session: "new",
        tmuxPath: "/tmux",
        layout: "tab",
      },
      {
        env: {},
        statePath: join(dir, "state"),
        noWatcher: true,
        bridge: async (action, payload) => {
          calls.push(action);
          if (action === "inventory") return { snapshot: snapshot() };
          assert.equal(payload.expected, "v1");
          if (applies++ === 0)
            throw Object.assign(new Error("stale"), {
              layoutResult: { reason: "stale_snapshot" },
            });
          return { ok: true, applied: true, verified: false, sessionId: "new" };
        },
      },
    );
    assert.deepEqual(calls, ["inventory", "open", "inventory", "open"]);
    assert.equal(result.decision.source, "explicit");
    assert.equal(result.applied, true);
    assert.equal(result.verified, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background/off/legacy/실패/부분 적용의 실행 연결과 안전한 폴백", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "focus-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const deps = {
    env: {},
    statePath: join(dir, "state.json"),
    execFile: async () => ({ stdout: process.execPath }),
    runLayout: async () => {
      throw new Error("API 없음");
    },
    openLegacy: async (...args) => {
      calls.push(args);
      return { sessionId: "fallback" };
    },
  };
  for (const layout of ["off", "background"]) {
    const result = await openAutomaticIterm(
      "s",
      "g",
      { key: "p" },
      { layout },
      deps,
    );
    assert.equal(result.iterm.verified, true);
  }
  assert.equal(calls.length, 0);
  const fallback = await openAutomaticIterm("s", "g", { key: "p" }, {}, deps);
  assert.match(fallback.warning, /Python API/);
  assert.equal(fallback.iterm.background, true);
  assert.equal(calls.length, 0);
  const blocked = await openAutomaticIterm(
    "s",
    "g",
    { key: "p" },
    { layout: "legacy" },
    deps,
  );
  assert.equal(blocked.iterm.reason, "legacy_requires_explicit_focus");
  assert.equal(calls.length, 0);
  await openAutomaticIterm(
    "s",
    "g",
    { key: "p" },
    { layout: "legacy", focus: true },
    deps,
  );
  assert.deepEqual(calls[0][3], { noSplits: true, focus: true });
  const partial = await openAutomaticIterm(
    "s",
    "g",
    { key: "p" },
    {},
    {
      ...deps,
      runLayout: async () => {
        throw Object.assign(new Error("partial"), {
          layoutResult: { partialPossible: true, verified: false },
        });
      },
    },
  );
  assert.equal(partial.iterm.verified, false);
  assert.equal(calls.length, 1);
  const flags = parseCli([
    "start",
    "--session",
    "s",
    "--background",
    "--no-auto-layout",
    "--role",
    "watcher",
    "--task",
    "감시",
  ]).flags;
  assert.equal(startOpts(flags).layout, "background");
  assert.equal(startOpts(flags).task, "감시");
});

test("Python bridge 안전성 회귀는 iTerm 없이 fake API로 실행한다", (t) => {
  const result = spawnSync(
    "python3",
    ["-B", "tests/unit/iterm-layout-bridge.test.py"],
    { encoding: "utf8" },
  );
  if (result.error?.code === "ENOENT") return t.skip("python3 없음");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("손상된 bridge 응답과 watcher 실패는 성공한 view를 중복 생성하지 않는다", async () => {
  for (const stdout of ["invalid json", "null", "{}"]) {
    const bridge = createLayoutBridge({
      env: { TFX_ITERM_PYTHON: process.execPath },
      run: async () => ({ stdout }),
    });
    await assert.rejects(
      bridge("open", {}),
      (error) =>
        error.layoutResult.partialPossible &&
        error.layoutResult.applied === null,
    );
    await assert.rejects(
      bridge("inventory", {}),
      (error) =>
        !error.layoutResult.partialPossible &&
        error.layoutResult.applied === false,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "iterm-layout-watcher-"));
  try {
    const result = await runItermLayout(
      { project: { key: "p" }, layout: "tab", group: "g", session: "new" },
      {
        env: {},
        statePath: join(dir, "state"),
        bridge: async (action) =>
          action === "inventory"
            ? { snapshot: snapshot() }
            : { ok: true, applied: true, verified: true, sessionId: "created" },
        spawn: () => {
          throw new Error("watcher failed");
        },
      },
    );
    assert.equal(result.applied, true);
    assert.equal(result.sessionId, "created");
    assert.equal(result.watcher.reason, "watcher_start_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("선택 탭의 비활성 pane도 제외하고 포커스 창을 fallback anchor로 사용한다", async () => {
  const state = snapshot([pane("a"), pane("b")], {
    focusId: "a",
    focusTabId: "t",
    focusWindowId: "w",
  });
  assert.ok(
    !layoutCandidates(state, input()).some((c) =>
      ["window", "split"].includes(c.kind),
    ),
  );
  assert.equal(reconcilePlan(state).changed, false);
  for (const layout of ["window", "split-vertical", "split-horizontal"]) {
    const result = await decideLayout(state, input({ layout }), {
      env: { TFX_JEV: "0" },
    });
    assert.equal(result.candidate.kind, "tab");
    assert.equal(result.reason, "focus_preserve_overrides_layout");
  }
  const explicit = layoutCandidates(state, input({ focus: true }));
  assert.ok(explicit.some((c) => c.kind === "window"));
  assert.ok(explicit.some((c) => c.kind === "split"));
  const user = snapshot([pane("user", { owned: false })], {
    leaderId: "missing",
    focusId: "user",
  });
  assert.equal(layoutCandidates(user, input())[0].kind, "tab");
  assert.equal(layoutCandidates(user, input())[0].windowId, "w");
  state.focusId = "elsewhere";
  state.focusTabId = "elsewhere";
  state.windows[0].selectedTabId = "t";
  assert.ok(!layoutCandidates(state, input()).some((c) => c.kind === "split"));
  assert.equal(reconcilePlan(state).changed, false);
});

test("이름은 task가 아니며 human/standard/compact 가독성과 background 자격을 구분한다", async () => {
  const nameOnly = input({ name: "반복 감시" });
  assert.equal(nameOnly.task, "");
  assert.equal(nameOnly.taskInformation, "insufficient");
  const decision = await decideLayout(snapshot(), nameOnly, {
    query: () => assert.fail("작업 정보 부족에서 Jev 호출"),
  });
  assert.equal(decision.reason, "insufficient_task_information");
  assert.ok(["tab", "split"].includes(decision.candidate.kind));
  assert.ok(
    !layoutCandidates(snapshot(), nameOnly).some(
      (c) => c.kind === "background",
    ),
  );
  for (const options of [
    { task: "실제 감시" },
    { human: "low" },
    { layout: "background" },
  ])
    assert.ok(
      layoutCandidates(snapshot(), input(options)).some(
        (c) => c.kind === "background",
      ),
    );
  for (const options of [
    { role: "lead" },
    { human: "high" },
    { role: "communication" },
  ]) {
    const data = input({ ...options, task: "주기 감시" });
    assert.deepEqual([data.minCols, data.minRows], [100, 24]);
    assert.ok(
      !layoutCandidates(snapshot(), data).some((c) => c.kind === "background"),
    );
  }
  assert.deepEqual([nameOnly.minCols, nameOnly.minRows], [80, 20]);
  const low = input({ human: "low" });
  assert.deepEqual([low.minCols, low.minRows], [60, 10]);
  const compact = snapshot([
    pane("a", { cols: 121, rows: 10, minCols: 60, minRows: 10 }),
  ]);
  assert.ok(
    layoutCandidates(compact, low).some(
      (c) => c.kind === "split" && c.cols === 60,
    ),
  );
});

test("API 장애와 opt-out은 UI 없이 메타데이터를 남겨 inspect와 attach로 찾는다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "focus-background-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deps = {
    env: { TMPDIR: dir },
    bridge: async () => {
      throw new Error("unavailable");
    },
  };
  const request = {
    project: { key: "p" },
    session: "lead",
    role: "lead",
    task: "실제 작업",
    focus: true,
  };
  const result = await runItermLayout(request, deps);
  assert.equal(result.background, true);
  assert.equal(result.nativeSessionId, null);
  assert.equal(result.attention.required, true);
  assert.deepEqual(result.focus, {
    requested: "focus",
    effective: "preserve",
    transitioned: false,
    reason: "python_api_unavailable",
  });
  const inspect = await runItermLayout(
    { action: "inspect", project: request.project },
    deps,
  );
  assert.equal(inspect.background[0].input.task, "실제 작업");
  assert.equal(inspect.background[0].tmuxSession, "lead");
  assert.ok(inspect.background[0].attach.includes("attach-session"));
  const removed = await closeManagedIterm("", "lead", deps);
  assert.equal(removed.background, true);
  const after = await runItermLayout(
    { action: "inspect", project: request.project },
    deps,
  );
  assert.equal(after.background.length, 0);
  const noAnchor = await runItermLayout(
    { project: { key: "p" }, session: "name-only", name: "이름만" },
    {
      ...deps,
      bridge: async () => ({ snapshot: { windows: [] } }),
    },
  );
  assert.equal(noAnchor.reason, "no_safe_visible_candidate");
  assert.equal(noAnchor.attention.required, true);
  assert.ok(!noAnchor.decision.candidates.some((c) => c.kind === "background"));
  for (const layout of ["off", "background"]) {
    const kept = await runItermLayout(
      { ...request, layout },
      { ...deps, bridge: () => assert.fail("UI/API 호출") },
    );
    assert.equal(kept.background, true);
    assert.equal(kept.applied, false);
  }
  assert.ok(layoutStatePath("p", deps.env).startsWith(dir));
});

test("focus와 reset-pins CLI 의도를 전달하고 dry-run에서는 pin을 변경하지 않는다", async (t) => {
  const flags = parseCli([
    "start",
    "--session",
    "s",
    "--focus",
    "--no-auto-layout",
  ]).flags;
  assert.equal(startOpts(flags).focus, true);
  assert.equal(startOpts(flags).layout, "off");
  const dir = mkdtempSync(join(tmpdir(), "focus-reset-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const dryRun of [true, false]) {
    await runItermLayout(
      { action: "reconcile", project: { key: "p" }, resetPins: true, dryRun },
      {
        env: {},
        statePath: join(dir, "state.json"),
        bridge: async (action, payload) => {
          assert.equal(action, "inventory");
          assert.equal(payload.resetPins, !dryRun);
          return { snapshot: snapshot() };
        },
      },
    );
  }
});
