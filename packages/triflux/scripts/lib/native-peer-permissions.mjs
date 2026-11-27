import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { snapshotPeerDestinations } from "../../hub/lib/remote-peer-hosts.mjs";
import { resolveStableNodeBin } from "./stable-node.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const read = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const trustedTmuxPath = () =>
  [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
    "/bin/tmux",
    "/home/linuxbrew/.linuxbrew/bin/tmux",
  ].find((file) => existing(file));
function trustedHelperPath(file) {
  if (!file || !path.isAbsolute(file)) return false;
  const base = path.dirname(path.dirname(file));
  let resolved;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    return false;
  }
  const safe = (target, alias = false) => {
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    let current = base;
    const parts = rel.split(path.sep);
    const baseMeta = existing(base);
    if (
      !baseMeta?.isDirectory() ||
      ![0, process.getuid()].includes(baseMeta.uid) ||
      (baseMeta.mode & 0o002) !== 0
    )
      return false;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const meta = existing(current);
      if (!meta || ![0, process.getuid()].includes(meta.uid)) return false;
      if (meta.isSymbolicLink()) {
        if (!alias || i !== parts.length - 1) return false;
        continue;
      }
      if ((meta.mode & 0o002) !== 0) return false;
      if (i < parts.length - 1 ? !meta.isDirectory() : !meta.isFile())
        return false;
    }
    return true;
  };
  return (
    safe(file, true) &&
    safe(resolved) &&
    (existing(resolved).mode & 0o111) !== 0
  );
}
function trustedPackageTree(packageRoot, nodePath, tmuxPath) {
  if (!trustedHelperPath(tmuxPath)) return false;
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    let meta;
    try {
      meta = fs.statSync(dir);
    } catch {
      return false;
    }
    if (!meta.isDirectory() || meta.uid !== 0 || (meta.mode & 0o002) !== 0)
      return false;
  }
  const prefix = path.dirname(path.dirname(nodePath));
  try {
    if (fs.realpathSync(packageRoot) !== packageRoot) return false;
  } catch {
    return false;
  }
  if (
    path.resolve(packageRoot) !==
    path.join(prefix, "lib", "node_modules", "triflux")
  )
    return false;
  const safePath = (target, { base = prefix, finalLink = false } = {}) => {
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    let current = base;
    const parts = rel ? ["", ...rel.split(path.sep)] : [""];
    for (let index = 0; index < parts.length; index++) {
      if (index) current = path.join(current, parts[index]);
      const meta = existing(current);
      if (!meta || ![0, process.getuid()].includes(meta.uid)) return false;
      if (meta.isSymbolicLink()) {
        if (!finalLink || index !== parts.length - 1) return false;
        continue;
      }
      if ((meta.mode & 0o002) !== 0) return false;
      if (index < parts.length - 1 && !meta.isDirectory()) return false;
    }
    return true;
  };
  let resolvedNode;
  let resolvedPrefix;
  try {
    resolvedNode = fs.realpathSync(nodePath);
    resolvedPrefix = fs.realpathSync(prefix);
  } catch {
    return false;
  }
  if (
    !safePath(path.join(prefix, "lib", "node_modules")) ||
    !safePath(nodePath, { finalLink: true }) ||
    !safePath(resolvedNode, { base: resolvedPrefix }) ||
    !existing(resolvedNode)?.isFile()
  )
    return false;
  // Homebrew prefix는 git 저장소일 수 있으므로 node_modules까지만 검사한다.
  let ancestor = packageRoot;
  while (true) {
    if (existing(path.join(ancestor, ".git"))) return false;
    if (ancestor === path.dirname(packageRoot)) break;
    ancestor = path.dirname(ancestor);
  }
  const stack = [packageRoot];
  while (stack.length) {
    const current = stack.pop();
    const meta = existing(current);
    if (
      !meta ||
      path.basename(current).toLowerCase() === ".git" ||
      meta.isSymbolicLink() ||
      ![0, process.getuid()].includes(meta.uid) ||
      (meta.mode & 0o002) !== 0
    )
      return false;
    if (meta.isDirectory())
      for (const child of fs.readdirSync(current))
        stack.push(path.join(current, child));
    else if (!meta.isFile()) return false;
  }
  return true;
}
function existing(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function atomic(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, contents, { mode, flag: "wx" });
    fs.renameSync(temp, file);
    fs.chmodSync(file, mode);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.tfx-peer-backup-${Date.now()}-${randomBytes(4).toString("hex")}`;
  fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, 0o600);
  return dest;
}
function keepOnlyLatestSettingsBackup(file, latest) {
  if (!latest) return;
  const prefix = `${path.basename(file)}.tfx-peer-backup-`;
  for (const name of fs.readdirSync(path.dirname(file))) {
    if (
      !name.startsWith(prefix) ||
      !/^\d{13}-[0-9a-f]{8}$/.test(name.slice(prefix.length))
    )
      continue;
    const candidate = path.join(path.dirname(file), name);
    const meta = existing(candidate);
    if (
      candidate !== latest &&
      meta?.isFile() &&
      meta.uid === process.getuid() &&
      (meta.mode & 0o777) === 0o600
    )
      fs.unlinkSync(candidate);
  }
}
// verb마다 래퍼, 허용 규칙, 동의 파일을 따로 두고 설치 잠금은 함께 쓴다.
export function peerPermissionPlan({
  home,
  packageRoot,
  nodePath = resolveStableNodeBin(),
  tmuxPath = trustedTmuxPath(),
  verb = "send",
}) {
  if (
    !path.isAbsolute(home) ||
    !path.isAbsolute(packageRoot) ||
    !path.isAbsolute(nodePath) ||
    (tmuxPath && !path.isAbsolute(tmuxPath))
  )
    throw new Error("Absolute paths required");
  const scripts = path.join(home, ".claude", "scripts");
  const suffix = verb === "send" ? "" : "-remote";
  const wrapper = path.join(scripts, `tfx-peer${suffix}`);
  const manifest = path.join(scripts, `tfx-peer${suffix}-consent.json`);
  const hostsPath = suffix
    ? path.join(home, ".config", "triflux", "hosts.json")
    : null;
  const entry = path.join(packageRoot, "bin", "tfx-peer.mjs");
  const remoteSetup = hostsPath
    ? `[ "$1" = remote-send ] || exit 126\nexport HOME=${quote(home)}\nunset TFX_HOSTS_USER_STATE TFX_HOSTS_USER_STATE_DISABLE\n`
    : "";
  const invocation = hostsPath
    ? `_approved-remote ${quote(manifest)} ${quote(hostsPath)} `
    : "";
  const script = `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH PSMUX_BIN PSMUX_SHELL DYLD_INSERT_LIBRARIES LD_PRELOAD LD_LIBRARY_PATH\nPATH=${quote(`${tmuxPath ? `${path.dirname(tmuxPath)}:` : ""}/usr/bin:/bin:/usr/sbin:/sbin`)}\nexport PATH\nr=${quote(packageRoot)}\n[ "$(cd -P "$r" 2>/dev/null && pwd -P)" = "$r" ] && [ ! -e "$r/.git" ] || { echo 'tfx-peer: untrusted package tree' >&2; exit 126; }\n${remoteSetup}exec ${quote(nodePath)} ${quote(entry)} ${invocation}"$@"\n`;
  const allow = `Bash(${wrapper} ${verb}:*)`;
  const codexRule = `prefix_rule(pattern=[${JSON.stringify(wrapper)}, "${verb}"], decision="allow")\n`;
  return {
    entry,
    wrapper,
    script,
    allow,
    codexRule,
    settings: path.join(home, ".claude", "settings.json"),
    rule: path.join(
      home,
      ".codex",
      "rules",
      `triflux-native-peer${suffix}.rules`,
    ),
    manifest,
    hostsPath,
    lock: path.join(scripts, "tfx-peer-consent.json.lock"),
    contract: hash(
      JSON.stringify({
        wrapper,
        entry,
        nodePath,
        tmuxPath,
        script,
        allow,
        codexRule,
      }),
    ),
  };
}
export function inspectPeerPermission({
  home,
  packageRoot,
  nodePath,
  tmuxPath,
  platform = process.platform,
  verb = "send",
} = {}) {
  if (platform === "win32") return { status: "unsupported" };
  const plan = peerPermissionPlan({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    verb,
  });
  const send = plan.hostsPath
    ? inspectPeerPermission({ home, packageRoot, nodePath, tmuxPath, platform })
    : null;
  if (send && send.status !== "approved")
    return { status: "requires-send", plan };
  const effectiveNodePath = nodePath || resolveStableNodeBin();
  if (
    !trustedPackageTree(
      packageRoot,
      effectiveNodePath,
      tmuxPath || trustedTmuxPath(),
    )
  )
    return { status: "unavailable", plan };
  const boundaries = [
    home,
    path.join(home, ".claude"),
    path.join(home, ".claude", "scripts"),
    path.join(home, ".codex"),
    path.join(home, ".codex", "rules"),
  ];
  if (
    boundaries.some((dir) => {
      const meta = existing(dir);
      return (
        meta &&
        (!meta.isDirectory() ||
          meta.isSymbolicLink() ||
          meta.uid !== process.getuid() ||
          (meta.mode & 0o022) !== 0)
      );
    })
  )
    return { status: "conflict", plan };
  const entry = existing(plan.entry);
  if (
    !entry?.isFile() ||
    entry.isSymbolicLink() ||
    ![0, process.getuid()].includes(entry.uid) ||
    entry.mode & 0o002
  )
    return { status: "unavailable", plan };
  if (
    [plan.wrapper, plan.settings, plan.rule, plan.manifest].some((file) => {
      const meta = existing(file);
      return (
        meta &&
        (!meta.isFile() ||
          meta.isSymbolicLink() ||
          meta.uid !== process.getuid() ||
          (meta.mode & 0o022) !== 0 ||
          (file === plan.wrapper && (meta.mode & 0o777) !== 0o700))
      );
    })
  )
    return { status: "conflict", plan };
  let approval;
  if (send) {
    const settings = JSON.parse(read(plan.settings));
    const legacyAllow = `Bash(${send.plan.wrapper} remote-send:*)`;
    if (
      settings.permissions.allow.includes(legacyAllow) ||
      read(plan.rule) ===
        `prefix_rule(pattern=[${JSON.stringify(send.plan.wrapper)}, "remote-send"], decision="allow")\n`
    )
      return { status: "legacy-remote", plan, legacyAllow };
    try {
      approval = snapshotPeerDestinations(plan.hostsPath);
    } catch (error) {
      let reason = "등록 파일을 읽을 수 없다. 경로와 읽기 권한을 확인한다.";
      if (error.code === "ENOENT")
        reason = "등록 파일이 없다. 파일 경로를 확인한다.";
      else if (error instanceof SyntaxError)
        reason = "등록 파일의 JSON 형식이 잘못되었다. 형식을 확인한다.";
      else if (error.message?.startsWith("Untrusted peer configuration"))
        reason =
          "등록 파일의 소유자나 권한을 신뢰할 수 없다. 파일과 상위 디렉터리의 권한을 확인한다.";
      return { status: "host-registry-unavailable", plan, reason };
    }
    if (!approval.destinations.length)
      return { status: "no-destinations", plan };
  }
  const previous = read(plan.manifest);
  let manifest = null;
  try {
    manifest = previous ? JSON.parse(previous) : null;
  } catch {
    return { status: "modified", plan, approval };
  }
  if (!manifest)
    return {
      status:
        (verb === "send" && existing(plan.wrapper)) || existing(plan.rule)
          ? "conflict"
          : "unconfigured",
      plan,
      approval,
    };
  if (manifest.contract !== plan.contract)
    return { status: "different-contract", plan, approval };
  const wrapper = read(plan.wrapper),
    rule = read(plan.rule);
  let settings;
  try {
    settings = JSON.parse(read(plan.settings) || "{}");
  } catch {
    return { status: "modified", plan, approval };
  }
  if (
    wrapper !== plan.script ||
    rule !== plan.codexRule ||
    !settings.permissions?.allow?.includes(plan.allow)
  )
    return { status: "modified", plan, approval };
  if (
    approval &&
    JSON.stringify(manifest.approval) !== JSON.stringify(approval)
  )
    return { status: "destinations-changed", plan, approval };
  return { status: "approved", plan, approval };
}
export function installPeerPermission({
  home,
  packageRoot,
  nodePath,
  tmuxPath,
  consent = false,
  platform = process.platform,
  verb = "send",
  confirmedApproval,
} = {}) {
  const inspected = inspectPeerPermission({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    platform,
    verb,
  });
  const { plan, status } = inspected;
  if (
    [
      "unsupported",
      "requires-send",
      "legacy-remote",
      "no-destinations",
      "host-registry-unavailable",
    ].includes(status)
  )
    return { status, changed: false };
  if (status === "approved") return { status: "approved", changed: false };
  if (status === "conflict" || status === "unavailable")
    return {
      status,
      changed: false,
      error:
        status === "unavailable"
          ? "Trusted peer adapter entry is absent or unsafe"
          : "Existing peer approval files are not owned by this exact consent contract",
    };
  if (!consent)
    return {
      status,
      changed: false,
      preview: {
        wrapper: plan.wrapper,
        settings: plan.settings,
        rule: plan.rule,
        trustsPackageRoot: packageRoot,
      },
    };
  const { lock } = plan;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let lockHandle;
  try {
    lockHandle = fs.openSync(lock, "wx", 0o600);
  } catch {
    return {
      status: "busy",
      changed: false,
      error: "Peer approval install already in progress",
    };
  }
  const lockInode = fs.fstatSync(lockHandle).ino;
  try {
    const fresh = inspectPeerPermission({
      home,
      packageRoot,
      nodePath,
      tmuxPath,
      platform,
      verb,
    });
    if (
      fresh.status !== status ||
      JSON.stringify(fresh.approval) !== JSON.stringify(confirmedApproval)
    )
      return {
        status: "conflict",
        changed: false,
        error: "Peer approval changed before locked install",
      };
    const settingsBefore = read(plan.settings);
    const settingsMeta = existing(plan.settings);
    let settings;
    try {
      settings = JSON.parse(settingsBefore || "{}");
    } catch {
      return {
        status: "failed",
        changed: false,
        error: "Claude settings JSON invalid",
      };
    }
    if (
      settings.permissions &&
      !Array.isArray(settings.permissions.allow) &&
      settings.permissions.allow !== undefined
    )
      return {
        status: "failed",
        changed: false,
        error: "Claude allow is not an array",
      };
    if (
      (existing(plan.wrapper) && read(plan.wrapper) !== plan.script) ||
      (existing(plan.rule) && read(plan.rule) !== plan.codexRule)
    )
      return {
        status: "conflict",
        changed: false,
        error:
          "Existing peer wrapper or rule was modified; remove it explicitly before regrant",
      };
    const allow = new Set(settings.permissions?.allow || []);
    allow.add(plan.allow);
    settings.permissions = {
      ...(settings.permissions || {}),
      allow: [...allow],
    };
    const steps = [];
    try {
      if (
        read(plan.settings) !== settingsBefore ||
        existing(plan.settings)?.ino !== settingsMeta?.ino
      )
        return {
          status: "conflict",
          changed: false,
          error: "Claude settings changed before install",
        };
      let settingsBackup = null;
      const installsWrapper = verb === "send" || !existing(plan.wrapper);
      for (const file of [
        ...(installsWrapper ? [plan.wrapper] : []),
        plan.settings,
        plan.rule,
        plan.manifest,
      ])
        if (file === plan.settings) settingsBackup = backup(file);
        else backup(file);
      if (installsWrapper) {
        atomic(plan.wrapper, plan.script, 0o700);
        steps.push("wrapper");
      }
      if (
        read(plan.settings) !== settingsBefore ||
        existing(plan.settings)?.ino !== settingsMeta?.ino
      )
        throw new Error(
          "Claude settings changed during install; existing deny preserved",
        );
      atomic(plan.settings, `${JSON.stringify(settings, null, 2)}\n`);
      steps.push("claude");
      atomic(plan.rule, plan.codexRule);
      steps.push("codex");
      atomic(
        plan.manifest,
        `${JSON.stringify({ contract: plan.contract, packageRoot, wrapper: plan.wrapper, allow: plan.allow, rule: plan.rule, ...(fresh.approval && { approval: fresh.approval }) }, null, 2)}\n`,
      );
      steps.push("manifest");
      try {
        keepOnlyLatestSettingsBackup(plan.settings, settingsBackup);
      } catch {}
      return { status: "approved", changed: true, steps };
    } catch (error) {
      return {
        status: "partial",
        changed: steps.length > 0,
        retrySafe: false,
        steps,
        error: error.message,
      };
    }
  } finally {
    fs.closeSync(lockHandle);
    try {
      if (fs.lstatSync(lock).ino === lockInode) fs.unlinkSync(lock);
    } catch {}
  }
}
async function offerPeerVerb({
  verb,
  home,
  packageRoot,
  interactive = false,
  fromUpdate = false,
  verbose = false,
  ask = async () => false,
  notice = () => {},
  warn = () => {},
  nodePath,
  tmuxPath,
  platform = process.platform,
} = {}) {
  const remote = verb === "remote-send";
  const label = remote ? "remote-send 사전 승인" : "Native peer adapter";
  const state = inspectPeerPermission({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    platform,
    verb,
  });
  if (state.status === "unsupported") {
    notice("Windows 는 자동 승인 없이 tfx-peer 를 직접 실행한다");
    return { status: "unsupported", changed: false };
  }
  if (state.status === "approved")
    return { status: "approved", changed: false };
  if (fromUpdate) {
    if (verbose)
      notice(
        `${label}: ${state.status}; update는 승인 설정을 바꾸지 않는다. 재승인은 tfx setup에서 명시적으로 선택한다.`,
      );
    return { status: state.status, changed: false };
  }
  const targets = [
    state.plan.wrapper,
    state.plan.rule,
    state.plan.manifest,
    state.plan.lock,
  ].join(", ");
  const cleanup = `확인 대상: ${targets}. Claude ${state.plan.settings}의 permissions.allow에서는 ${state.plan.allow} 항목만 확인한다. settings 전체나 다른 allow/deny는 삭제하지 않는다.`;
  if (state.status === "legacy-remote") {
    warn(
      `이전 원격 승인 규칙을 먼저 철회한다. Claude ${state.legacyAllow}, Codex ${state.plan.rule}, 원격 동의 ${state.plan.manifest}을 확인한다.`,
    );
    return { status: state.status, changed: false };
  }
  if (state.status === "no-destinations") {
    notice(
      `원격 사전 승인에 사용할 목적지가 없다. ${state.plan.hostsPath}에 SSH 사용자를 명시한 Darwin 또는 Linux 호스트를 등록한다.`,
    );
    return { status: state.status, changed: false };
  }
  if (state.status === "host-registry-unavailable") {
    warn(`원격 사전 승인 등록 파일 ${state.plan.hostsPath}: ${state.reason}`);
    return { status: state.status, changed: false };
  }
  if (state.status === "conflict" || state.status === "unavailable") {
    if (state.status === "conflict")
      warn(
        `Peer 승인 파일이 충돌한다. ${cleanup} 해당 어댑터 항목만 직접 정리한 뒤 재동의한다. 자동 삭제하지 않는다.`,
      );
    else {
      notice(
        "신뢰할 수 있는 설치본과 Node 런타임 경로가 없어 native peer 전역 승인은 불가하다. 권한을 완화하지 않는다.",
      );
      notice(
        "이미 수동 설정한 ~/.codex/rules/tfx-live.rules는 기존 tfx-live ask/queue/tmux 릴레이에 쓸 수 있다. native tfx-peer 전송이나 동일 승인으로 취급하지 않는다.",
      );
      if (existing(state.plan.manifest))
        notice(
          `기존 승인은 설정에 남아 있을 수 있다. Claude ${state.plan.allow}와 Codex ${state.plan.rule}을 확인해 수동 철회한다. 자동 삭제하지 않는다.`,
        );
    }
    return { status: state.status, changed: false };
  }
  if (!interactive) {
    notice(
      remote
        ? "remote-send 사전 승인은 선택 사항이다. tfx setup 에서 설정할 수 있다."
        : "Native peer adapter 전역 승인은 선택 사항이다. tfx setup 에서 설정할 수 있다.",
    );
    return { status: "deferred", changed: false };
  }
  try {
    const settings = JSON.parse(read(state.plan.settings) || "{}");
    if (
      settings.permissions?.classifyAllShell === true ||
      settings.classifyAllShell === true
    )
      notice(
        "Claude classifyAllShell=true이며 관리형 deny도 이 승인보다 우선할 수 있다. 기존 설정은 바꾸지 않는다.",
      );
  } catch {}
  notice(
    `승인 예정: ${state.plan.wrapper} ${verb}, ${state.plan.settings}, ${state.plan.rule}. ${
      remote
        ? `등록 파일은 ${state.plan.hostsPath}이다.`
        : "이 경로의 향후 Triflux 패키지 업데이트도 신뢰한다."
    } Bash/node 전체 권한은 확대하지 않는다.`,
  );
  let question =
    "Claude·Codex에서 tfx-peer send 어댑터만 전역 자동 승인할까요?";
  if (remote) {
    const { hostsPath, destinations } = state.approval;
    const scope = destinations
      .map(({ name, address, user, port }) => {
        const host = address.includes(":") ? `[${address}]` : address;
        return `${name} (${user}@${host}:${port})`;
      })
      .join(", ");
    question = `remote-send로 다음 목적지에 보낼 때 확인을 생략할까요? 등록 파일은 ${hostsPath}입니다. ${scope}. 목적지를 추가하거나 주소, SSH 사용자, 포트를 바꾸면 setup에서 재승인해야 합니다.`;
  }
  if (!(await ask(question))) return { status: "declined", changed: false };
  const result = installPeerPermission({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    platform,
    verb,
    consent: true,
    confirmedApproval: state.approval,
  });
  if (result.status === "busy")
    warn(
      `Peer adapter 승인 설치 잠금: ${state.plan.lock}. 실행 중인 설치가 없는지 확인한 뒤 직접 정리한다. 자동 삭제하지 않는다.`,
    );
  if (result.status === "conflict" || result.status === "partial")
    warn(`Peer adapter 승인 ${result.status}: ${result.error}. ${cleanup}`);
  else if (result.status === "failed")
    warn(`Peer adapter 승인 실패: ${result.error}`);
  return result;
}
export async function offerPeerPermission(options = {}) {
  const send = await offerPeerVerb({ ...options, verb: "send" });
  if (send.status !== "approved") return send;
  const remote = await offerPeerVerb({ ...options, verb: "remote-send" });
  return {
    ...send,
    changed: send.changed || Boolean(remote.changed),
    remote: remote.status,
  };
}
