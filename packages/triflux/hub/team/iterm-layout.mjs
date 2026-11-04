// Jev는 실현 가능한 후보 ID만 고르고, bridge가 소유권과 최신 화면을 재검사한다.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isJevEnabled, queryJev } from "../lib/jev-addon.mjs";
import { privateTmpDir } from "../lib/private-tmp.mjs";

const exec = promisify(execFile);
const MODULE = fileURLToPath(import.meta.url);
const BRIDGE = join(dirname(MODULE), "iterm-layout.py");
export const LAYOUT_MODES = [
  "auto",
  "off",
  "legacy",
  "background",
  "tab",
  "window",
  "split-vertical",
  "split-horizontal",
];

export function layoutInput(options = {}, env = process.env) {
  const mode =
    options.layout ??
    (env.TFX_ITERM_LAYOUT === "0" ? "off" : env.TFX_ITERM_LAYOUT || "auto");
  if (!LAYOUT_MODES.includes(mode))
    throw new Error(`--layout: ${LAYOUT_MODES.join("|")}`);
  const role = String(options.role || "worker").slice(0, 120);
  const human = options.human ?? (role === "lead" ? "high" : "unknown");
  if (!["high", "low", "unknown"].includes(human))
    throw new Error("--human: high|low|unknown");
  const task = String(options.task || "")
    .trim()
    .slice(0, 1600);
  const interactive =
    human === "high" || ["lead", "communication"].includes(role);
  return {
    mode,
    focusPolicy: options.focus ? "focus" : "preserve",
    taskInformation: task ? "provided" : "insufficient",
    role,
    human,
    task,
    cwd: resolve(options.cwd || process.cwd()),
    group: options.group,
    titleGroup: options.titleGroup || options.group,
    name: options.name,
    minCols: interactive ? 100 : human === "low" ? 60 : 80,
    minRows: interactive ? 24 : human === "low" ? 10 : 20,
  };
}

function managedTab(tab) {
  return (
    !tab.tmux &&
    tab.sessions.length > 0 &&
    tab.sessions.every((s) => s.owned && !s.pinned)
  );
}

function selectedTab(snapshot, window, tab) {
  return (
    tab.selected ||
    window.selectedTabId === tab.id ||
    snapshot.focusTabId === tab.id ||
    tab.sessions.some((s) => s.id === snapshot.focusId)
  );
}

export function layoutCandidates(snapshot, input) {
  const windows = snapshot.windows || [];
  const leader = windows.find((w) =>
    w.tabs.some((t) => t.sessions.some((s) => s.id === snapshot.leaderId)),
  );
  const projectWindow = windows.find((w) =>
    w.tabs.some((t) => t.sessions.some((s) => s.owned)),
  );
  // 리드 ID가 사라져도 현재 입력 대상의 창은 읽기 전용 anchor로 쓴다.
  const focusedWindow = windows.find(
    (w) =>
      w.id === snapshot.focusWindowId ||
      w.tabs.some((t) => t.sessions.some((s) => s.id === snapshot.focusId)),
  );
  const target = projectWindow || leader || focusedWindow;
  const candidates = [];
  if (
    input.human !== "high" &&
    !["lead", "communication"].includes(input.role) &&
    (input.taskInformation === "provided" ||
      input.human === "low" ||
      input.mode === "background")
  )
    candidates.push({
      id: "background",
      kind: "background",
      reason: "unattended_tmux",
      score: input.human === "low" ? 100 : -10,
    });
  if (!target) {
    if (input.focusPolicy === "focus")
      candidates.push({
        id: "window",
        kind: "window",
        reason: "no_existing_window",
        score: 5,
      });
    return candidates;
  }
  const otherProject =
    !projectWindow &&
    target.tabs.some((t) =>
      t.sessions.some((s) => s.project && s.project !== snapshot.project),
    );
  if (input.focusPolicy === "focus")
    candidates.push({
      id: "window",
      kind: "window",
      reason: "project_separation",
      score: otherProject ? 90 : 5,
    });
  if (otherProject && input.focusPolicy === "focus") return candidates;
  candidates.push({
    id: `tab:${target.id}`,
    kind: "tab",
    windowId: target.id,
    reason: otherProject
      ? "focus_preserve_project_separation_deferred"
      : "readable_inactive_tab",
    score: input.human === "high" || input.role === "lead" ? 100 : 10,
  });
  for (const tab of target.tabs) {
    if (
      !managedTab(tab) ||
      (input.focusPolicy !== "focus" && selectedTab(snapshot, target, tab)) ||
      !tab.sessions.every((s) => s.group === input.group)
    )
      continue;
    for (const session of tab.sessions) {
      if (
        (input.focusPolicy !== "focus" && session.id === snapshot.focusId) ||
        session.human === "high" ||
        ["lead", "communication"].includes(session.role)
      )
        continue;
      for (const vertical of [true, false]) {
        const minCols = Math.max(input.minCols, session.minCols || 80);
        const minRows = Math.max(input.minRows, session.minRows || 20);
        const cols = vertical
          ? Math.floor((session.cols - 1) / 2)
          : session.cols;
        const rows = vertical
          ? session.rows
          : Math.floor((session.rows - 1) / 2);
        if (cols < minCols || rows < minRows) continue;
        candidates.push({
          id: `split:${session.id}:${vertical ? "v" : "h"}`,
          kind: "split",
          sessionId: session.id,
          tabId: tab.id,
          vertical,
          cols,
          rows,
          minCols,
          minRows,
          reason: "related_readable_neighbor",
          score:
            40 +
            Math.min(cols / minCols, rows / minRows) +
            (session.cwd === input.cwd ? 5 : 0),
        });
      }
    }
  }
  return candidates;
}

