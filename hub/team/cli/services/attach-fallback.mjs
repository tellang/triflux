import { spawn } from "node:child_process";

import {
  getSessionAttachedCount,
  hasWindowsTerminal,
  resolveAttachCommand,
} from "../../session.mjs";
import { PKG_ROOT } from "./state-store.mjs";

export async function launchAttachInWindowsTerminal(sessionName) {
  if (!hasWindowsTerminal()) return false;

  let attachSpec;
  try {
    attachSpec = resolveAttachCommand(sessionName);
  } catch {
    return false;
  }

  const beforeAttached = getSessionAttachedCount(sessionName);
  try {
    const child = spawn(
      "wt",
      [
        "-w",
        "0",
        "split-pane",
        "-V",
        "-d",
        PKG_ROOT,
        attachSpec.command,
        ...attachSpec.args,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();

    if (beforeAttached == null) return true;
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const nowAttached = getSessionAttachedCount(sessionName);
      if (typeof nowAttached === "number" && nowAttached > beforeAttached)
        return true;
    }
  } catch {}
  return false;
}

export function buildManualAttachCommand(sessionName) {
  try {
    const spec = resolveAttachCommand(sessionName);
    return [spec.command, ...spec.args]
      .map((value) => {
        const text = String(value);
        return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
      })
      .join(" ");
  } catch {
    return `tmux attach-session -t ${sessionName}`;
  }
}

export function wantsWtAttachFallback(args = [], env = process.env) {
  return (
    args.includes("--wt") ||
    args.includes("--spawn-wt") ||
    env.TFX_ATTACH_WT_AUTO === "1"
  );
}
