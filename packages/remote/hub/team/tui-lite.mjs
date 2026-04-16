import {
  altScreenOff,
  altScreenOn,
  BG,
  bold,
  box,
  clearScreen,
  clearToEnd,
  color,
  cursorHide,
  cursorHome,
  cursorShow,
  dim,
  eraseBelow,
  FG,
  MOCHA,
  moveTo,
  padRight,
  progressBar,
  statusBadge,
  stripAnsi,
  truncate,
  wcswidth,
} from "./ansi.mjs";
import {
  clamp,
  formatTokens,
  loadVersion,
  normalizeWorkerState as coreNormalizeWorkerState,
  resolveViewportColumns,
  resolveViewportRows,
  runtimeStatus,
  sanitizeFiles,
  sanitizeOneLine,
  sanitizeTextBlock,
  wrapText as wrapTextFull,
  VALID_TABS as VALID_TABS_ARRAY,
} from "./tui-core.mjs";

const VERSION = await loadVersion("lite");
const VALID_TABS = new Set(VALID_TABS_ARRAY);

function wrap(text, width) {
  return wrapTextFull(text, width);
}

function normalizeWorkerState(existing = {}, state = {}) {
  return coreNormalizeWorkerState(existing, state);
}

function frame(lines, width, border = MOCHA.border) {
  const body = lines.length ? lines : [dim("내용 없음")];
  const rendered = box(
    body.map((line) => padRight(truncate(line, width - 4), width - 4)),
    width,
    border,
  );
  return [rendered.top, ...rendered.body, rendered.bot];
}

function fitHeight(lines, width, height) {
  const out = lines.slice(0, Math.max(3, height));
  while (out.length < Math.max(3, height)) out.push(" ".repeat(width));
  return out;
}

function buildHeader(width, names, workers, pipeline, startedAt) {
  const counts = { ok: 0, partial: 0, failed: 0, running: 0 };
  for (const name of names) {
    const status = runtimeStatus(workers.get(name));
    if (status === "ok" || status === "completed") counts.ok++;
    else if (status === "partial") counts.partial++;
    else if (status === "failed") counts.failed++;
    else if (status === "running" || status === "in_progress") counts.running++;
  }
  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const line1 =
    color(` triflux ${VERSION} `, FG.white, BG.header) +
    ` ${bold(`phase ${pipeline.phase || "exec"}`)}` +
    ` ${dim(`+${elapsed}s`)} ${names.length} workers`;
  const line2 = `${color(`ok ${counts.ok}`, MOCHA.ok)}  ${color(`partial ${counts.partial}`, MOCHA.partial)}  ${color(`failed ${counts.failed}`, MOCHA.fail)}  ${color(`running ${counts.running}`, MOCHA.executing)}`;
  return [padRight(line1, width), padRight(line2, width)];
}

function buildWorkerRail(names, workers, selectedWorker, width) {
  const lines = names.length
    ? names.map((name, index) => {
        const worker = workers.get(name);
        const status = runtimeStatus(worker);
        const pct = Math.round(
          ((worker?.progress ?? (status === "completed" ? 1 : 0)) || 0) * 100,
        );
        const token = worker?.tokens
          ? ` tok ${formatTokens(worker.tokens)}`
          : "";
        const prefix =
          name === selectedWorker ? color("▶", MOCHA.blue) : dim("·");
        return `${prefix} ${index + 1}.${name} ${stripAnsi(statusBadge(status))} ${pct}%${token}`;
      })
    : [dim("workers 없음")];
  return frame(lines, width);
}

function buildDetail(workerName, worker, width, tab, helpVisible) {
  if (helpVisible) {
    return frame(
      [
        bold("tui-lite"),
        "j/k or arrows: worker selection",
        "Enter: open selected worker",
        "Shift+Enter: open all workers",
        "l: tabs log/detail/files",
        "1-9: direct select, q: quit",
        "toggleDetail(false) 로 상세 패널 숨김",
      ],
      width,
      MOCHA.blue,
    );
  }
  if (!workerName || !worker) return frame([dim("선택된 워커 없음")], width);
  const detailLines = [
    bold(workerName),
    `status ${runtimeStatus(worker)}`,
    `progress ${Math.round((worker.progress || 0) * 100)}% ${progressBar(Math.round((worker.progress || 0) * 100), 12)}`,
    `tokens ${formatTokens(worker.tokens)}`,
    `confidence ${worker.handoff?.confidence || worker.confidence || "n/a"}`,
    `verdict ${worker.handoff?.verdict || worker.summary || worker.snapshot || "-"}`,
  ];
  if (tab === "files") {
    const files = [
      ...sanitizeFiles(worker.handoff?.files_changed),
      ...sanitizeFiles(worker.files_changed),
    ];
    detailLines.push(
      ...(files.length ? files.map((file) => `files ${file}`) : ["files 없음"]),
    );
  } else if (tab === "detail") {
    detailLines.push(
      ...wrap(
        worker.detail || worker.summary || worker.snapshot || "",
        width - 4,
      ),
    );
  } else {
    detailLines.push(
      ...wrap(
        worker.summary || worker.snapshot || worker.detail || "",
        width - 4,
      ),
    );
  }
  return frame(detailLines, width, MOCHA.thinking);
}