export async function decideLayout(snapshot, input, options = {}) {
  const candidates = layoutCandidates(snapshot, input);
  const explicit = input.mode !== "auto";
  let eligible = candidates;
  if (explicit)
    eligible = candidates.filter(
      (c) =>
        c.kind === input.mode ||
        (c.kind === "split" &&
          input.mode === `split-${c.vertical ? "vertical" : "horizontal"}`),
    );
  let fallback = [...eligible].sort((a, b) => b.score - a.score)[0] || null;
  const focusOverride =
    explicit &&
    !fallback &&
    input.focusPolicy === "preserve" &&
    (input.mode === "window" || input.mode.startsWith("split-"));
  if (focusOverride)
    fallback = candidates.find((c) => c.kind === "tab") || null;
  if (explicit)
    return {
      source: "explicit",
      reason: focusOverride
        ? "focus_preserve_overrides_layout"
        : fallback
          ? "user_layout"
          : "requested_layout_unavailable",
      candidate: fallback,
      candidates,
    };
  if (input.taskInformation === "insufficient")
    return {
      source: "rules",
      reason: "insufficient_task_information",
      candidate: fallback,
      candidates,
    };
  if (!isJevEnabled(options))
    return {
      source: "rules",
      reason: "jev_disabled",
      candidate: fallback,
      candidates,
    };
  if (!candidates.length)
    return {
      source: "rules",
      reason: "no_feasible_candidate",
      candidate: null,
      candidates,
    };
  const result = await (options.query || queryJev)(
    {
      hook: "iterm_layout",
      kind: "choice",
      options: candidates.map((c) => c.id),
      query:
        "Select one feasible placement ID. Infer task similarity, communication, importance, and likelihood of human input. Leads and communication need readable visible space; repetitive unattended work may stay in background tmux; important unattended work should be inspectable. Prefer related workers and same worktree adjacent. Never emit commands or coordinates.",
      criteria: Object.fromEntries(
        candidates.map((c) => [
          c.id,
          c.kind === "background"
            ? "Run an unattended resident or repetitive worker without a visible terminal; keep it attachable. Prefer this when human interaction is unlikely."
            : c.kind === "split"
              ? "Place this worker in a readable pane next to related work, without changing the user keyboard focus."
              : c.kind === "window"
                ? "Create a separate visible project window, only with explicit permission to change focus."
                : "Keep this worker visible in its own readable inactive tab, especially for leads, communication, important decisions or frequent human input.",
        ]),
      ),
      context: JSON.stringify({
        input,
        snapshot: {
          windows: (snapshot.windows || [])
            .map((w) => ({
              id: w.id,
              tabs: w.tabs
                .filter((t) => t.sessions.some((s) => s.owned))
                .map((t) => ({
                  id: t.id,
                  cols: t.cols,
                  rows: t.rows,
                  sessions: t.sessions
                    .filter((s) => s.owned)
                    .map((s) => ({
                      id: s.id,
                      task: s.task,
                      role: s.role,
                      human: s.human,
                      group: s.group,
                      cwd: s.cwd,
                      cols: s.cols,
                      rows: s.rows,
                    })),
                })),
            }))
            .filter((w) => w.tabs.length),
        },
        candidates,
      }),
    },
    options,
  ).catch(() => null);
  const confidence = Number(result?.confidence);
  const selected = candidates.find((c) => c.id === result?.choice);
  const threshold = Number(
    options.minConfidence ??
      options.env?.TFX_JEV_MIN_CONFIDENCE ??
      process.env.TFX_JEV_MIN_CONFIDENCE ??
      0.7,
  );
  const accepted =
    selected &&
    Number.isFinite(confidence) &&
    confidence >= (Number.isFinite(threshold) ? threshold : 0.7);
  return {
    source: accepted ? "jev" : "rules",
    reason: accepted
      ? "jev_selected"
      : !result
        ? "jev_unavailable"
        : !selected
          ? "invalid_candidate"
          : "low_confidence",
    confidence: Number.isFinite(confidence) ? confidence : null,
    candidate: accepted ? selected : fallback,
    candidates,
  };
}

