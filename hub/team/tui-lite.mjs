import { altScreenOff, altScreenOn, BG, bold, box, clearScreen, color, cursorHide, cursorHome, cursorShow, dim, FG, MOCHA, padRight, progressBar, statusBadge, stripAnsi, truncate, wcswidth } from "./ansi.mjs";

const FALLBACK_COLUMNS = 100, FALLBACK_ROWS = 24;
const VALID_TABS = new Set(["log", "detail", "files"]);

let VERSION = "lite";
try { const { createRequire } = await import("node:module"); VERSION = createRequire(import.meta.url)("../../package.json").version; } catch {}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function sanitizeBlock(text, rawMode = false) {
  const value = String(text || "").replace(/\r/g, "");
  const cleaned = rawMode
    ? value
    : value
        .replace(/```[\s\S]*?(?:```|$)/g, "\n")
        .replace(/^\s*```.*$/gm, "")
        .replace(/^(?:PS\s+\S[^\n]*?>|>\s+|\$\s+)[^\n]*/gm, "");
  return cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "--- HANDOFF ---")
    .join("\n")
    .trim();
}

function sanitizeOneLine(text, fallback = "") {
  return sanitizeBlock(text).replace(/\s+/g, " ").trim() || fallback;
}

function sanitizeFiles(files) {
  const list = Array.isArray(files) ? files : String(files || "").split(",");
  return list.map((entry) => sanitizeOneLine(entry)).filter(Boolean);
}

function normalizeTokens(tokens) {
  if (tokens === null || tokens === undefined || tokens === "") return "";
  if (typeof tokens === "number" && Number.isFinite(tokens)) return tokens;
  const raw = sanitizeOneLine(tokens);
  const match = raw.match(/(\d+(?:[.,]\d+)?\s*[kKmM]?)/);
  return match ? match[1].replace(/\s+/g, "").toLowerCase() : raw;
}

function formatTokens(tokens) {
  if (!tokens && tokens !== 0) return "n/a";
  if (typeof tokens === "number") {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}

function wrap(text, width) {
  const limit = Math.max(8, width);
  const lines = [];
  for (const rawLine of sanitizeBlock(text).split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (wcswidth(next) <= limit) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      while (wcswidth(current) > limit) {
        lines.push(current.slice(0, limit));
        current = current.slice(limit);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

const runtimeStatus = (worker) => worker?.handoff?.status || worker?.status || "pending";

function normalizeWorkerState(existing = {}, state = {}) {
  const handoff = state.handoff === undefined
    ? existing.handoff
    : {
        ...(existing.handoff || {}),
        ...(state.handoff || {}),
        verdict: state.handoff?.verdict !== undefined ? sanitizeOneLine(state.handoff.verdict) : existing.handoff?.verdict,
        confidence: state.handoff?.confidence !== undefined ? sanitizeOneLine(state.handoff.confidence) : existing.handoff?.confidence,
        status: state.handoff?.status !== undefined ? sanitizeOneLine(state.handoff.status) : existing.handoff?.status,
        files_changed: state.handoff?.files_changed !== undefined ? sanitizeFiles(state.handoff.files_changed) : existing.handoff?.files_changed,
      };
  return {
    ...existing,
    ...state,
    cli: state.cli !== undefined ? sanitizeOneLine(state.cli, existing.cli || "codex") : (existing.cli || "codex"),
    status: state.status !== undefined ? sanitizeOneLine(state.status, existing.status || "pending") : (existing.status || "pending"),
    snapshot: state.snapshot !== undefined ? sanitizeBlock(state.snapshot) : existing.snapshot,
    summary: state.summary !== undefined ? sanitizeBlock(state.summary) : existing.summary,
    detail: state.detail !== undefined ? sanitizeBlock(state.detail) : existing.detail,
    findings: state.findings !== undefined ? sanitizeFiles(state.findings) : existing.findings,
    files_changed: state.files_changed !== undefined ? sanitizeFiles(state.files_changed) : existing.files_changed,
    confidence: state.confidence !== undefined ? sanitizeOneLine(state.confidence) : existing.confidence,
    tokens: state.tokens !== undefined ? normalizeTokens(state.tokens) : existing.tokens,
    progress: state.progress !== undefined ? clamp(Number(state.progress) || 0, 0, 1) : existing.progress,
    handoff,
  };
}

function frame(lines, width, border = MOCHA.border) {
  const body = lines.length ? lines : [dim("내용 없음")];
  const rendered = box(body.map((line) => padRight(truncate(line, width - 4), width - 4)), width, border);
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
  const line1 = color(` triflux ${VERSION} `, FG.black, BG.header)
    + ` ${bold(`phase ${pipeline.phase || "exec"}`)}`
    + ` ${dim(`+${elapsed}s`)} ${names.length} workers`;
  const line2 = `${color(`ok ${counts.ok}`, MOCHA.ok)}  ${color(`partial ${counts.partial}`, MOCHA.partial)}  ${color(`failed ${counts.failed}`, MOCHA.fail)}  ${color(`running ${counts.running}`, MOCHA.executing)}`;
  return [padRight(line1, width), padRight(line2, width)];
}

function buildWorkerRail(names, workers, selectedWorker, width) {
  const lines = names.length
    ? names.map((name, index) => {
        const worker = workers.get(name);
        const status = runtimeStatus(worker);
        const pct = Math.round(((worker?.progress ?? (status === "completed" ? 1 : 0)) || 0) * 100);
        const token = worker?.tokens ? ` tok ${formatTokens(worker.tokens)}` : "";
        const prefix = name === selectedWorker ? color("▶", MOCHA.blue) : dim("·");
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
    const files = [...sanitizeFiles(worker.handoff?.files_changed), ...sanitizeFiles(worker.files_changed)];
    detailLines.push(...(files.length ? files.map((file) => `files ${file}`) : ["files 없음"]));
  } else if (tab === "detail") {
    detailLines.push(...wrap(worker.detail || worker.summary || worker.snapshot || "", width - 4));
  } else {
    detailLines.push(...wrap(worker.summary || worker.snapshot || worker.detail || "", width - 4));
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
  let inputAttached = false;
  let rawModeEnabled = false;

  const write = (text) => { if (!closed) stream.write(text); };
  const workerNames = () => [...workers.keys()].sort();
  const viewportColumns = () => Math.max(48, columns || stream?.columns || process.stdout?.columns || FALLBACK_COLUMNS);
  const viewportRows = () => Math.max(10, rows || stream?.rows || process.stdout?.rows || FALLBACK_ROWS);
  const ensureSelection = (names) => { if (names.length && (!selectedWorker || !workers.has(selectedWorker))) selectedWorker = names[0]; };

  function selectRelative(offset) {
    const names = workerNames();
    if (names.length === 0) return;
    ensureSelection(names);
    const idx = Math.max(0, names.indexOf(selectedWorker));
    selectedWorker = names[(idx + offset + names.length) % names.length];
  }

  function triggerOpenSelected() {
    if (typeof onOpenSelectedWorker !== "function" || !selectedWorker || !workers.has(selectedWorker)) return;
    try {
      const result = onOpenSelectedWorker(selectedWorker, workers.get(selectedWorker), new Map(workers));
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function triggerOpenAll() {
    if (typeof onOpenAllWorkers !== "function") return;
    try {
      const result = onOpenAllWorkers(selectedWorker, workers.get(selectedWorker), new Map(workers));
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
      triggerOpenSelected();
      return;
    }
    if (key === "\x1b[13;2u" || key === "\x1b[27;13;2~" || key === "\x1b\r" || key === "\x1b\n") {
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
    if (!isTTY || !input?.isTTY || typeof input?.on !== "function") return;
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
    const railOnly = !detailExpanded || names.length <= 1 || width < 100 || layout === "single";
    if (railOnly) {
      const sections = [header, ...buildWorkerRail(names, workers, selectedWorker, width)];
      if (detailExpanded) sections.push(...buildDetail(selectedWorker, workers.get(selectedWorker), width, focusTab, helpVisible));
      return fitHeight(sections, width, height);
    }
    const railWidth = Math.max(28, Math.floor(width * 0.32));
    const detailWidth = width - railWidth - 1;
    const bodyHeight = Math.max(6, height - header.length);
    const rail = fitHeight(buildWorkerRail(names, workers, selectedWorker, railWidth), railWidth, bodyHeight);
    const detail = fitHeight(buildDetail(selectedWorker, workers.get(selectedWorker), detailWidth, focusTab, helpVisible), detailWidth, bodyHeight);
    return [
      ...header,
      ...Array.from({ length: bodyHeight }, (_, index) => `${rail[index]}${dim("│")}${detail[index]}`),
    ];
  }

  function render() {
    if (closed) return;
    attachInput();
    frameCount++;
    const rowsOut = buildRows();
    if (isTTY) write(cursorHome + clearScreen + rowsOut.join("\n"));
    else write(`${rowsOut.join("\n")}\n`);
  }

  function close() {
    if (closed) return;
    if (timer) clearInterval(timer);
    if (inputAttached && typeof input?.off === "function") input.off("data", handleInput);
    if (rawModeEnabled && typeof input?.setRawMode === "function") input.setRawMode(false);
    if (inputAttached && typeof input?.pause === "function") input.pause();
    if (isTTY) write(cursorShow + altScreenOff);
    closed = true;
  }

  if (isTTY) write(altScreenOn + cursorHide + clearScreen + cursorHome);
  if (refreshMs > 0) {
    timer = setInterval(render, refreshMs);
    if (timer.unref) timer.unref();
  }

  return {
    updateWorker(name, state) { workers.set(name, normalizeWorkerState(workers.get(name), state)); ensureSelection(workerNames()); },
    updatePipeline(state) { pipeline = { ...pipeline, ...state }; },
    setStartTime(ms) { startedAt = ms; },
    selectWorker(name) { if (workers.has(name)) selectedWorker = name; },
    toggleDetail(force) { detailExpanded = typeof force === "boolean" ? force : !detailExpanded; },
    render,
    getWorkers() { return new Map(workers); },
    getFrameCount() { return frameCount; },
    getPipelineState() { return { ...pipeline }; },
    getSelectedWorker() { return selectedWorker; },
    isDetailExpanded() { return detailExpanded; },
    getFocusTab() { return focusTab; },
    setFocusTab(tab) { if (VALID_TABS.has(tab)) focusTab = tab; },
    getLayout() { return layout; },
    toggleHelp(force) { helpVisible = typeof force === "boolean" ? force : !helpVisible; },
    isHelpVisible() { return helpVisible; },
    close,
  };
}
