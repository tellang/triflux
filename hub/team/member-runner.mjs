// hub/team/member-runner.mjs — wt pane 내부에서 CLI 실행 + Hub 제어 수신
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === "--config" && argv[i + 1]) {
      out.config = argv[++i];
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCli(cli) {
  const v = String(cli || "other").toLowerCase();
  if (v === "codex" || v === "gemini" || v === "claude") return v;
  return "other";
}

function safeText(v, fallback = "") {
  if (v == null) return fallback;
  return String(v);
}

async function loadPtyModule() {
  try {
    const mod = await import("node-pty");
    if (typeof mod?.spawn === "function") return mod;
    if (typeof mod?.default?.spawn === "function") return mod.default;
  } catch {
    // 아래에서 공통 에러 처리
  }
  throw new Error("node-pty 로드 실패");
}

function buildShellExec(command) {
  if (process.platform === "win32") {
    return {
      file: "pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", command],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
      },
    };
  }
  return {
    file: "bash",
    args: ["-lc", command],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
    },
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error("사용법: node member-runner.mjs --config <path>");
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(args.config, "utf8"));
} catch (e) {
  console.error(`runner 설정 파일 로드 실패: ${e.message}`);
  process.exit(1);
}

const {
  name,
  role = "worker",
  cli,
  agentId,
  command,
  hubUrl = "http://127.0.0.1:27888/mcp",
  prompt = "",
  pollMs = 1000,
  startupDelayMs = 2400,
  timeoutSec = 10800,
} = cfg;

if (!name || !agentId || !command) {
  console.error("runner 설정 오류: name/agentId/command 필수");
  process.exit(1);
}

const hubBase = String(hubUrl).replace(/\/mcp$/, "");
let stopping = false;
let paused = false;

async function post(path, body, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${hubBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function registerSelf() {
  await post("/bridge/register", {
    agent_id: agentId,
    cli: normalizeCli(cli),
    timeout_sec: timeoutSec,
    topics: ["lead.control", "task.result"],
    capabilities: ["code"],
    metadata: {
      runner: name,
      role,
      pid: process.pid,
      started_at: Date.now(),
    },
  });
}

async function publishResult(exitCode, preview = "") {
  await post("/bridge/result", {
    agent_id: agentId,
    topic: "task.result",
    payload: {
      summary: `${name} 종료 (code=${exitCode ?? 0})`,
      agent_id: agentId,
      role,
      exit_code: exitCode ?? 0,
      output_preview: preview.slice(0, 1200),
      completed_at: Date.now(),
    },
  });
}

async function deregisterSelf() {
  await post("/bridge/deregister", {
    agent_id: agentId,
  });
}

const pty = await loadPtyModule();
const shellExec = buildShellExec(command);

const ptyProc = pty.spawn(shellExec.file, shellExec.args, {
  name: "xterm-256color",
  cols: 160,
  rows: 48,
  cwd: shellExec.cwd,
  env: shellExec.env,
  useConpty: true,
});

let lastPreview = "";

ptyProc.onData((data) => {
  try {
    process.stdout.write(data);
  } catch {
    // stdout 파손 무시
  }

  const txt = safeText(data).replace(/\r/g, "");
  const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length) {
    lastPreview = lines[lines.length - 1].slice(0, 280);
  }
});

function writeChild(text, appendNewline = true) {
  try {
    ptyProc.write(appendNewline ? `${text}\r` : text);
  } catch {
    // pty 종료 등 무시
  }
}

function interruptChild() {
  try {
    ptyProc.write("\u0003");
  } catch {
    // 무시
  }
}

function stopChild() {
  writeChild("exit");
  setTimeout(() => {
    try { ptyProc.kill(); } catch {}
  }, 500).unref();
}

function parseControlMessage(msg) {
  const p = msg?.payload || {};
  const command = String(p.command || "").toLowerCase();
  const reason = safeText(p.reason, "");

  if (command === "pause") {
    paused = true;
    console.log(`[tfx-team][${name}] pause 수신${reason ? `: ${reason}` : ""}`);
    return;
  }
  if (command === "resume") {
    paused = false;
    console.log(`[tfx-team][${name}] resume 수신${reason ? `: ${reason}` : ""}`);
    return;
  }

  if (paused) return;

  if (command === "input") {
    const text = safeText(p.text, "");
    if (text) writeChild(text);
    return;
  }

  if (command === "interrupt") {
    console.log(`[tfx-team][${name}] interrupt 수신${reason ? `: ${reason}` : ""}`);
    interruptChild();
    return;
  }

  if (command === "stop") {
    console.log(`[tfx-team][${name}] stop 수신${reason ? `: ${reason}` : ""}`);
    stopping = true;
    stopChild();
    return;
  }

  if (command) {
    console.log(`[tfx-team][${name}] 알 수 없는 제어 명령: ${command}`);
  }
}

async function pollControlLoop() {
  while (!stopping) {
    const res = await post("/bridge/context", {
      agent_id: agentId,
      topics: ["lead.control"],
      max_messages: 20,
    }, 4000);

    const msgs = res?.data?.messages || [];
    for (const msg of msgs) {
      parseControlMessage(msg);
    }

    await sleep(pollMs);
  }
}

if (process.stdin) {
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    try {
      ptyProc.write(String(chunk));
    } catch {
      // stdin 전달 실패 무시
    }
  });
}

ptyProc.onExit(async ({ exitCode }) => {
  stopping = true;
  await publishResult(exitCode ?? 0, lastPreview);
  await deregisterSelf();
  process.exit(exitCode ?? 0);
});

process.on("SIGINT", () => {
  stopping = true;
  interruptChild();
});

process.on("SIGTERM", () => {
  stopping = true;
  stopChild();
});

await registerSelf();

if (prompt) {
  setTimeout(() => {
    if (!stopping) writeChild(prompt);
  }, startupDelayMs).unref();
}

void pollControlLoop();