// 등분 뒤에도 모든 pane의 최소 크기를 지킬 수 있는 트리만 반환한다.
export function readableTree(sessions, cols, rows, parent = null) {
  if (!sessions.length) return null;
  if (sessions.length === 1)
    return cols >= (sessions[0].minCols || 80) &&
      rows >= (sessions[0].minRows || 20)
      ? { session_id: sessions[0].id }
      : null;
  const minCols = Math.max(...sessions.map((s) => s.minCols || 80));
  const minRows = Math.max(...sessions.map((s) => s.minRows || 20));
  const directions =
    cols / minCols > rows / minRows ? [true, false] : [false, true];
  for (const vertical of directions) {
    if (vertical === parent) continue;
    for (let count = 2; count <= sessions.length; count++) {
      const width = vertical ? Math.floor((cols - count + 1) / count) : cols;
      const height = vertical ? rows : Math.floor((rows - count + 1) / count);
      if (width < minCols || height < minRows) break;
      const children = [];
      for (let i = 0; i < count; i++) {
        const from = Math.floor((i * sessions.length) / count);
        const to = Math.floor(((i + 1) * sessions.length) / count);
        children.push(
          readableTree(sessions.slice(from, to), width, height, vertical),
        );
      }
      if (children.every(Boolean)) return { vertical, children };
    }
  }
  return null;
}

export function reconcilePlan(snapshot) {
  const tabs = [],
    overflow = [],
    skipped = [];
  for (const window of snapshot.windows || [])
    for (const tab of window.tabs) {
      if (!tab.sessions.some((s) => s.owned)) continue;
      if (
        !managedTab(tab) ||
        selectedTab(snapshot, window, tab) ||
        tab.sessions.some((s) => s.id === snapshot.focusId || s.explicit)
      ) {
        skipped.push({
          tabId: tab.id,
          reason: tab.tmux ? "tmux_integration" : "focus_manual_or_unowned",
        });
        continue;
      }
      const keep = [...tab.sessions];
      const tabOverflow = [];
      let tree = readableTree(keep, tab.cols, tab.rows);
      while (!tree && keep.length > 1) {
        const session = keep.pop();
        tabOverflow.push({
          sessionId: session.id,
          windowId: window.id,
          sourceTabId: tab.id,
        });
        tree = readableTree(keep, tab.cols, tab.rows);
      }
      if (!tree) {
        skipped.push({
          tabId: tab.id,
          reason: "screen_below_readability_minimum",
        });
        continue;
      }
      overflow.push(...tabOverflow);
      const unreadable = keep.some(
        (s) => s.cols < (s.minCols || 80) || s.rows < (s.minRows || 20),
      );
      if (
        tree &&
        (unreadable || JSON.stringify(tree) !== JSON.stringify(tab.tree))
      )
        tabs.push({ tab_id: tab.id, root: tree });
    }
  return {
    tabs,
    overflow,
    skipped,
    changed: tabs.length > 0 || overflow.length > 0,
  };
}

export function layoutStatePath(project, env = process.env) {
  const key = createHash("sha256")
    .update(`${hostname()}\0${project}`)
    .digest("hex")
    .slice(0, 24);
  return join(
    privateTmpDir("iterm-layout", env.TMPDIR ? { base: env.TMPDIR } : {}),
    `${key}.json`,
  );
}

export function findItermPython(env = process.env) {
  if (env.TFX_ITERM_PYTHON) return env.TFX_ITERM_PYTHON;
  const root = join(
    env.HOME || homedir(),
    "Library/Application Support/iTerm2",
  );
  for (const base of ["uv/venvs", "iterm2env/versions"]) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const version of readdirSync(dir).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    )) {
      const python = join(dir, version, "bin/python3");
      if (existsSync(python)) return python;
    }
  }
  return null;
}

