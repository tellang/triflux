import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import {
  approvedPeerDestination,
  PEER_HOST_ALIAS,
  readProtectedPeerJson,
  remoteSshDestination,
  resolveRemoteHost,
} from "../lib/remote-peer-hosts.mjs";
import { parsePeerSpec } from "./native-peer.mjs";

export { resolveRemoteHost } from "../lib/remote-peer-hosts.mjs";

export const PEER_WIRE_LIMIT = 65536;
export const PEER_RECEIVER_COMMAND =
  'exec "$HOME/.claude/scripts/tfx-peer" _receive';
const WINDOWS_PEER_ENTRY = String.raw`triflux\bin\tfx-peer.mjs`;
const WINDOWS_RECEIVER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$npmRoot = @('' | npm.cmd root --global)
if ($LASTEXITCODE -ne 0 -or $npmRoot.Count -ne 1 -or !$npmRoot[0]) { throw 'Cannot resolve the npm global root' }
$entry = Join-Path $npmRoot[0] '${WINDOWS_PEER_ENTRY}'
if (!(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Triflux peer entry is missing' }
node.exe $entry _receive
exit $LASTEXITCODE
`;
const WINDOWS_RECEIVER_COMMAND = `pwsh.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WINDOWS_RECEIVER_SCRIPT, "utf16le").toString("base64")}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validatePeerEnvelope(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1
  )
    throw new Error("Unsupported peer protocol version");
  if (
    typeof value.correlationId !== "string" ||
    !UUID.test(value.correlationId)
  )
    throw new Error("Invalid correlation ID");
  for (const key of ["originHost", "replyHost"])
    if (typeof value[key] !== "string" || !PEER_HOST_ALIAS.test(value[key]))
      throw new Error(`Invalid ${key}`);
  if (
    typeof value.message !== "string" ||
    !value.message ||
    value.message.length > 8000
  )
    throw new Error("Peer message requires 1..8000 chars");
  if (parsePeerSpec(value.to) !== value.to)
    throw new Error("Noncanonical peer target");
  const sender = value.sender;
  if (!sender || !["claude", "codex", "agy"].includes(sender.cli))
    throw new Error("Unknown sender; use --from CLI:NAME");
  if (typeof sender.name !== "string") throw new Error("Invalid sender name");
  parsePeerSpec(`${sender.cli}:${sender.name}`);
  if (sender.name === "unknown")
    throw new Error("Unknown sender; use --from CLI:NAME");
  if (
    sender.id !== undefined &&
    (typeof sender.id !== "string" || !UUID.test(sender.id))
  )
    throw new Error("Invalid sender conversation ID");
  const keys = [
    "version",
    "correlationId",
    "to",
    "message",
    "originHost",
    "replyHost",
    "sender",
  ];
  if (
    Object.keys(value).some((k) => !keys.includes(k)) ||
    Object.keys(sender).some((k) => !["cli", "name", "id"].includes(k))
  )
    throw new Error("Unexpected peer metadata");
  if (Buffer.byteLength(JSON.stringify(value)) > PEER_WIRE_LIMIT)
    throw new Error("Peer envelope too large");
  return value;
}

export async function readPeerInput(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > PEER_WIRE_LIMIT) throw new Error("Peer envelope too large");
    chunks.push(bytes);
  }
  return validatePeerEnvelope(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
}