export function createLiteDashboard(opts = {}) {
  const {
    stream = process.stdout,
    input = process.stdin,
    refreshMs = 1000,
    columns,
    rows,
    layout = "auto",
    forceTTY = false,
    onOpenSelectedWorker,
    onOpenAllWorkers,
  } = opts;

  const isTTY = forceTTY || !!stream?.isTTY;
  const workers = new Map();
  let pipeline = { phase: "exec", fix_attempt: 0 };
  let startedAt = Date.now();
  let timer = null;
  let closed = false;
  let frameCount = 0;
  let selectedWorker = null;
  let detailExpanded = true;
  let focusTab = "log";
  let helpVisible = false;
  let prevFrame = [];
  let prevWidth = 0;
  let inputAttached = false;
  let rawModeEnabled = false;

  const write = (text) => {
    if (!closed) stream.write(text);
  };
  const workerNames = () => [...workers.keys()].sort();
  const viewportColumns = () => resolveViewportColumns({ columns, stream });
  const viewportRows = () => resolveViewportRows({ rows, stream });
  const ensureSelection = (names) => {
    if (names.length && (!selectedWorker || !workers.has(selectedWorker)))
      selectedWorker = names[0];
  };

  function selectRelative(offset) {
    const names = workerNames();
    if (names.length === 0) return;
    ensureSelection(names);
    const idx = Math.max(0, names.indexOf(selectedWorker));
    selectedWorker = names[(idx + offset + names.length) % names.length];
  }

  function triggerOpenSelected() {
    if (
      typeof onOpenSelectedWorker !== "function" ||
      !selectedWorker ||
      !workers.has(selectedWorker)
    )
      return;
    try {
      const result = onOpenSelectedWorker(
        selectedWorker,
        workers.get(selectedWorker),
        new Map(workers),
      );
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function triggerOpenAll() {
    if (typeof onOpenAllWorkers !== "function") return;
    try {
      const result = onOpenAllWorkers(
        selectedWorker,
        workers.get(selectedWorker),
        new Map(workers),
      );
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function handleInput(chunk) {
    const key = String(chunk);
    if (key === "\u0003") return;

    if (helpVisible) {
      helpVisible = false;
      render();
      return;
    }

    if (key === "j" || key === "\u001b[B") {
      selectRelative(1);
      render();
      return;
    }
    if (key === "k" || key === "\u001b[A") {
      selectRelative(-1);
      render();
      return;
    }
    if (key === "\r" || key === "\n") {
      if (
        typeof onOpenSelectedWorker === "function" &&
        selectedWorker &&
        workers.has(selectedWorker)
      ) {
        triggerOpenSelected();
      } else {
        // 콜백 없거나 선택 워커 없으면 탭 순환
        const tabs = ["log", "detail", "files"];
        focusTab = tabs[(tabs.indexOf(focusTab) + 1) % tabs.length];
      }
      render();
      return;
    }
    if (
      key === "\x1b[13;2u" ||
      key === "\x1b[27;13;2~" ||
      key === "\x1b\r" ||
      key === "\x1b\n"
    ) {
      triggerOpenAll();
      return;
    }
    if (key === "l") {
      const tabs = ["log", "detail", "files"];
      focusTab = tabs[(tabs.indexOf(focusTab) + 1) % tabs.length];
      render();
      return;
    }
    if (key === "h" || key === "?") {
      helpVisible = true;
      render();
      return;
    }
    if (key === "q") {
      close();
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const names = workerNames();
      const target = names[Number.parseInt(key, 10) - 1];
      if (target) {
        selectedWorker = target;
        render();
      }
    }
  }

  function attachInput() {
    if (inputAttached) return;
    if (!input?.isTTY || typeof input?.on !== "function") return;
    inputAttached = true;
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    if (typeof input.resume === "function") input.resume();
    input.on("data", handleInput);
  }

  function buildRows() {
    const names = workerNames();
    ensureSelection(names);
    const width = viewportColumns();
    const height = viewportRows();
    const header = buildHeader(width, names, workers, pipeline, startedAt);
    const railOnly =
      !detailExpanded ||
      names.length <= 1 ||
      width < 100 ||
      layout === "single";
    if (railOnly) {
      const sections = [
        header,
        ...buildWorkerRail(names, workers, selectedWorker, width),
      ];
      if (detailExpanded)
        sections.push(
          ...buildDetail(
            selectedWorker,
            workers.get(selectedWorker),
            width,
            focusTab,
            helpVisible,
          ),
        );
      return fitHeight(sections, width, height);
    }
    const railWidth = Math.max(28, Math.floor(width * 0.32));
    const detailWidth = width - railWidth - 1;
    const bodyHeight = Math.max(6, height - header.length);
    const rail = fitHeight(
      buildWorkerRail(names, workers, selectedWorker, railWidth),
      railWidth,
      bodyHeight,
    );
    const detail = fitHeight(
      buildDetail(
        selectedWorker,
        workers.get(selectedWorker),
        detailWidth,
        focusTab,
        helpVisible,
      ),
      detailWidth,
      bodyHeight,
    );
    return [
      ...header,
      ...Array.from(
        { length: bodyHeight },
        (_, index) => `${rail[index]}${dim("│")}${detail[index]}`,
      ),
    ];
  }

  function render() {
    if (closed) return;
    attachInput();
    frameCount++;
    const rowsOut = buildRows();
    if (isTTY) {
      const width = viewportColumns();
      const padded = rowsOut.map((line) => padRight(String(line ?? ""), width));
      // Full redraw on first frame or terminal resize to avoid artifacts
      if (prevFrame.length === 0 || width !== prevWidth) {
        prevWidth = width;
        write(
          cursorHome +
            padded.map((l) => l + clearToEnd).join("\n") +
            eraseBelow,
        );
        prevFrame = padded;
        return;
      }
      // Diff-based rendering: only rewrite lines that actually changed
      let buf = "";
      for (let i = 0; i < padded.length; i++) {
        if (padded[i] !== prevFrame[i]) {
          buf += moveTo(i + 1, 1) + padded[i] + clearToEnd;
        }
      }
      if (prevFrame.length > padded.length) {
        buf += moveTo(padded.length + 1, 1) + eraseBelow;
      }
      if (buf) write(buf);
      prevFrame = padded;
    } else write(`${rowsOut.join("\n")}\n`);
  }

  function close() {
    if (closed) return;
    if (timer) clearInterval(timer);
    if (inputAttached && typeof input?.off === "function")
      input.off("data", handleInput);
    if (rawModeEnabled && typeof input?.setRawMode === "function")
      input.setRawMode(false);
    if (inputAttached && typeof input?.pause === "function") input.pause();
    if (isTTY) write(cursorShow + altScreenOff);
    prevFrame = [];
    closed = true;
  }

  if (isTTY) write(altScreenOn + cursorHide + clearScreen + cursorHome);
  if (refreshMs > 0) {
    timer = setInterval(render, refreshMs);
    if (timer.unref) timer.unref();
  }

  return {
    updateWorker(name, state) {
      workers.set(name, normalizeWorkerState(workers.get(name), state));
      ensureSelection(workerNames());
    },
    updatePipeline(state) {
      pipeline = { ...pipeline, ...state };
    },
    setStartTime(ms) {
      startedAt = ms;
    },
    selectWorker(name) {
      if (workers.has(name)) selectedWorker = name;
    },
    toggleDetail(force) {
      detailExpanded = typeof force === "boolean" ? force : !detailExpanded;
    },
    render,
    getWorkers() {
      return new Map(workers);
    },
    getFrameCount() {
      return frameCount;
    },
    getPipelineState() {
      return { ...pipeline };
    },
    getSelectedWorker() {
      return selectedWorker;
    },
    isDetailExpanded() {
      return detailExpanded;
    },
    getFocusTab() {
      return focusTab;
    },
    setFocusTab(tab) {
      if (VALID_TABS.has(tab)) focusTab = tab;
    },
    getLayout() {
      return layout;
    },
    toggleHelp(force) {
      helpVisible = typeof force === "boolean" ? force : !helpVisible;
    },
    isHelpVisible() {
      return helpVisible;
    },
    close,
  };
}