export function createLayoutBridge({ env = process.env, run = exec } = {}) {
  const python = findItermPython(env);
  return async (action, payload) => {
    if (!python)
      throw new Error(
        "iTerm Python runtime 없음: iTerm2 Python API/runtime을 활성화하세요",
      );
    let stdout;
    try {
      ({ stdout } = await run(
        python,
        [BRIDGE, action, JSON.stringify(payload)],
        { env, timeout: 12000, maxBuffer: 2 * 1024 * 1024 },
      ));
    } catch {
      throw Object.assign(new Error("iTerm Python API 연결/실행 실패"), {
        layoutResult: {
          ok: false,
          applied: action === "inventory" ? false : null,
          verified: false,
          partialPossible: action !== "inventory",
        },
      });
    }
    let result;
    try {
      result = JSON.parse(stdout);
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.ok !== "boolean"
      )
        throw new Error("invalid_response");
    } catch {
      throw Object.assign(new Error("iTerm bridge 응답을 확인할 수 없습니다"), {
        layoutResult: {
          ok: false,
          reason: "invalid_bridge_response",
          applied: action === "inventory" ? false : null,
          verified: false,
          partialPossible: action !== "inventory",
        },
      });
    }
    if (!result.ok)
      throw Object.assign(new Error(result.reason || "iTerm API 실패"), {
        layoutResult: result,
      });
    return result;
  };
}

export function focusReport(
  input,
  reason,
  effective = "preserve",
  transitioned = false,
) {
  return { requested: input.focusPolicy, effective, transitioned, reason };
}

