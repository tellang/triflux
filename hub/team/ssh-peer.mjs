import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeHost, userStateHostsPath } from "../lib/hosts-compat.mjs";
import { parsePeerSpec } from "./native-peer.mjs";

export const PEER_WIRE_LIMIT = 65536;
export const PEER_RECEIVER_COMMAND =
  'exec "$HOME/.claude/scripts/tfx-peer" _receive';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// 사용자 설정만 읽는다. legacy migration과 source-tree 폴백은 호출하지 않는다.
export function resolveRemoteHost(
  alias,
  { hostsPath = userStateHostsPath() } = {},
) {
  if (typeof alias !== "string" || !ALIAS.test(alias))
    throw new Error("Invalid registered host alias");
  if (!hostsPath) throw new Error("User-state hosts.json is required");
  const registry = JSON.parse(readFileSync(hostsPath, "utf8"));
  const matches = Object.entries(registry.hosts || {}).filter(
    ([name, host]) =>
      name === alias ||
      (Array.isArray(host?.aliases) && host.aliases.includes(alias)),
  );
  if (matches.length !== 1)
    throw new Error("Host alias is unregistered or ambiguous");
  const [name, raw] = matches[0];
  if (
    !["darwin", "macos", "linux"].includes(
      typeof raw.os === "string" ? raw.os.toLowerCase() : "",
    )
  )
    throw new Error("Remote peer supports only Darwin and POSIX Linux hosts");
  const host = normalizeHost(raw, name);
  const address =
    host.ssh?.host || host.tailscale?.dns || host.tailscale?.ip || host.name;
  const user = host.ssh_user;
  if (
    typeof address !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(address) ||
    (user != null &&
      (typeof user !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user)))
  )
    throw new Error("Invalid registered SSH address/user");
  if (
    host.ssh?.port !== undefined &&
    (!Number.isInteger(host.ssh.port) ||
      host.ssh.port < 1 ||
      host.ssh.port > 65535)
  )
    throw new Error("Invalid registered SSH port");
  return host;
}

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
    if (typeof value[key] !== "string" || !ALIAS.test(value[key]))
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

export function formatRemotePeerMessage(envelope) {
  const { sender, correlationId, originHost, replyHost, message } = envelope;
  const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const command = quote(path.join(homedir(), ".claude", "scripts", "tfx-peer"));
  return [
    `[tfx-peer from=${sender.cli}:${sender.name} msg=${correlationId} origin=${originHost}${sender.id ? ` fromId=${sender.id}` : ""}]`,
    message,
    `회신: ${command} remote-send --host ${quote(originHost)} --reply-host ${quote(replyHost)} --to ${quote(`${sender.cli}:${sender.id || sender.name}`)} --message '...'`,
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
  if (!["darwin", "linux"].includes(platform))
    throw new Error("Remote peer supports only Darwin and POSIX Linux senders");
  const lookup = deps.resolveRemoteHost || resolveRemoteHost;
  const host = lookup(envelope.replyHost, deps);
  const address =
    host.ssh?.host || host.tailscale?.dns || host.tailscale?.ip || host.name;
  const user = host.ssh_user;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
  ];
  if (host.ssh?.port !== undefined) args.push("-p", String(host.ssh.port));
  args.push("--", user ? `${user}@${address}` : address, PEER_RECEIVER_COMMAND);
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
      child = (deps.spawn || spawn)("ssh", args, {
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
