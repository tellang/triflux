import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { normalizeHost, userStateHostsPath } from "./hosts-compat.mjs";

export const PEER_HOST_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function readProtectedPeerJson(file) {
  const parent = dirname(file);
  const directory = lstatSync(parent);
  const owners = [0, process.getuid()];
  if (
    !isAbsolute(file) ||
    realpathSync(parent) !== parent ||
    !directory.isDirectory() ||
    !owners.includes(directory.uid) ||
    (directory.mode & 0o022) !== 0
  )
    throw new Error("Untrusted peer configuration path");
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const meta = fstatSync(fd);
    if (
      !meta.isFile() ||
      !owners.includes(meta.uid) ||
      (meta.mode & 0o022) !== 0
    )
      throw new Error("Untrusted peer configuration file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export function remoteSshDestination(host) {
  return {
    address:
      host.ssh?.host || host.tailscale?.dns || host.tailscale?.ip || host.name,
    user: host.ssh_user ?? null,
    port: host.ssh?.port,
  };
}

function normalizeRemoteHost(name, raw, allowWindows = false) {
  const os = typeof raw?.os === "string" ? raw.os.toLowerCase() : "";
  if (
    !["darwin", "macos", "linux"].includes(os) &&
    !(allowWindows && os === "windows")
  )
    throw new Error("Remote peer supports only Darwin and POSIX Linux hosts");
  const host = normalizeHost(raw, name);
  const { address, user, port } = remoteSshDestination(host);
  if (
    typeof address !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(address) ||
    (user != null &&
      (typeof user !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user)))
  )
    throw new Error("Invalid registered SSH address/user");
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("Invalid registered SSH port");
  return host;
}

export function resolveRemoteHost(
  alias,
  {
    hostsPath = userStateHostsPath(),
    protectedRegistry = false,
    allowWindows = false,
  } = {},
) {
  if (typeof alias !== "string" || !PEER_HOST_ALIAS.test(alias))
    throw new Error("Invalid registered host alias");
  if (!hostsPath) throw new Error("User-state hosts.json is required");
  const registry = protectedRegistry
    ? readProtectedPeerJson(hostsPath)
    : JSON.parse(readFileSync(hostsPath, "utf8"));
  const matches = Object.entries(registry.hosts || {}).filter(
    ([name, host]) =>
      name === alias ||
      (Array.isArray(host?.aliases) && host.aliases.includes(alias)),
  );
  if (matches.length !== 1)
    throw new Error("Host alias is unregistered or ambiguous");
  const [name, raw] = matches[0];
  return normalizeRemoteHost(name, raw, allowWindows);
}

export function approvedPeerDestination(host) {
  const { address, user, port } = remoteSshDestination(host);
  return {
    name: host.name,
    address: address.toLowerCase(),
    user,
    port: port ?? 22,
  };
}

export function snapshotPeerDestinations(hostsPath) {
  const registry = readProtectedPeerJson(hostsPath);
  const destinations = [];
  for (const name of Object.keys(registry.hosts || {}).sort()) {
    if (!PEER_HOST_ALIAS.test(name)) continue;
    try {
      const destination = approvedPeerDestination(
        normalizeRemoteHost(name, registry.hosts[name]),
      );
      if (destination.user) destinations.push(destination);
    } catch {
      // 수동 전송도 거부하는 등록 항목은 승인 목록에서 뺀다.
    }
  }
  return { hostsPath, destinations };
}