export function backgroundLayout(
  request,
  input,
  reason,
  deps = {},
  decision = null,
) {
  const statePath =
    deps.statePath ||
    request.statePath ||
    layoutStatePath(request.project.key, deps.env || process.env);
  const directory = `${statePath}.background`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(request.session).digest("hex");
  const record = {
    tmuxSession: request.session,
    nativeSessionId: null,
    background: true,
    input,
    decision,
    reason,
    attach: [
      request.tmuxPath || "tmux",
      "attach-session",
      "-t",
      `=${request.session}`,
    ],
    list: ["tfx-live", "list-sessions", "--cli", request.cli || "claude"],
    runtimeState: "not_checked",
  };
  const path = join(directory, `${name}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, path);
  return {
    ok: true,
    ...record,
    applied: false,
    verified: true,
    focus: focusReport(input, reason),
    taskInformation: input.taskInformation,
    attention: {
      required:
        input.human === "high" ||
        ["lead", "communication"].includes(input.role) ||
        !["user_background", "layout_disabled", "unattended_tmux"].includes(
          reason,
        ),
      reason,
    },
  };
}

function backgroundRecords(statePath) {
  const directory = `${statePath}.background`;
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

export async function runItermLayout(request, deps = {}) {
  const env = deps.env || process.env;
  const input = layoutInput(request, env);
  const bridge = deps.bridge || createLayoutBridge({ env });
  const base = {
    project: request.project.key,
    statePath:
      deps.statePath ||
      request.statePath ||
      layoutStatePath(request.project.key, env),
    leaderId: env.ITERM_SESSION_ID?.split(":").at(-1) || "",
    leaderTty: request.leaderTty || "",
    focusPolicy: input.focusPolicy,
  };
  if (!request.action && ["off", "background"].includes(input.mode))
    return backgroundLayout(
      request,
      input,
      input.mode === "off" ? "layout_disabled" : "user_background",
      { ...deps, statePath: base.statePath },
    );
  let inventory;
  try {
    inventory = await bridge("inventory", {
      ...base,
      resetPins:
        request.action === "reconcile" && request.resetPins && !request.dryRun,
    });
  } catch {
    if (request.action)
      return {
        ok: false,
        reason: "python_api_unavailable",
        applied: false,
        verified: false,
        background: backgroundRecords(base.statePath),
        focus: focusReport(input, "python_api_unavailable"),
      };
    return backgroundLayout(request, input, "python_api_unavailable", {
      ...deps,
      statePath: base.statePath,
    });
  }
  const snapshot = inventory.snapshot;
  if (request.action === "inspect")
    return {
      ok: true,
      snapshot,
      background: backgroundRecords(base.statePath),
      focus: focusReport(input, "inspection_only"),
      lastReconcile: inventory.lastReconcile ?? null,
      plan: reconcilePlan(snapshot),
      applied: false,
      verified: false,
    };
  if (request.action === "reconcile") {
    const plan = reconcilePlan(snapshot);
    if (!plan.changed || request.dryRun)
      return {
        ok: true,
        plan,
        applied: false,
        verified: !plan.changed && !plan.skipped.length,
        reason: request.dryRun ? "dry_run" : "no_change",
        focus: focusReport(input, "selected_tabs_excluded"),
      };
    try {
      const result = await bridge("reconcile", {
        ...base,
        expected: snapshot.fingerprint,
        plan,
      });
      return {
        ...result,
        focus: result.focus || focusReport(input, "selected_tabs_excluded"),
      };
    } catch (error) {
      if (error.layoutResult?.reason === "stale_snapshot" && !deps.retried)
        return runItermLayout(
          { ...request, resetPins: false },
          {
            ...deps,
            retried: true,
          },
        );
      if (error.layoutResult)
        return {
          ...error.layoutResult,
          plan,
          focus: focusReport(input, error.layoutResult.reason, "unknown", null),
        };
      throw error;
    }
  }
  const decision = await decideLayout(
    snapshot,
    input,
    deps.jevOptions || { env },
  );
  if (!decision.candidate || decision.candidate.kind === "background")
    return backgroundLayout(
      request,
      input,
      decision.candidate
        ? decision.candidate.reason
        : "no_safe_visible_candidate",
      { ...deps, statePath: base.statePath },
      decision,
    );
  let applied;
  try {
    applied = await bridge("open", {
      ...base,
      expected: snapshot.fingerprint,
      candidate: decision.candidate,
      input,
      session: request.session,
      tmuxPath: request.tmuxPath,
    });
  } catch (error) {
    if (error.layoutResult?.reason === "stale_snapshot" && !deps.retried)
      return runItermLayout(request, { ...deps, retried: true });
    if (
      error.layoutResult?.partialPossible ||
      error.layoutResult?.reason === "stale_snapshot"
    )
      return {
        ...error.layoutResult,
        decision,
        taskInformation: input.taskInformation,
        focus: focusReport(
          input,
          error.layoutResult.reason || "partial_application_unknown",
          "unknown",
          null,
        ),
      };
    return backgroundLayout(
      request,
      input,
      "python_api_unavailable",
      { ...deps, statePath: base.statePath },
      decision,
    );
  }
  let watcher;
  if (
    applied.ok &&
    applied.sessionId &&
    !deps.noWatcher &&
    env.TFX_ITERM_WATCH !== "0"
  ) {
    try {
      const child = (deps.spawn || spawn)(
        findItermPython(env),
        [
          BRIDGE,
          "watch",
          JSON.stringify({ ...base, node: process.execPath, module: MODULE }),
        ],
        { detached: true, stdio: "ignore", env },
      );
      child.on("error", () =>
        process.stderr.write("iTerm layout watcher 시작 실패\n"),
      );
      child.unref();
      watcher = { requested: true, pid: child.pid ?? null, confirmed: false };
    } catch {
      watcher = {
        requested: true,
        confirmed: false,
        reason: "watcher_start_failed",
      };
    }
  }
  if (applied.sessionId) {
    const name = createHash("sha256").update(request.session).digest("hex");
    rmSync(join(`${base.statePath}.background`, `${name}.json`), {
      force: true,
    });
  }
  return {
    ...applied,
    decision,
    taskInformation: input.taskInformation,
    focus: applied.focus || focusReport(input, decision.reason),
    attention: {
      required:
        input.human === "high" ||
        ["lead", "communication"].includes(input.role),
      reason: "role_metadata",
    },
    ...(watcher ? { watcher } : {}),
  };
}

export async function closeManagedIterm(sessionId, session, deps = {}) {
  const env = deps.env || process.env;
  const directory = dirname(layoutStatePath("", env));
  let removedBackground = false;
  const name = createHash("sha256").update(session).digest("hex");
  for (const folder of readdirSync(directory).filter((entry) =>
    /^[a-f0-9]{24}\.json\.background$/.test(entry),
  )) {
    const path = join(directory, folder, `${name}.json`);
    if (existsSync(path)) {
      rmSync(path);
      removedBackground = true;
    }
  }
  for (const file of readdirSync(directory).filter((name) =>
    /^[a-f0-9]{24}\.json$/.test(name),
  )) {
    const statePath = join(directory, file);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      !Object.entries(state.records || {}).some(
        ([sid, record]) =>
          record.session === session && (!sessionId || sid === sessionId),
      )
    )
      continue;
    const bridge = deps.bridge || createLayoutBridge({ env });
    return bridge("close", {
      statePath,
      project: state.project,
      sessionId,
      session,
    });
  }
  return removedBackground
    ? {
        ok: true,
        background: true,
        applied: false,
        verified: true,
        closedIds: [],
      }
    : null;
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE) {
  const request = JSON.parse(process.argv[2]);
  runItermLayout(request)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stdout.write(
        '{"ok":false,"reason":"reconcile_failed","applied":false,"verified":false}\n',
      );
      process.exitCode = 1;
    });
}
