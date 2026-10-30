#!/usr/bin/env node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readCodexContext } from "../hub/team/session-context.mjs";
import { stripAnsi } from "./utils.mjs";

const exec = promisify(execFile);
const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export async function configureCodexHud(runTmux, target, env = process.env) {
  // 기존 서버가 다른 홈에서 시작됐어도 신규 세션의 HUD는 실행자의 환경을 따른다.
  for (const key of [
    "HOME",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "PATH",
    "TFX_JEV",
    "TFX_JEV_CLI",
    "JEV_API_KEY",
    "TYPESAFE_API_KEY",
    "TFX_DISABLE_CODEX",
    "TFX_DISABLE_ANTIGRAVITY",
    "TFX_MACHINE_PROFILE_PATH",
  ]) {
    try {
      await runTmux(null, [
        "set-environment",
        "-t",
        target,
        ...(env[key] == null ? ["-r", key] : [key, env[key]]),
      ]);
    } catch {
      // execFile의 오류 문자열에 환경변수 값이 포함되지 않게 한다.
      throw new Error(`Codex HUD environment setup failed: ${key}`);
    }
  }
  const { stdout } = await runTmux(null, [
    "display-message",
    "-p",
    "-t",
    target,
    "#{session_id}|#{pane_id}",
  ]);
  const [sessionId, paneId] = stdout.trim().split("|");
  if (!/^\$\d+$/.test(sessionId) || !/^%\d+$/.test(paneId))
    throw new Error("Codex HUD session/pane identity unavailable");
  const command = [
    process.execPath,
    fileURLToPath(import.meta.url),
    sessionId,
    paneId,
  ]
    .map(quote)
    .join(" ")
    .replace(/#/g, "##");
  for (const [key, value] of [
    ["status", "4"],
    ["status-interval", "5"],
    ["status-format[0]", `#(${command} #{client_width})`],
    ...[1, 2, 3].map((n) => [`status-format[${n}]`, `#{@tfx_hud_${n}}`]),
  ])
    await runTmux(null, ["set-option", "-t", target, key, value]);
}

export async function updateTmuxHud(session, pane, columns) {
  // CLI 모듈은 triflux 설치본에 있다. core의 공유 HUD에서는 이 진입점을 실행하지 않는다.
  const { resolveCodexTmuxThread } = await import(
    new URL("../bin/tfx-live.mjs", import.meta.url)
  );
  const { threadId } = await resolveCodexTmuxThread(pane, {
    requireRegistryAgreement: true,
    runTmux: async (_remote, args) => {
      // tmux 3.8은 format의 탭을 밑줄로 바꾸므로 출력 뒤에 탭으로 복원한다.
      const safeArgs = args.map((arg) => arg.replace(/\t/g, "|"));
      const result = await exec("tmux", safeArgs, { timeout: 2000 });
      return { stdout: result.stdout.replace(/\|/g, "\t") };
    },
  });
  const context = threadId ? await readCodexContext(null, threadId) : null;
  const limit = context?.executionContextLimitTokens;
  const used = context?.estimatedContextTokens;
  const input = {
    product: "codex",
    terminal_width: Number(columns) || 120,
    // 모델별 기본 분모는 쓰지 않고 현재 rollout의 실행 창만 쓴다.
    ...(Number.isFinite(limit) &&
    limit > 0 &&
    Number.isFinite(used) &&
    used >= 0
      ? {
          context_window: {
            context_window_size: limit,
            current_usage: { total_tokens: used },
          },
        }
      : {}),
  };
  const rendering = exec(
    process.execPath,
    [
      fileURLToPath(new URL("./hud-qos-status.mjs", import.meta.url)),
      "--cache-only",
    ],
    {
      timeout: 10000,
      env: { ...process.env, COLUMNS: String(input.terminal_width) },
    },
  );
  rendering.child.stdin.end(JSON.stringify(input));
  const { stdout } = await rendering;
  const lines = stripAnsi(stdout).trim().split("\n");
  const status = lines.pop();
  for (let n = 1; n <= 3; n += 1) {
    await exec(
      "tmux",
      [
        "set-option",
        "-t",
        session,
        `@tfx_hud_${n}`,
        (lines[n - 1] || "").replace(/#/g, "##"),
      ],
      { timeout: 2000 },
    );
  }
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateTmuxHud(...process.argv.slice(2))
    .then((status) => {
      process.stdout.write(`${status}\n`);
    })
    .catch(() => {
      process.stdout.write("Jev ? | 문맥 미확인\n");
    });
}
