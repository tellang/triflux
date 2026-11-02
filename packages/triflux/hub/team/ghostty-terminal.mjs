import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function appleScriptString(value) {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value))
    throw new Error("AppleScript values must not contain control characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function planGhosttyOpen({
  windows,
  metadata,
  leaderTty,
  project,
  group,
}) {
  const records = new Map(
    metadata.map((record) => [record.terminalId, record]),
  );
  const terminals = (window) => window.tabs.flatMap((tab) => tab.terminals);
  const leader = windows.find((window) =>
    terminals(window).some(
      (terminal) => leaderTty && terminal.tty === leaderTty,
    ),
  );
  if (!leader) return null;
  const projectWindow = windows.find((window) =>
    terminals(window).some(
      (terminal) => records.get(terminal.id)?.project === project,
    ),
  );
  if (
    !projectWindow &&
    terminals(leader).some((terminal) => {
      const key = records.get(terminal.id)?.project;
      return key && key !== project;
    })
  )
    return { kind: "window", column: "L" };
  const target = projectWindow ?? leader;
  for (const tab of target.tabs) {
    if (tab.terminals.length >= 4) continue;
    const members = tab.terminals.filter(
      (terminal) => records.get(terminal.id)?.group === group,
    );
    if (!members.length) continue;
    if (
      members.length > 1 &&
      members.some(
        (terminal) => !["L", "R"].includes(records.get(terminal.id)?.column),
      )
    )
      continue;
    const left = members.filter(
      (terminal) => records.get(terminal.id)?.column !== "R",
    );
    const right = members.filter(
      (terminal) => records.get(terminal.id)?.column === "R",
    );
    const column =
      right.length === 0
        ? "R"
        : left.length === 0 || right.length >= left.length
          ? "L"
          : "R";
    return {
      kind: "split",
      windowId: target.id,
      tabId: tab.id,
      terminalId:
        (column === "R" ? right.at(-1) : left.at(-1))?.id ?? members.at(-1).id,
      direction: left.length && right.length ? "down" : "right",
      column,
    };
  }
  return { kind: "tab", windowId: target.id, column: "L" };
}

async function readGhosttyWindows(exec) {
  const script = `set fieldSeparator to character id 9
set inventory to ""
if application "Ghostty" is not running then return ""
tell application "Ghostty"
  repeat with candidateWindow in windows
    try
      repeat with candidateTab in tabs of candidateWindow
        repeat with candidateTerminal in terminals of candidateTab
          set inventory to inventory & (id of candidateWindow) & fieldSeparator & (id of candidateTab) & fieldSeparator & (index of candidateTab) & fieldSeparator & (id of candidateTerminal) & fieldSeparator & (tty of candidateTerminal) & linefeed
        end repeat
      end repeat
    end try
  end repeat
end tell
return inventory`;
  const { stdout } = await exec("/usr/bin/osascript", ["-e", script], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  const windows = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [windowId, tabId, index, terminalId, tty] = line.split("\t");
    if (!windowId || !tabId || !terminalId || !Number.isInteger(Number(index)))
      throw new Error("Ghostty did not return a valid terminal inventory");
    let window = windows.find((item) => item.id === windowId);
    if (!window) {
      window = { id: windowId, tabs: [] };
      windows.push(window);
    }
    let tab = window.tabs.find((item) => item.id === tabId);
    if (!tab) {
      tab = { id: tabId, index: Number(index), terminals: [] };
      window.tabs.push(tab);
    }
    tab.terminals.push({ id: terminalId, tty });
  }
  for (const window of windows) window.tabs.sort((a, b) => a.index - b.index);
  return windows;
}

