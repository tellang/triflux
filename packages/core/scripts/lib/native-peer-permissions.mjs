import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  let ancestor = packageRoot;
  while (true) {
    if (existing(path.join(ancestor, ".git"))) return false;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stack = [packageRoot];
  while (stack.length) {
    const current = stack.pop();
    const meta = existing(current);
    if (
      !meta ||
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
export function peerPermissionPlan({
  home,
  packageRoot,
  nodePath = resolveStableNodeBin(),
  tmuxPath = trustedTmuxPath(),
}) {
  if (
    !path.isAbsolute(home) ||
    !path.isAbsolute(packageRoot) ||
    !path.isAbsolute(nodePath) ||
    (tmuxPath && !path.isAbsolute(tmuxPath))
  )
    throw new Error("Absolute paths required");
  const wrapper = path.join(home, ".claude", "scripts", "tfx-peer");
  const entry = path.join(packageRoot, "bin", "tfx-peer.mjs");
  const script = `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH PSMUX_BIN PSMUX_SHELL DYLD_INSERT_LIBRARIES LD_PRELOAD LD_LIBRARY_PATH\nPATH=${quote(`${tmuxPath ? `${path.dirname(tmuxPath)}:` : ""}/usr/bin:/bin:/usr/sbin:/sbin`)}\nexport PATH\nr=${quote(packageRoot)}\n[ "$(cd -P "$r" 2>/dev/null && pwd -P)" = "$r" ] && [ ! -e "$r/.git" ] || { echo 'tfx-peer: untrusted package tree' >&2; exit 126; }\nexec ${quote(nodePath)} ${quote(entry)} "$@"\n`;
  const allow = `Bash(${wrapper} send:*)`;
  const codexRule = `prefix_rule(pattern=[${JSON.stringify(wrapper)}, "send"], decision="allow")\n`;
  return {
    entry,
    wrapper,
    script,
    allow,
    codexRule,
    settings: path.join(home, ".claude", "settings.json"),
    rule: path.join(home, ".codex", "rules", "triflux-native-peer.rules"),
    manifest: path.join(home, ".claude", "scripts", "tfx-peer-consent.json"),
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
} = {}) {
  const plan = peerPermissionPlan({ home, packageRoot, nodePath, tmuxPath });
  if (platform === "win32") return { status: "unsupported", plan };
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
  const previous = read(plan.manifest);
  let manifest = null;
  try {
    manifest = previous ? JSON.parse(previous) : null;
  } catch {
    return { status: "modified", plan };
  }
  if (!manifest)
    return {
      status:
        existing(plan.wrapper) || existing(plan.rule)
          ? "conflict"
          : "unconfigured",
      plan,
    };
  if (manifest.contract !== plan.contract)
    return { status: "different-contract", plan };
  const wrapper = read(plan.wrapper),
    rule = read(plan.rule);
  let settings;
  try {
    settings = JSON.parse(read(plan.settings) || "{}");
  } catch {
    return { status: "modified", plan };
  }
  if (
    wrapper !== plan.script ||
    rule !== plan.codexRule ||
    !settings.permissions?.allow?.includes(plan.allow)
  )
    return { status: "modified", plan };
  return { status: "approved", plan };
}
export function installPeerPermission({
  home,
  packageRoot,
  nodePath,
  tmuxPath,
  consent = false,
  dryRun = false,
  platform = process.platform,
} = {}) {
  const inspected = inspectPeerPermission({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    platform,
  });
  const { plan, status } = inspected;
  if (status === "approved") return { status: "approved", changed: false };
  if (
    status === "conflict" ||
    status === "unavailable" ||
    status === "unsupported"
  )
    return {
      status,
      changed: false,
      error:
        status === "unavailable"
          ? "Trusted peer adapter entry is absent or unsafe"
          : "Existing peer approval files are not owned by this exact consent contract",
    };
  if (!consent || dryRun)
    return {
      status: dryRun ? "dry-run" : status,
      changed: false,
      preview: {
        wrapper: plan.wrapper,
        settings: plan.settings,
        rule: plan.rule,
        trustsPackageRoot: packageRoot,
      },
    };
  const lock = `${plan.manifest}.lock`;
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
    });
    if (fresh.status !== status)
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
      for (const file of [
        plan.wrapper,
        plan.settings,
        plan.rule,
        plan.manifest,
      ])
        if (file === plan.settings) settingsBackup = backup(file);
        else backup(file);
      atomic(plan.wrapper, plan.script, 0o700);
      steps.push("wrapper");
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
        `${JSON.stringify({ contract: plan.contract, packageRoot, wrapper: plan.wrapper, allow: plan.allow, rule: plan.rule }, null, 2)}\n`,
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
export async function offerPeerPermission({
  home,
  packageRoot,
  interactive = false,
  dryRun = false,
  fromUpdate = false,
  verbose = false,
  ask = async () => false,
  notice = () => {},
  warn = () => {},
  nodePath,
  tmuxPath,
  platform = process.platform,
} = {}) {
  const state = inspectPeerPermission({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    platform,
  });
  if (state.status === "unsupported")
    return { status: "unsupported", changed: false };
  if (state.status === "approved")
    return { status: "approved", changed: false };
  if (fromUpdate) {
    if (verbose)
      notice(
        `Native peer adapter: ${state.status}; update는 승인 설정을 바꾸지 않는다. 재승인은 tfx setup에서 명시적으로 선택한다.`,
      );
    return { status: state.status, changed: false };
  }
  if (state.status === "conflict" || state.status === "unavailable") {
    if (state.status === "conflict")
      warn(
        `Peer 승인 파일이 충돌한다. ${state.plan.wrapper}, ${state.plan.rule}, ${state.plan.manifest}, ${state.plan.manifest}.lock을 확인하고 해당 어댑터 파일만 직접 정리한 뒤 재동의한다. 자동 삭제하지 않는다.`,
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
  if (!interactive || dryRun) {
    notice(
      "Native peer adapter 전역 승인은 선택 사항이다. tfx setup 에서 설정할 수 있다.",
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
    `승인 예정: ${state.plan.wrapper} send, ${state.plan.settings}, ${state.plan.rule}. 이 경로의 향후 Triflux 패키지 업데이트도 신뢰한다. Bash/node 전체 권한은 확대하지 않는다.`,
  );
  if (
    !(await ask(
      "Claude·Codex에서 tfx-peer send 어댑터만 전역 자동 승인할까요?",
    ))
  )
    return { status: "declined", changed: false };
  const result = installPeerPermission({
    home,
    packageRoot,
    nodePath,
    tmuxPath,
    platform,
    consent: true,
  });
  if (result.status === "partial" || result.status === "failed")
    warn(`Peer adapter 승인 일부 실패: ${result.error}`);
  return result;
}
