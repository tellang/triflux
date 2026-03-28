#!/usr/bin/env node
// remote-spawn.mjs — 로컬/원격 Claude 세션 실행 유틸리티
//
// Usage:
//   node remote-spawn.mjs --local [--dir <path>] [--prompt "..."] [--handoff <file>]
//   node remote-spawn.mjs --host <ssh-host> [--dir <path>] [--prompt "..."] [--handoff <file>]

import { execFileSync, spawn } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir, platform } from "os";

const MAX_HANDOFF_BYTES = 1 * 1024 * 1024; // 1 MB

// ── 입력 검증 ──

const SAFE_HOST_RE = /^[a-zA-Z0-9._-]+$/;
const SAFE_DIR_RE = /^[a-zA-Z0-9_.~\/:\\-]+$/;

function validateHost(host) {
  if (!SAFE_HOST_RE.test(host)) {
    console.error(`invalid host name: ${host}`);
    process.exit(1);
  }
  return host;
}

function validateDir(dir) {
  if (!SAFE_DIR_RE.test(dir)) {
    console.error(`invalid directory path: ${dir}`);
    process.exit(1);
  }
  return dir;
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── CLI 파싱 ──

function parseArgs(argv) {
  const args = { host: null, dir: null, prompt: null, handoff: null, local: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") { args.local = true; continue; }
    if (a === "--host" && argv[i + 1]) { args.host = validateHost(argv[++i]); continue; }
    if (a === "--dir" && argv[i + 1]) { args.dir = validateDir(argv[++i]); continue; }
    if (a === "--prompt" && argv[i + 1]) { args.prompt = argv[++i]; continue; }
    if (a === "--handoff" && argv[i + 1]) { args.handoff = argv[++i]; continue; }
    // 미지정 인자는 prompt로 처리
    if (!args.prompt) args.prompt = a;
  }
  return args;
}

// ── Claude 실행 경로 감지 ──

function detectClaudePath() {
  // 1. 환경변수 오버라이드
  if (process.env.CLAUDE_BIN_PATH) return process.env.CLAUDE_BIN_PATH;

  // 2. WinGet Links
  const wingetPath = join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "claude.exe");
  if (existsSync(wingetPath)) return wingetPath;

  // 3. npm global
  const npmPath = join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (existsSync(npmPath)) return npmPath;

  // 3. PATH에서 찾기
  try {
    const cmd = platform() === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["claude"], { encoding: "utf8", timeout: 5000 }).trim();
    if (result) return result.split("\n")[0].trim();
  } catch { /* not found */ }

  return "claude"; // fallback — PATH에 있다고 가정
}

// ── 핸드오프 컨텐츠 생성 ──

function buildPrompt(args) {
  let content = "";

  if (args.handoff) {
    const handoffPath = resolve(args.handoff);
    if (!existsSync(handoffPath)) {
      console.error(`handoff file not found: ${handoffPath}`);
      process.exit(1);
    }
    const size = statSync(handoffPath).size;
    if (size > MAX_HANDOFF_BYTES) {
      console.error(`handoff file too large: ${size} bytes (max ${MAX_HANDOFF_BYTES})`);
      process.exit(1);
    }
    content = readFileSync(handoffPath, "utf8").trim();
  }

  if (args.prompt) {
    content = content ? `${content}\n\n---\n\n${args.prompt}` : args.prompt;
  }

  return content;
}

// ── 로컬 Spawn (WT 탭) ──

function spawnLocal(args, claudePath, prompt) {
  const dir = args.dir ? resolve(args.dir) : process.cwd();

  if (platform() !== "win32") {
    // Linux/macOS: 직접 실행
    const cliArgs = ["--dangerously-skip-permissions"];
    if (prompt) cliArgs.push(prompt);

    const child = spawn(claudePath, cliArgs, {
      cwd: dir,
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code || 0));
    return;
  }

  // Windows: wt.exe new-tab
  const wtArgs = ["new-tab", "-d", dir, "--"];
  const claudeForward = claudePath.replace(/\\/g, "/");

  if (prompt) {
    // pwsh single-quote: 내부 ' → '' 이스케이프
    const psQuoted = "'" + prompt.replace(/'/g, "''") + "'";
    wtArgs.push(
      "pwsh", "-NoProfile", "-Command",
      `& '${claudeForward}' --dangerously-skip-permissions ${psQuoted}`,
    );
  } else {
    wtArgs.push(claudeForward, "--dangerously-skip-permissions");
  }

  try {
    spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    console.log(`spawned local Claude in WT tab → ${dir}`);
  } catch (err) {
    console.error("wt.exe spawn failed:", err.message);
    process.exit(1);
  }
}

// ── 원격 Spawn (SSH) ──

function spawnRemote(args, prompt) {
  const { host } = args;
  if (!host) {
    console.error("--host required for remote spawn");
    process.exit(1);
  }

  const dir = args.dir || "~";
  const quotedDir = shellQuote(dir);
  const remoteCmd = prompt
    ? `cd ${quotedDir} && claude --dangerously-skip-permissions ${shellQuote(prompt)}`
    : `cd ${quotedDir} && claude --dangerously-skip-permissions`;

  if (platform() === "win32") {
    // WT 탭에서 SSH 세션 열기
    const wtArgs = [
      "new-tab", "--title", `Claude@${host}`, "--",
      "ssh", "-t", "--", host, remoteCmd,
    ];

    try {
      spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore", windowsHide: false }).unref();
      console.log(`spawned remote Claude → ${host}:${dir}`);
    } catch (err) {
      console.error("wt.exe spawn failed:", err.message);
      process.exit(1);
    }
  } else {
    // Linux/macOS: 직접 SSH
    const child = spawn("ssh", ["-t", "--", host, remoteCmd], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code || 0));
  }
}

// ── main ──

function main() {
  const args = parseArgs(process.argv);

  if (!args.local && !args.host) {
    console.log(`Usage:
  remote-spawn --local [--dir <path>] [--prompt "task"] [--handoff <file>]
  remote-spawn --host <ssh-host> [--dir <path>] [--prompt "task"] [--handoff <file>]

Options:
  --local          로컬 WT 탭에서 Claude 실행
  --host <name>    SSH 호스트로 원격 Claude 실행
  --dir <path>     작업 디렉토리 (기본: 현재 디렉토리 / ~)
  --prompt "..."   Claude에 전달할 첫 메시지
  --handoff <file> 핸드오프 파일 경로 (prompt와 결합 가능)`);
    process.exit(0);
  }

  const prompt = buildPrompt(args);
  const claudePath = detectClaudePath();

  if (args.local) {
    spawnLocal(args, claudePath, prompt);
  } else {
    spawnRemote(args, prompt);
  }
}

main();