export async function openGhosttySession(session, group, project, deps = {}) {
  const exec = deps.execFile ?? execFileAsync;
  const tmux = deps.runTmux;
  const env = deps.env ?? process.env;
  try {
    const windows = await readGhosttyWindows(exec);
    let leaderTty = "";
    if (env.TMUX_PANE) {
      const { stdout } = await tmux(null, [
        "list-clients",
        "-t",
        env.TMUX_PANE,
        "-F",
        "#{client_activity}\t#{client_tty}",
      ]).catch(() => ({ stdout: "" }));
      leaderTty =
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t"))
          .sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1] ?? "";
    } else if (env.TERM_PROGRAM === "ghostty") {
      // 도구 프로세스에 tty가 없으면 부모를 따라 리드의 tty를 찾는다.
      let pid = process.pid;
      for (let step = 0; step < 8 && pid > 0; step++) {
        const { stdout } = await exec(
          "/bin/ps",
          ["-p", String(pid), "-o", "ppid=", "-o", "tty="],
          { timeout: 2000 },
        );
        const [parentPid, tty] = stdout.trim().split(/\s+/);
        if (tty && tty !== "??" && tty !== "?") {
          leaderTty = `/dev/${tty}`;
          break;
        }
        pid = Number(parentPid);
      }
    }
    if (!leaderTty) throw new Error("Ghostty leader tty was not found");
    const { stdout: options } = await tmux(null, [
      "list-sessions",
      "-F",
      "#{@tfx_ghostty_terminal}\t#{@tfx_project}\t#{@tfx_group}\t#{@tfx_column}",
    ]);
    const metadata = options
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [terminalId, project, group, column] = line.split("\t");
        return { terminalId, project, group, column };
      });
    const plan = planGhosttyOpen({
      windows,
      metadata,
      leaderTty,
      project: project.key,
      group,
    });
    if (!plan) throw new Error("Ghostty leader window was not found");
    const { stdout: tmuxPath } = await exec("which", ["tmux"], {
      timeout: 2000,
    });
    const command = [
      realpathSync(tmuxPath.trim()),
      "attach-session",
      "-t",
      `=${session}`,
    ]
      .map((value) => `'${value.replace(/'/g, `'"'"'`)}'`)
      .join(" ");
    let action;
    if (plan.kind === "window") {
      action = `set targetWindow to new window with configuration cfg
  set targetTab to selected tab of targetWindow
  set newTerminal to first terminal of targetTab`;
    } else if (plan.kind === "tab") {
      action = `set targetWindow to first window whose id is ${appleScriptString(plan.windowId)}
  set targetTab to new tab in targetWindow with configuration cfg
  set newTerminal to first terminal of targetTab`;
    } else {
      action = `set targetWindow to first window whose id is ${appleScriptString(plan.windowId)}
  set targetTab to first tab of targetWindow whose id is ${appleScriptString(plan.tabId)}
  set sourceTerminal to first terminal of targetTab whose id is ${appleScriptString(plan.terminalId)}
  set newTerminal to split sourceTerminal direction ${plan.direction} with configuration cfg`;
    }
    const script = `tell application "Ghostty"
  set cfg to new surface configuration
  set initial input of cfg to ${appleScriptString(`exec ${command}`)} & linefeed
  set initial working directory of cfg to ${appleScriptString(deps.cwd ?? process.cwd())}
  ${action}
  set name override of newTerminal to ${appleScriptString(deps.name ?? session)}
  set name override of targetTab to ${appleScriptString(deps.tabTitle ?? project.name)}
  return id of newTerminal
end tell`;
    const { stdout } = await exec("/usr/bin/osascript", ["-e", script], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const terminalId = stdout.trim();
    if (!terminalId) throw new Error("Ghostty did not return a terminal ID");
    const settings = {
      "@tfx_ghostty_terminal": terminalId,
      "@tfx_project": project.key,
      "@tfx_group": group,
      "@tfx_column": plan.column,
    };
    for (const [key, value] of Object.entries(settings))
      await tmux(null, ["set-option", "-t", `=${session}:`, key, value]);
    return { ghostty: { terminalId, group, split: plan.kind === "split" } };
  } catch (error) {
    return { ghosttyWarning: error.message };
  }
}

export async function closeGhosttySession(terminalId, deps = {}) {
  const exec = deps.execFile ?? execFileAsync;
  const windows = await readGhosttyWindows(exec);
  const ids = windows.flatMap((window) =>
    window.tabs.flatMap((tab) =>
      tab.terminals
        .filter((terminal) => terminal.id === terminalId)
        .map((terminal) => terminal.id),
    ),
  );
  if (!ids.length) return;
  const script = `if application "Ghostty" is not running then return
tell application "Ghostty"
  repeat with terminalId in {${ids.map(appleScriptString).join(", ")}}
    try
      close (first terminal whose id is (contents of terminalId))
    end try
  end repeat
end tell`;
  await exec("/usr/bin/osascript", ["-e", script], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
}
