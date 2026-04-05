// hub/team/native-supervisor.mjs — tmux 없이 멀티 CLI를 직접 띄우는 네이티브 팀 런타임
import { createServer } from "node:http";
import { spawn, execSync as execSyncSupervisor } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { verifySlimWrapperRouteExecution } from "./native.mjs";
import { forceCleanupTeam } from "./nativeProxy.mjs";

const ROUTE_LOG_TAIL_BYTES = 65536;

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

async function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeText(v, fallback = "") {
  if (v == null) return fallback;
  return String(v);
}

function readTailText(path, maxBytes = ROUTE_LOG_TAIL_BYTES) {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length <= maxBytes) return raw;
    return raw.slice(-maxBytes);
  } catch {
    return "";
  }
}

function finalizeRouteVerification(state) {
  if (state?.member?.role !== "worker") return;

  const verification = verifySlimWrapperRouteExecution({
    promptText: safeText(state.member?.prompt),
    stdoutText: readTailText(state.logFile),
    stderrText: readTailText(state.errFile),
  });

  state.routeVerification = verification;
  if (!verification.expectedRouteInvocation) {
    state.completionStatus = "unchecked";
    state.completionReason = null;
    return;
  }

  state.completionStatus = verification.abnormal ? "abnormal" : "normal";
  state.completionReason = verification.reason;
  if (verification.abnormal) {
    state.lastPreview = "[abnormal] tfx-route.sh evidence missing";
  }
}

function nowMs() {
  return Date.now();
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error("사용법: node native-supervisor.mjs --config <path>");
  process.exit(1);
}

const config = await readJson(args.config);
const {
  sessionName,
  teamName = sessionName,
  runtimeFile,
  logsDir,
  startupDelayMs = 3000,
  members = [],
} = config;

mkdirSync(logsDir, { recursive: true });
mkdirSync(dirname(runtimeFile), { recursive: true });

const startedAt = nowMs();
const processMap = new Map();

function memberStateSnapshot() {
  const states = [];
  for (const m of members) {
    const state = processMap.get(m.name);
    states.push({
      name: m.name,
      role: m.role,
      cli: m.cli,
      agentId: m.agentId,
      command: m.command,
      pid: state?.child?.pid || null,
      status: state?.status || "unknown",
      exitCode: state?.exitCode ?? null,
      lastPreview: state?.lastPreview || "",
      completionStatus: state?.completionStatus || null,
      completionReason: state?.completionReason || null,
      routeVerification: state?.routeVerification || null,
      logFile: state?.logFile || null,
      errFile: state?.errFile || null,
    });
  }
  return states;
}

function writeRuntime(controlPort) {
  const runtime = {
    sessionName,
    supervisorPid: process.pid,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    startedAt,
    members: memberStateSnapshot(),
  };
  writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2) + "\n");
}

// Shell metacharacters that can be used for command injection.
// member.command is a CLI invocation string (e.g. "codex --flag value").
// shell: true is required on Windows for .cmd executables, so we validate
// the command string instead of removing the shell option.
const SAFE_COMMAND_RE = /^[a-zA-Z0-9 _./:@"'=\-\\]+$/;

function validateMemberCommand(command, memberName) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`member "${memberName}": command must be a non-empty string`);
  }
  if (!SAFE_COMMAND_RE.test(command)) {
    throw new Error(
      `member "${memberName}": command contains disallowed characters — ` +
      `shell metacharacters (;&|$\`()<>{}\\n\\r) are not permitted`
    );
  }
}

