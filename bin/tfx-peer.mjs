#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deliverAgy,
  deliverClaude,
  deliverCodex,
  parsePeerArgs,
  resolveClaudeReceiver,
  resolveClaudeRegistryTarget,
} from "../hub/team/native-peer.mjs";
import {
  agyConversation,
  discoverPeerTargets,
  formatPeerReply,
  matchPeerCandidates,
  resolveCodexTmuxThread,
  resolvePeerSender,
} from "./tfx-live.mjs";

export async function main(args = process.argv.slice(2), deps = {}) {
  const platform = deps.platform || process.platform;
  if (args[0] === "self") {
    const { sessionId, message } = parsePeerArgs(args);
    const receiver = (deps.resolveClaudeReceiver || resolveClaudeReceiver)({
      sessionId,
      platform,
    });
    // Claude 끼리는 SendMessage 로 보낸다. 예외는 mod 가 자기 세션에 넣는 알림뿐이다.
    // mod 의 $.process.run 자식은 Claude 프로세스 바로 밑에 뜬다. 위조할 수 있는 환경 변수 대신
    // 부모 PID 를 수신 소켓 이름 <pid>.sock 과 맞춘다.
    if (
      path.basename(receiver.socketPath) !== `${deps.ppid ?? process.ppid}.sock`
    )
      throw new Error("self target is not the calling Claude session");
    return (deps.deliverClaude || deliverClaude)({
      sessionId,
      receiver,
      message,
      platform,
    });
  }
  const { to, message } = parsePeerArgs(args);
  const [cli, name] = to.split(":");
  if (platform === "win32" && cli === "codex")
    throw new Error("Windows 에서는 Codex 대상을 아직 지원하지 않는다");
  if (platform === "win32" && cli === "agy")
    throw new Error("Windows 에서는 agy 대상을 아직 지원하지 않는다");
  const env = deps.env || process.env;
  // Windows 에는 tmux/ps 기반 탐색이 없다.
  const candidates =
    platform === "win32"
      ? []
      : await (deps.discover || discoverPeerTargets)({ deps });
  const sender = await resolvePeerSender({
    env,
    allCandidates: candidates,
    deps,
  });
  if (cli === "claude" && (env.CLAUDECODE === "1" || sender.cli === "claude"))
    throw new Error("Claude-to-Claude uses native SendMessage, not tfx-peer");
  const formattedMessage = [
    `[tfx-peer from=${sender.cli}:${String(sender.name || sender.sessionId || "unknown").replace(/[\r\n\u2028\u2029]+/g, " ")} msg=${randomUUID()}]`,
    message,
    formatPeerReply(sender, cli, { platform }),
  ].join("\n");
  if (cli === "claude") {
    const target = (
      deps.resolveClaudeRegistryTarget || resolveClaudeRegistryTarget
    )(name, { platform });
    return (deps.deliverClaude || deliverClaude)({
      sessionId: target.sessionId,
      receiver: target.receiver,
      message: formattedMessage,
      platform,
    });
  }
  const matched = matchPeerCandidates(
    candidates.filter((x) => x.cli === cli),
    name,
  );
  if (matched.length !== 1)
    throw new Error(
      matched.length ? "Ambiguous target" : "Live local target not found",
    );
  const target = matched[0];
  if (cli === "agy") {
    if (target.raw?.running === false)
      throw new Error("agy target is not running");
    const conversationId = target.conversationId || target.raw?.conversationId;
    if (!conversationId)
      throw new Error(
        "agy conversation ID unavailable; 첫 입력 전 새 세션은 tfx-live ask --cli agy --session <세션> --prompt <본문> --no-wait 로 깨워라",
      );
    let appDataDir = target.appDataDir || target.raw?.appDataDir || null;
    const pid = target.pid || target.raw?.pid;
    if (pid || deps.resolveAgyConversation) {
      const current = await (deps.resolveAgyConversation || agyConversation)(
        pid,
      );
      if (
        !current ||
        current.conversationId !== conversationId ||
        (appDataDir && current.appDataDir && current.appDataDir !== appDataDir)
      ) {
        throw new Error(
          "agy target conversation changed; refusing stale target",
        );
      }
      appDataDir = current.appDataDir || appDataDir;
    }
    if (!appDataDir) throw new Error("agy target appDataDir unavailable");
    return (deps.deliverAgy || deliverAgy)({
      conversationId,
      appDataDir,
      requireExisting: true,
      message: formattedMessage,
      sender: `${sender.cli}:${String(sender.name || sender.sessionId || "unknown").replace(/[\r\n\u2028\u2029]+/g, " ")}`,
      home: deps.home,
      env,
    });
  }
  if (!target.threadId) throw new Error("Codex thread UUID unavailable");
  if (!["tmux-option", "registry"].includes(target.raw?.threadSource))
    throw new Error(
      "Codex target lacks exact thread provenance. tfx-live adopt --session <tmux 대상>으로 연결하거나 tfx-live start --cli codex --resume <thread>로 다시 띄워라",
    );
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
    message: formattedMessage,
    env,
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
