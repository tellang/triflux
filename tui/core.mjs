#!/usr/bin/env node
// tui/core.mjs — triflux interactive TUI primitives
import readline from "node:readline";

// ── ANSI Colors (hud/colors.mjs schema) ──
export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const AMBER = "\x1b[38;5;214m";
export const BLUE = "\x1b[38;5;39m";
export const WHITE = "\x1b[97m";
export const GRAY = "\x1b[38;5;245m";

// ── Screen ──

export function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

export function hideCursor() {
  process.stdout.write("\x1b[?25l");
}

export function showCursor() {
  process.stdout.write("\x1b[?25h");
}

function moveUp(n) {
  if (n > 0) process.stdout.write(`\x1b[${n}A`);
}

function clearLine() {
  process.stdout.write("\x1b[2K\r");
}

// ── Rendering ──

export function box(title, width = 50) {
  const inner = width - 2;
  const padded = ` ${title} `.slice(0, inner);
  const left = Math.floor((inner - padded.length) / 2);
  const right = inner - left - padded.length;
  console.log(`  ${DIM}┌${"─".repeat(inner)}┐${RESET}`);
  console.log(`  ${DIM}│${RESET}${" ".repeat(left)}${BOLD}${AMBER}${padded}${RESET}${" ".repeat(right)}${DIM}│${RESET}`);
  console.log(`  ${DIM}└${"─".repeat(inner)}┘${RESET}`);
}

export function divider(width = 50) {
  console.log(`  ${DIM}${"─".repeat(width - 2)}${RESET}`);
}

export function table(headers, rows, { indent = 2 } = {}) {
  const pad = " ".repeat(indent);
  const widths = headers.map((h, i) =>
    Math.max(
      stripAnsi(h).length,
      ...rows.map((r) => stripAnsi(String(r[i] ?? "")).length)
    )
  );

  const top = widths.map((w) => "─".repeat(w + 2)).join("┬");
  const mid = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const bot = widths.map((w) => "─".repeat(w + 2)).join("┴");

  const fmtRow = (cells, color = "") =>
    cells
      .map((c, i) => {
        const s = String(c ?? "");
        const visible = stripAnsi(s).length;
        return ` ${color}${s}${color ? RESET : ""}${" ".repeat(Math.max(0, widths[i] - visible))} `;
      })
      .join("│");

  console.log(`${pad}┌${top}┐`);
  console.log(`${pad}│${fmtRow(headers, BOLD)}│`);
  console.log(`${pad}├${mid}┤`);
  for (const row of rows) {
    console.log(`${pad}│${fmtRow(row)}│`);
  }
  console.log(`${pad}└${bot}┘`);
}

export function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
export function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
export function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }
export function info(msg) { console.log(`  ${CYAN}ℹ${RESET} ${msg}`); }

export function label(key, value) {
  console.log(`  ${DIM}${key}:${RESET} ${BOLD}${value}${RESET}`);
}

// ── Input: Arrow-key Select ──

export async function select(title, options, { initial = 0 } = {}) {
  if (!process.stdin.isTTY) {
    console.log(`\n  ${BOLD}${title}${RESET}`);
    for (let i = 0; i < options.length; i++) {
      const o = typeof options[i] === "string" ? options[i] : options[i].label;
      console.log(`  ${DIM}${i + 1}.${RESET} ${o}`);
    }
    const answer = await input(`선택 (1-${options.length})`, String(initial + 1));
    const idx = parseInt(answer, 10) - 1;
    return idx >= 0 && idx < options.length ? { index: idx, value: options[idx] } : null;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  hideCursor();

  let cursor = initial;
  const total = options.length;

  const getLabel = (o) => (typeof o === "string" ? o : o.label);
  const getHint = (o) => (typeof o === "object" && o.hint ? ` ${DIM}${o.hint}${RESET}` : "");

  const render = (first = false) => {
    if (!first) moveUp(total);
    for (let i = 0; i < total; i++) {
      clearLine();
      const active = i === cursor;
      const prefix = active ? `  ${CYAN}❯${RESET} ` : "    ";
      const text = active
        ? `${BOLD}${getLabel(options[i])}${RESET}`
        : `${DIM}${getLabel(options[i])}${RESET}`;
      process.stdout.write(`${prefix}${text}${getHint(options[i])}\n`);
    }
  };

  console.log(`\n  ${BOLD}${title}${RESET}\n`);
  render(true);

  return new Promise((resolve) => {
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + total) % total;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % total;
        render();
      } else if (key.name === "return") {
        cleanup();
        showCursor();
        resolve({ index: cursor, value: options[cursor] });
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        showCursor();
        resolve(null);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    process.stdin.on("keypress", onKey);
  });
}

// ── Input: Confirm ──

export async function confirm(message, defaultYes = true) {
  const hint = defaultYes ? `${BOLD}Y${RESET}${DIM}/n${RESET}` : `${DIM}y/${RESET}${BOLD}N${RESET}`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`  ${CYAN}?${RESET} ${message} [${hint}] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

// ── Input: Text ──

export async function input(message, defaultValue = "") {
  const hint = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`  ${CYAN}?${RESET} ${message}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

// ── Spinner ──

export function spinner(message) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  hideCursor();
  const id = setInterval(() => {
    clearLine();
    process.stdout.write(`  ${CYAN}${frames[i++ % frames.length]}${RESET} ${message}`);
  }, 80);

  return {
    stop(finalMsg) {
      clearInterval(id);
      clearLine();
      if (finalMsg) process.stdout.write(`${finalMsg}\n`);
      showCursor();
    },
    update(msg) {
      message = msg;
    },
  };
}

// ── Utils ──

export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// graceful exit
export function onExit(fn) {
  const handler = () => { showCursor(); fn?.(); process.exit(0); };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
