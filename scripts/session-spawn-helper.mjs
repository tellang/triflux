#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";

const SESSION_PREFIX = "tfx-isolated";
const DEFAULT_ATTACH_PROFILE = "triflux";
const SESSION_EXPIRE_MS = 30 * 60 * 1000;

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "that", "the", "to", "with",
  "작업", "요청", "합니다", "그리고", "에서", "으로",
]);

// ── psmux helpers ──

function hasPsmux() {
  try {
    execFileSync("psmux", ["-V"], { timeout: 2000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function psmux(...args) {
  execFileSync("psmux", args, { timeout: 5000, stdio: "ignore" });
}

function psmuxCapture(sessionName) {
  try {
    return execFileSync("psmux", ["capture-pane", "-t", sessionName, "-p"], {
      timeout: 5000, encoding: "utf8",
    }).trim();
  } catch { return ""; }
}

function psmuxHasSession(sessionName) {
  try {
    execFileSync("psmux", ["has-session", "-t", sessionName], { timeout: 2000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

// ── core functions ──

export function createIsolatedSessionName(timestamp = Date.now()) {
  return `${SESSION_PREFIX}-${Math.trunc(timestamp)}`;
}

export function createIsolatedSession(options = {}) {
  const ts = options.timestamp ?? Date.now();
  const sessionName = options.name || createIsolatedSessionName(ts);

  psmux("new-session", "-s", sessionName, "-d");

  // cd to project root
  const projectRoot = options.projectRoot || process.cwd();
  psmux("send-keys", "-t", sessionName, `cd '${projectRoot}'`, "Enter");

  // send prompt as claude command
  if (options.prompt) {
    const safePrompt = options.prompt.replace(/'/g, "'\\''");
    psmux("send-keys", "-t", sessionName, `claude --prompt '${safePrompt}'`, "Enter");
  }

  return { sessionName };
}

export function attachWithWindowsTerminal(sessionName, options = {}) {
  const profile = options.profile || DEFAULT_ATTACH_PROFILE;
  const title = options.title || sessionName;

  // sp (split-pane), not new-tab
  const wtArgs = ["sp", "-p", profile, "--title", title, "--", "psmux", "attach-session", "-t", sessionName];
  const child = spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return wtArgs;
}

export function waitForCompletion(sessionName, opts = {}) {
  const pollMs = opts.pollMs || 3000;
  const maxMs = opts.maxMs || SESSION_EXPIRE_MS;
  const start = Date.now();

  return new Promise((res) => {
    const check = () => {
      if (!psmuxHasSession(sessionName) || Date.now() - start > maxMs) {
        const output = psmuxCapture(sessionName);
        // cleanup expired session
        try { psmux("kill-session", "-t", sessionName); } catch {}
        res({ sessionName, output, expired: Date.now() - start > maxMs });
        return;
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

// ── context drift (kept from codex) ──

function tokenize(text) {
  return String(text || "").toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

export function evaluateContextDrift(input = {}) {
  const taskTokens = Array.from(new Set(tokenize(input.taskPrompt)));
  if (!taskTokens.length) return { drift: false, overlapRatio: 1, reason: "task-token-empty" };

  const outputTokens = new Set(tokenize(input.latestOutput));
  const matched = taskTokens.filter((t) => outputTokens.has(t));
  const ratio = matched.length / taskTokens.length;
  const threshold = input.minOverlapRatio ?? 0.2;

  return { drift: ratio < threshold, overlapRatio: ratio, reason: ratio < threshold ? "token-overlap-low" : "token-overlap-ok" };
}

// ── CLI ──

function parseArgs(argv) {
  const a = { spawn: false, prompt: "", attach: false, background: false, name: "" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--spawn") { a.spawn = true; continue; }
    if (arg === "--attach") { a.attach = true; continue; }
    if (arg === "--background") { a.background = true; continue; }
    if ((arg === "--prompt" || arg === "-p") && argv[i + 1]) { a.prompt = argv[++i]; continue; }
    if ((arg === "--name" || arg === "-n") && argv[i + 1]) { a.name = argv[++i]; continue; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.spawn) {
    process.stdout.write([
      "session-spawn-helper: psmux 격리 세션 생성 도구",
      "",
      "사용법:",
      "  node scripts/session-spawn-helper.mjs --spawn --prompt '작업 내용' [--attach] [--background] [--name 세션명]",
      "",
      "옵션:",
      "  --spawn        세션 생성 (필수)",
      "  --prompt TEXT   Claude에 전달할 프롬프트",
      "  --attach        WT split-pane으로 attach",
      "  --background    attach 없이 실행, 완료 시 결과 출력",
      "  --name NAME     세션 이름 (기본: tfx-isolated-{ts})",
      "",
    ].join("\n"));
    process.exit(0);
  }

  if (!hasPsmux()) {
    process.stderr.write("ERROR: psmux가 설치되어 있지 않습니다. npm install -g psmux\n");
    process.exit(1);
  }

  const { sessionName } = createIsolatedSession({
    name: args.name || undefined,
    prompt: args.prompt || undefined,
    projectRoot: process.cwd(),
  });

  process.stdout.write(`[session-spawn] 세션 생성: ${sessionName}\n`);

  if (args.attach) {
    attachWithWindowsTerminal(sessionName);
    process.stdout.write(`[session-spawn] WT split-pane attach 완료\n`);
  }

  if (args.background) {
    process.stdout.write(`[session-spawn] 백그라운드 대기 중...\n`);
    const result = await waitForCompletion(sessionName);
    const preview = (result.output || "(no output)").slice(0, 200);
    process.stdout.write(`[session-spawn] 완료: ${sessionName} | expired=${result.expired} | preview=${preview}\n`);
  }
}

if (process.argv[1]?.endsWith("session-spawn-helper.mjs")) {
  main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
