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
  parsePeerSpec,
  resolveClaudeReceiver,
  resolveClaudeRegistryTarget,
} from "../hub/team/native-peer.mjs";
import {
  formatRemotePeerMessage,
  readPeerInput,
  resolveRemoteHost,
  sendRemotePeer,
  validatePeerEnvelope,
  validatePeerResponse,
} from "../hub/team/ssh-peer.mjs";
import {
  agyConversation,
  discoverPeerTargets,
  formatPeerReply,
  matchPeerCandidates,
  resolveCodexTmuxThread,
  resolvePeerSender,
} from "./tfx-live.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function receiveRemote(args, deps) {
  if (args.length !== 1) throw new Error("_receive accepts JSON stdin only");
  const envelope = await readPeerInput(deps.input || process.stdin);
  let started = false;
  const response = (stage, result) => ({
    version: 1,
    correlationId: envelope.correlationId,
    stage,
    result,
  });
  try {
    if (!["darwin", "linux"].includes(deps.platform || process.platform))
      throw new Error(
        "Remote peer supports only Darwin and POSIX Linux receivers",
      );
    (deps.resolveRemoteHost || resolveRemoteHost)(envelope.originHost, deps);
    const deliveryDeps = {
      ...deps,
      onWriteStart: () => {
        started = true;
      },
    };
    const result = await deliverLocal(
      envelope.to,
      formatRemotePeerMessage(envelope),
      envelope.sender,
      deliveryDeps,
      true,
    );
    const wire = response("delivery", {
      ...result,
      retrySafe: false,
      modelReceipt: false,
    });
    validatePeerResponse(wire, envelope.correlationId);
    return wire;
  } catch (error) {
    return response(started ? "delivery" : "preflight", {
      status: started ? "unknown" : "rejected",
      retrySafe: false,
      modelReceipt: false,
      error: error.message.slice(0, 4096),
    });
  }
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const platform = deps.platform || process.platform;
  if (args[0] === "_receive") return receiveRemote(args, deps);
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
  const { to, message, from, host, replyHost } = parsePeerArgs(args);
  const [cli] = to.split(":");
  if (platform === "win32" && (cli === "codex" || cli === "agy"))
    throw new Error(
      `Windows 에서는 ${cli === "codex" ? "Codex" : "agy"} 대상을 아직 지원하지 않는다`,
    );
  const env = deps.env || process.env;
  if (host && !["darwin", "linux"].includes(platform))
    throw new Error("Remote peer supports only Darwin and POSIX Linux senders");
  const candidates =
    platform === "win32"
      ? []
      : await (deps.discover || discoverPeerTargets)({ deps });
  const sender = await resolvePeerSender({
    from,
    env,
    allCandidates: candidates,
    deps,
  });
  if (host) {
    if (
      sender.cli === "unknown" ||
      (!from && !env.TFX_LIVE_FROM && sender.name === sender.cli)
    )
      throw new Error("Unknown sender; use --from CLI:NAME");
    // UUID와 표시 이름은 분리한다. 이 값은 회신 경로일 뿐 수신 권한이 아니다.
    const explicit = from || env.TFX_LIVE_FROM;
    const matched = explicit
      ? UUID.test(sender.name || "")
        ? candidates.filter(
            (c) =>
              c.cli === sender.cli &&
              [c.threadId, c.conversationId, c.sessionId].some(
                (id) =>
                  typeof id === "string" &&
                  id.toLowerCase() === sender.name.toLowerCase(),
              ),
          )
        : matchPeerCandidates(
            candidates.filter((c) => c.cli === sender.cli),
            sender.name,
          )
      : [];
    const own = explicit
      ? matched.length === 1
        ? matched[0]
        : null
      : candidates.find(
          (c) =>
            c.cli === sender.cli &&
            ((sender.cli === "codex" && c.threadId === env.CODEX_THREAD_ID) ||
              (sender.cli === "agy" &&
                c.conversationId === env.ANTIGRAVITY_CONVERSATION_ID) ||
              (sender.cli !== "codex" &&
                c.paneId &&
                c.paneId === env.TMUX_PANE)),
        );
    const id =
      own?.threadId ||
      own?.conversationId ||
      own?.sessionId ||
      sender.sessionId;
    const envId = !explicit
      ? sender.cli === "codex"
        ? env.CODEX_THREAD_ID
        : sender.cli === "agy"
          ? env.ANTIGRAVITY_CONVERSATION_ID
          : null
      : null;
    const exactId = UUID.test(id || "")
      ? id
      : UUID.test(envId || "")
        ? envId
        : UUID.test(sender.name || "")
          ? sender.name
          : null;
    const envelope = validatePeerEnvelope({
      version: 1,
      correlationId: randomUUID(),
      to,
      message,
      originHost: replyHost,
      replyHost: host,
      sender: {
        cli: sender.cli,
        name:
          (UUID.test(sender.name || "") ? own?.name : null) ||
          sender.name ||
          sender.sessionId ||
          "unknown",
        ...(exactId ? { id: exactId } : {}),
      },
    });
    return sendRemotePeer(envelope, deps);
  }
  if (cli === "claude" && (env.CLAUDECODE === "1" || sender.cli === "claude"))
    throw new Error("Claude-to-Claude uses native SendMessage, not tfx-peer");
  const formattedMessage = [
    `[tfx-peer from=${sender.cli}:${String(sender.name || sender.sessionId || "unknown").replace(/[\r\n\u2028\u2029]+/g, " ")} msg=${randomUUID()}]`,
    message,
    formatPeerReply(sender, cli, { platform }),
  ].join("\n");
  return deliverLocal(to, formattedMessage, sender, { ...deps, candidates });
}

async function deliverLocal(
  to,
  formattedMessage,
  sender,
  deps,
  remote = false,
) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const [cli, name] = parsePeerSpec(to).split(":");
  if (platform === "win32" && (cli === "codex" || cli === "agy"))
    throw new Error(
      `Windows 에서는 ${cli === "codex" ? "Codex" : "agy"} 대상을 아직 지원하지 않는다`,
    );
  if (cli === "claude") {
    const target = (
      deps.resolveClaudeRegistryTarget || resolveClaudeRegistryTarget
    )(name, { platform });
    return (deps.deliverClaude || deliverClaude)({
      sessionId: target.sessionId,
      receiver: target.receiver,
      message: formattedMessage,
      ...(remote ? { onWriteStart: deps.onWriteStart } : {}),
      platform,
    });
  }
  const candidates =
    deps.candidates || (await (deps.discover || discoverPeerTargets)({ deps }));
  const matched =
    remote && UUID.test(name)
      ? candidates.filter(
          (x) =>
            x.cli === cli &&
            (cli === "codex" ? x.threadId : x.conversationId)?.toLowerCase() ===
              name.toLowerCase(),
        )
      : matchPeerCandidates(
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
      ...(remote ? { onWriteStart: deps.onWriteStart } : {}),
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
    ...(remote ? { onWriteStart: deps.onWriteStart } : {}),
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
      const status = result.result?.status || result.status;
      if (status === "partial" || status === "unknown") process.exitCode = 2;
      if (status === "rejected") process.exitCode = 1;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