function spawnMember(member) {
  validateMemberCommand(member.command, member.name);

  const outPath = join(logsDir, `${member.name}.out.log`);
  const errPath = join(logsDir, `${member.name}.err.log`);

  const outWs = createWriteStream(outPath, { flags: "a" });
  const errWs = createWriteStream(errPath, { flags: "a" });

  const child = spawn(member.command, {
    shell: true,
    env: {
      ...process.env,
      TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const state = {
    member,
    child,
    outWs,
    errWs,
    logFile: outPath,
    errFile: errPath,
    status: "running",
    exitCode: null,
    lastPreview: "",
  };

  child.stdout.on("data", (buf) => {
    outWs.write(buf);
    const txt = safeText(buf).trim();
    if (txt) {
      const lines = txt.split(/\r?\n/).filter(Boolean);
      if (lines.length) state.lastPreview = lines[lines.length - 1].slice(0, 280);
    }
  });

  child.stderr.on("data", (buf) => {
    errWs.write(buf);
    const txt = safeText(buf).trim();
    if (txt) {
      const lines = txt.split(/\r?\n/).filter(Boolean);
      if (lines.length) state.lastPreview = `[err] ${lines[lines.length - 1].slice(0, 260)}`;
    }
  });

  child.on("exit", (code) => {
    state.status = "exited";
    state.exitCode = code;
    finalizeRouteVerification(state);
    try { outWs.end(); } catch {}
    try { errWs.end(); } catch {}
    maybeAutoShutdown();
  });

  child.on("error", (err) => {
    state.status = "exited";
    state.exitCode = -1;
    state.lastPreview = `[spawn error] ${err.message}`;
    try { outWs.end(); } catch {}
    try { errWs.end(); } catch {}
    maybeAutoShutdown();
  });

  processMap.set(member.name, state);
}

function sendInput(memberName, text) {
  const state = processMap.get(memberName);
  if (!state) return { ok: false, error: "member_not_found" };
  if (state.status !== "running") return { ok: false, error: "member_not_running" };
  try {
    state.child.stdin.write(`${safeText(text)}\n`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function interruptMember(memberName) {
  const state = processMap.get(memberName);
  if (!state) return { ok: false, error: "member_not_found" };
  if (state.status !== "running") return { ok: false, error: "member_not_running" };

  let signaled = false;
  try {
    signaled = state.child.kill("SIGINT");
  } catch {
    signaled = false;
  }

  if (!signaled) {
    try {
      state.child.stdin.write("\u0003");
      signaled = true;
    } catch {
      signaled = false;
    }
  }

  return signaled ? { ok: true } : { ok: false, error: "interrupt_failed" };
}

let isShuttingDown = false;

function maybeAutoShutdown() {
  if (isShuttingDown) return;
  const allExited = [...processMap.values()].every((s) => s.status === "exited");
  if (!allExited) return;
  shutdown();
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  for (const state of processMap.values()) {
    if (state.status === "running") {
      try { state.child.stdin.write("exit\n"); } catch {}
      try { state.child.kill("SIGTERM"); } catch {}
    }
    try { state.outWs.end(); } catch {}
    try { state.errWs.end(); } catch {}
  }

  try {
    await forceCleanupTeam(teamName);
  } catch {}

  setTimeout(() => {
    for (const state of processMap.values()) {
      if (state.status === "running") {
        const pid = state.child?.pid;
        if (process.platform === "win32" && Number.isInteger(pid) && pid > 0) {
          // Windows: 프로세스 트리 전체 강제 종료 (손자 MCP 서버 포함)
          try { execSyncSupervisor(`taskkill /T /F /PID ${pid}`, { stdio: "pipe", windowsHide: true, timeout: 5000 }); } catch {}
        } else {
          try { state.child.kill("SIGKILL"); } catch {}
        }
      }
    }
    process.exit(0);
  }, 1200).unref();
}

for (const member of members) {
  spawnMember(member);
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && (req.url === "/" || req.url === "/status")) {
    return send(200, {
      ok: true,
      data: {
        sessionName,
        supervisorPid: process.pid,
        uptimeMs: nowMs() - startedAt,
        members: memberStateSnapshot(),
      },
    });
  }

  if (req.method !== "POST") {
    return send(405, { ok: false, error: "method_not_allowed" });
  }

  let body = {};
  try {
    const MAX_BODY = 1024 * 1024;
    const chunks = [];
    let totalLen = 0;
    for await (const c of req) {
      totalLen += c.length;
      if (totalLen > MAX_BODY) { send(413, { ok: false, error: "payload_too_large" }); return; }
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    body = JSON.parse(raw);
  } catch {
    return send(400, { ok: false, error: "invalid_json" });
  }

  if (req.url === "/send") {
    const { member, text } = body;
    const r = sendInput(member, text);
    return send(r.ok ? 200 : 400, r);
  }

  if (req.url === "/interrupt") {
    const { member } = body;
    const r = interruptMember(member);
    return send(r.ok ? 200 : 400, r);
  }

  if (req.url === "/control") {
    const { member, command = "", reason = "" } = body;
    const controlMsg = `[LEAD CONTROL] command=${command}${reason ? ` reason=${reason}` : ""}`;
    const a = sendInput(member, controlMsg);
    if (!a.ok) return send(400, a);
    if (String(command).toLowerCase() === "interrupt") {
      const b = interruptMember(member);
      if (!b.ok) return send(400, b);
    }
    return send(200, { ok: true });
  }

  if (req.url === "/stop") {
    send(200, { ok: true });
    shutdown();
    return;
  }

  return send(404, { ok: false, error: "not_found" });
});

server.on("error", (err) => {
  console.error("[native-supervisor] HTTP server error:", err.message);
  process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    console.error("native supervisor 포트 바인딩 실패");
    process.exit(1);
  }

  writeRuntime(port);

  // CLI 초기화 후 프롬프트 주입
  setTimeout(() => {
    for (const m of members) {
      if (m.prompt) {
        sendInput(m.name, m.prompt);
      }
    }
  }, startupDelayMs).unref();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
