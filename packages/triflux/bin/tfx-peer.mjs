#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deliverClaude,
  deliverCodex,
  parsePeerArgs,
  resolveClaudeRegistryTarget,
} from "../hub/team/native-peer.mjs";
import {
  discoverPeerTargets,
  matchPeerCandidates,
  resolveCodexTmuxThread,
} from "./tfx-live.mjs";

export async function main(args = process.argv.slice(2), deps = {}) {
  if (process.platform === "win32")
    throw new Error("Native peer adapter is unsupported on Windows");
  const { to, message } = parsePeerArgs(args);
  const [cli, name] = to.split(":");
  if (cli === "claude" && (deps.env || process.env).CLAUDECODE === "1")
    throw new Error("Claude-to-Claude uses native SendMessage, not tfx-peer");
  if (cli === "claude") {
    const target = (
      deps.resolveClaudeRegistryTarget || resolveClaudeRegistryTarget
    )(name);
    return (deps.deliverClaude || deliverClaude)({
      sessionId: target.sessionId,
      message,
    });
  }
  const candidates = await (deps.discover || discoverPeerTargets)({
    cliFilter: cli,
  });
  const matched = matchPeerCandidates(
    candidates.filter((x) => x.cli === cli),
    name,
  );
  if (matched.length !== 1)
    throw new Error(
      matched.length ? "Ambiguous target" : "Live local target not found",
    );
  const target = matched[0];
  if (!target.threadId) throw new Error("Codex thread UUID unavailable");
  if (!["tmux-option", "registry"].includes(target.raw?.threadSource))
    throw new Error("Codex target lacks exact thread provenance");
  const current = await (
    deps.resolveCodexTmuxThread ||
    ((pane) => resolveCodexTmuxThread(pane, { requireRegistryAgreement: true }))
  )(target.target || target.raw?.target || target.paneId);
  if (
    current.threadId !== target.threadId ||
    !["tmux-option", "registry"].includes(current.threadSource)
  )
    throw new Error("Codex pane thread changed; refusing stale target");
  return (deps.deliverCodex || deliverCodex)({
    threadId: target.threadId,
    message,
  });
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === "partial" || result.status === "unknown")
        process.exitCode = 2;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
