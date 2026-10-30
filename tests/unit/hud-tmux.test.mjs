import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 전용 소켓과 임시 홈 외에는 접근하지 않는다.
const hasTmux =
  process.platform !== "win32" &&
  spawnSync("tmux", ["-V"]).status === 0 &&
  spawnSync("python3", ["--version"]).status === 0;
test("Codex HUD는 대상 세션만 바꾸고 늦게 준비된 rollout을 읽는다", {
  skip: !hasTmux,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "tfx-hud-tmux-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: join(home, "codex"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    TFX_JEV: "off",
    TFX_DISABLE_CODEX: "0",
    TFX_DISABLE_ANTIGRAVITY: "0",
  };
  const tmux = (...args) =>
    execFileSync("tmux", ["-L", "tfx-hud-jev-1030", ...args], {
      env,
      encoding: "utf8",
    }).trimEnd();
  try {
    const { configureCodexHud, updateTmuxHud } = await import(
      "../../hud/tmux-status.mjs"
    );
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "owned", "-x", "200");
    tmux("new-session", "-d", "-s", "other");
    const globalBefore = tmux("show-options", "-g");
    const otherBefore = tmux("show-options", "-t", "=other:");
    const run = async (_remote, args) => ({ stdout: tmux(...args) });
    await configureCodexHud(run, "=owned:", env);
    assert.equal(tmux("show-options", "-t", "=owned:", "-v", "status"), "4");
    assert.match(
      tmux("show-options", "-t", "=owned:", "-v", "status-format[0]"),
      /tmux-status\.mjs/,
    );
    assert.equal(tmux("show-options", "-g"), globalBefore);
    assert.equal(tmux("show-options", "-t", "=other:"), otherBefore);
    const pane = tmux("display-message", "-p", "-t", "=owned:", "#{pane_id}");
    // 별도 프로세스로 session env를 따라 실행하고 공유 renderer의 실제 출력을 검사한다.
    const render = () =>
      execFileSync(
        process.execPath,
        ["hud/tmux-status.mjs", "=owned:", pane, "200"],
        {
          env: {
            ...env,
            TMUX: tmux("display-message", "-p", "#{socket_path}") + ",1,0",
          },
          encoding: "utf8",
        },
      ).trim();
    assert.match(render(), /Jev OFF.*문맥 미확인/);
    const thread = "019a0000-0000-7000-8000-000000000001";
    const sessions = join(env.CODEX_HOME, "sessions", "2026", "10", "30");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `rollout-test-${thread}.jsonl`),
      [
        { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 84000 },
              model_context_window: 200000,
            },
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const rollout = join(sessions, `rollout-test-${thread}.jsonl`);
    const complete = readFileSync(rollout, "utf8");
    writeFileSync(
      rollout,
      complete.replace(',"model_context_window":200000', ""),
    );
    tmux("set-option", "-t", "=owned:", "@tfx_codex_thread", thread);
    assert.match(render(), /문맥 미확인/);
    writeFileSync(rollout, complete);
    assert.match(render(), /Jev OFF.*문맥 116k 남음/);
    const rows = [1, 2, 3].map((n) =>
      tmux("show-options", "-t", "=owned:", "-v", `@tfx_hud_${n}`),
    );
    assert.match(rows.join("\n"), /^c:.*5h:.*1w:/m);
    assert.match(rows.join("\n"), /^x:.*5h:.*1w:/m);
    assert.match(rows.join("\n"), /^a:/m);
    assert.doesNotMatch(rows.join("\n"), /\x1b/);
    assert.equal(tmux("show-options", "-g"), globalBefore);
    assert.equal(tmux("show-options", "-t", "=other:"), otherBefore);
    assert.equal(typeof updateTmuxHud, "function");
    for (const n of [1, 2, 3])
      tmux("set-option", "-u", "-t", "=owned:", `@tfx_hud_${n}`);
    const client = spawn(
      "python3",
      [
        "-c",
        'import pty; pty.spawn(["tmux", "-L", "tfx-hud-jev-1030", "attach-session", "-t", "owned"])',
      ],
      {
        env: { ...env, TERM: "xterm-256color" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let screen = "";
    client.stderr.on("data", (data) => {
      screen += data;
    });
    client.stdout.on("data", (data) => {
      screen += data;
    });
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !screen.includes("116k"))
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(screen, /116k/);
      assert.match(screen, /Jev OFF/);
      assert.match(
        tmux("show-options", "-t", "=owned:", "-v", "@tfx_hud_1"),
        /^c:/,
      );
      assert.equal(tmux("show-options", "-g"), globalBefore);
      assert.equal(tmux("show-options", "-t", "=other:"), otherBefore);
    } finally {
      try {
        tmux("detach-client", "-s", "owned");
      } catch {}
      client.stdin.end();
      client.kill();
    }
  } finally {
    try {
      tmux("kill-server");
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
