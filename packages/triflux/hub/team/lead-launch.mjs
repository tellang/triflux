// hub/team/lead-launch.mjs: `tfx lead <역할>` 로 리드 세션을 띄운다.
// 리드는 사람이 직접 쓰는 세션이라 실행 명령을 사용자가 정한다(기본 claude).
// 워커는 tfx-live 가 일반 claude 로 띄우므로 이 설정과 무관하다.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { modelFamilyPaths } from "../../scripts/lib/model-family-resolver.mjs";

const execFileAsync = promisify(execFile);
const TFX_LIVE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "tfx-live.mjs",
);
export const DEFAULT_LAUNCHER = "claude";

/** 실행 명령은 --launcher, lead.json 의 launcher, 기본 claude 순으로 고른다. */
export function resolveLauncher({ flag, configPath } = {}) {
  if (flag) return flag;
  const path = configPath ?? join(modelFamilyPaths().stateDir, "lead.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_LAUNCHER;
    throw error;
  }
  const launcher = JSON.parse(text).launcher;
  if (launcher === undefined) return DEFAULT_LAUNCHER;
  if (
    typeof launcher !== "string" ||
    !launcher.trim() ||
    /[\r\n]/u.test(launcher)
  )
    throw new Error(`${path} 의 launcher 는 한 줄 문자열이어야 한다`);
  return launcher.trim();
}

/** tmux 세션 이름에 못 쓰는 문자(. :)를 바꿔 `<폴더>-lead` 로 만든다. */
export function leadSessionName(cwd) {
  return `${basename(resolve(cwd)).replace(/[^\w-]/gu, "-")}-lead`;
}

/** /tfx-lead 와 같은 규칙으로 이름을 정한다. 날짜로 시작하면 그대로 쓴다. */
export function leadDisplayName(role, now = new Date()) {
  if (/^\d{1,2}\.\d{1,2} \S/u.test(role)) return role;
  return `${now.getMonth() + 1}.${now.getDate()} ${role}`;
}

async function runLive(args, run) {
  const { stdout } = await run(process.execPath, [TFX_LIVE, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function launchLead(
  { role, cwd = process.cwd(), session, model, effort, launcher },
  { run = execFileAsync } = {},
) {
  if (!role?.trim()) throw new Error("역할이 필요하다: tfx lead <역할>");
  const target = session || leadSessionName(cwd);
  const name = leadDisplayName(role.trim());
  const start = await runLive(
    [
      "start",
      "--cli",
      "claude",
      "--session",
      target,
      "--name",
      name,
      "--launcher",
      launcher,
      "--cwd",
      resolve(cwd),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
    ],
    run,
  );
  if (!start.ready)
    return { ok: false, session: target, name, launcher, start };
  // 슬래시 명령은 tmux 입력으로만 실행되고, Claude 안에서 호출해도 SendMessage 로 바뀌지 않게 한다.
  const ask = await runLive(
    [
      "ask",
      "--cli",
      "claude",
      "--session",
      target,
      "--prompt",
      `/tfx-lead ${role.trim()}`,
      "--no-wait",
      "--via-tmux",
    ],
    run,
  );
  return { ok: Boolean(ask.ok), session: target, name, launcher, start, ask };
}
