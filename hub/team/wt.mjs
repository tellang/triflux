// hub/team/wt.mjs — Windows Terminal(wt.exe) 기반 팀 패널 런타임
import { execSync, spawn } from "node:child_process";

/** Windows Terminal(wt.exe) 사용 가능 여부 */
export function hasWindowsTerminal() {
  if (process.platform !== "win32") return false;
  try {
    execSync("where.exe wt", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function addCommand(cmds, parts) {
  if (!parts?.length) return;
  if (cmds.length > 0) cmds.push(";");
  cmds.push(...parts);
}

function buildSplitCommands(members, layout) {
  const cmds = [];
  if (!members.length) return cmds;

  addCommand(cmds, [
    "new-tab",
    "--title", members[0].title,
    "pwsh",
    "-NoLogo",
    "-Command",
    members[0].command,
  ]);

  if (layout === "2x2" && members.length <= 4) {
    if (members[1]) {
      addCommand(cmds, [
        "split-pane", "-H",
        "--title", members[1].title,
        "pwsh", "-NoLogo", "-Command", members[1].command,
      ]);
    }
    if (members[2]) {
      addCommand(cmds, ["move-focus", "left"]);
      addCommand(cmds, [
        "split-pane", "-V",
        "--title", members[2].title,
        "pwsh", "-NoLogo", "-Command", members[2].command,
      ]);
    }
    if (members[3]) {
      addCommand(cmds, ["move-focus", "right"]);
      addCommand(cmds, [
        "split-pane", "-V",
        "--title", members[3].title,
        "pwsh", "-NoLogo", "-Command", members[3].command,
      ]);
    }
    return cmds;
  }

  for (let i = 1; i < members.length; i++) {
    addCommand(cmds, [
      "split-pane", "-V",
      "--title", members[i].title,
      "pwsh", "-NoLogo", "-Command", members[i].command,
    ]);
  }

  return cmds;
}

/**
 * Windows Terminal에서 팀 패널 구성 시작
 * @param {string} sessionName
 * @param {Array<{title:string, command:string}>} members
 * @param {object} opts
 * @param {'2x2'|'1xN'} opts.layout
 * @param {string} opts.windowRef
 * @returns {{ windowRef: string, paneCount: number, layout: string }}
 */
export function openWtTeamSession(sessionName, members, opts = {}) {
  const { layout = "2x2", windowRef = "new" } = opts;

  if (!hasWindowsTerminal()) {
    throw new Error("Windows Terminal(wt.exe) 미발견");
  }
  if (!members.length) {
    throw new Error("실행할 팀 멤버가 없음");
  }

  const effectiveLayout = (layout === "2x2" && members.length <= 4) ? "2x2" : "1xN";
  const commands = buildSplitCommands(members, effectiveLayout);

  const args = [
    "-w", windowRef,
    ...commands,
  ];

  const child = spawn("wt", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return {
    windowRef,
    paneCount: members.length,
    layout: effectiveLayout,
    sessionName,
  };
}