export function formatRemotePeerMessage(envelope, originOs, platform) {
  const { sender, correlationId, originHost, replyHost, message, to } =
    envelope;
  const windows = platform === "win32";
  const quote = windows
    ? (s) => `'${s.replace(/['‘’‚‛]/g, (mark) => mark + mark)}'`
    : (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const command = windows
    ? `node.exe (Join-Path (npm.cmd root --global) '${WINDOWS_PEER_ENTRY}')`
    : quote(path.join(homedir(), ".claude", "scripts", "tfx-peer"));
  const from = windows ? ` --from ${quote(to)}` : "";
  return [
    `[tfx-peer from=${sender.cli}:${sender.name} msg=${correlationId} origin=${originHost}${sender.id ? ` fromId=${sender.id}` : ""}]`,
    message,
    originOs === "windows" && sender.cli === "agy"
      ? "회신: Windows 호스트는 Claude와 Codex 세션으로의 회신을 지원한다"
      : `회신: ${command} remote-send${from} --host ${quote(originHost)} --reply-host ${quote(replyHost)} --to ${quote(`${sender.cli}:${sender.id || sender.name}`)} --message '...'`,
  ].join("\n");
}

export function validatePeerResponse(response, correlationId) {
  const result = response?.result;
  if (
    response?.version !== 1 ||
    response.correlationId !== correlationId ||
    !["preflight", "delivery"].includes(response.stage) ||
    !["sent", "written", "unknown", "partial", "rejected"].includes(
      result?.status,
    ) ||
    result.retrySafe !== false ||
    result.modelReceipt !== false ||
    (response.stage === "preflight") !== (result.status === "rejected") ||
    (result.msgId !== undefined &&
      (typeof result.msgId !== "string" ||
        !result.msgId ||
        result.msgId.length > 512)) ||
    (result.error !== undefined && typeof result.error !== "string")
  )
    throw new Error("Invalid remote peer response version/ID/status");
  return result;
}

export async function sendRemotePeer(envelope, deps = {}) {
  validatePeerEnvelope(envelope);
  const platform = deps.platform || process.platform;
  if (!["darwin", "linux", "win32"].includes(platform))
    throw new Error(
      "Remote peer supports only Darwin, POSIX Linux and Windows senders",
    );
  const approval = deps.remoteApproval;
  let destination;
  if (approval) {
    try {
      const snapshot = readProtectedPeerJson(approval.manifest).approval;
      if (
        snapshot?.hostsPath !== approval.hostsPath ||
        !Array.isArray(snapshot.destinations)
      )
        throw new Error("Invalid approval");
      const host = resolveRemoteHost(envelope.replyHost, {
        hostsPath: approval.hostsPath,
        protectedRegistry: true,
      });
      destination = approvedPeerDestination(host);
      const { name, address, user, port, os } = destination;
      if (
        !user ||
        !snapshot.destinations.some(
          (item) =>
            item?.name === name &&
            item.address === address &&
            item.user === user &&
            item.port === port &&
            item.os === os,
        )
      )
        throw new Error("Destination changed");
    } catch {
      throw new Error(
        "Remote peer approval does not cover this destination; reapprove in triflux setup or request permission for a manual send",
      );
    }
  } else {
    const lookup = deps.resolveRemoteHost || resolveRemoteHost;
    destination = remoteSshDestination(lookup(envelope.replyHost, deps));
  }
  const { address, user, port, os } = destination;
  if (os === "windows" && envelope.to.startsWith("agy:"))
    throw new Error(
      "Windows remote peer destinations support only Claude and Codex targets",
    );
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
  ];
  if (approval)
    args.push(
      "-o",
      `HostName=${address}`,
      "-o",
      "CanonicalizeHostname=no",
      "-o",
      "ControlPath=none",
    );
  if (port !== undefined) args.push("-p", String(port));
  args.push(
    "--",
    user ? `${user}@${address}` : address,
    os === "windows" ? WINDOWS_RECEIVER_COMMAND : PEER_RECEIVER_COMMAND,
  );
  const uncertain = (error) => ({
    status: "unknown",
    correlationId: envelope.correlationId,
    retrySafe: false,
    modelReceipt: false,
    error,
  });
  const wire = await new Promise((resolve) => {
    let child;
    try {
      child = (deps.spawn || spawn)(approval ? "/usr/bin/ssh" : "ssh", args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: deps.env || process.env,
      });
    } catch (error) {
      resolve({ error: error.message });
      return;
    }
    const stdout = [];
    let size = 0,
      error = null;
    const stop = (reason) => {
      error = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop("SSH peer timeout; delivery outcome unknown"),
      deps.timeoutMs ?? 15000,
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > PEER_WIRE_LIMIT) stop("Remote peer response too large");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > PEER_WIRE_LIMIT) stop("SSH peer output too large");
    });
    child.stdin.on("error", (err) => {
      error ||= `SSH stdin: ${err.code || err.message}`;
    });
    child.once("error", (err) => {
      error ||= `SSH execution: ${err.message}`;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), code, error });
    });
    child.stdin.end(JSON.stringify(envelope));
  });
  if (wire.error) return uncertain(wire.error);
  try {
    if (!wire.stdout?.trim())
      throw new Error(
        "Empty remote peer response; protocol unavailable or response lost",
      );
    const response = JSON.parse(wire.stdout);
    const result = validatePeerResponse(response, envelope.correlationId);
    const expectedCode =
      result.status === "rejected"
        ? 1
        : ["unknown", "partial"].includes(result.status)
          ? 2
          : 0;
    if (wire.code !== expectedCode)
      return {
        ...result,
        ...uncertain("SSH exit/status mismatch; delivery outcome unknown"),
      };
    return { ...result, correlationId: envelope.correlationId };
  } catch (error) {
    return uncertain(error.message);
  }
}
