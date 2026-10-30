import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const defaultFs = {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
};

// ARM64 Mach-O agy 바이너리의 time.After 함수와 유휴 대기 호출부 시그니처 (#1022 peer-wake 패치)
export const AGY_TIME_AFTER_SIG = Buffer.from(
  "900b40f9ff6330eb29010054fe0f1ef8fd831ff8fd2300d16affff97000040f9fd835ff8fe0742f8c0035fd6",
  "hex",
);
export const AGY_PEER_WAKE_ORIG_CALL = Buffer.from(
  "e13740f9220041a9423040f9210c40a9e40302aae20303aa80003fd6",
  "hex",
);
export const AGY_PEER_WAKE_PATCH_PREFIX = Buffer.from(
  "1f2003d51f2003d51f2003d51f2003d5004099524073a772",
  "hex",
);
export const AGY_PEER_WAKE_ORIG_STP = Buffer.from("e08708a9", "hex");
export const AGY_PEER_WAKE_PATCH_STP = Buffer.from("e0ff08a9", "hex");
const AGY_PEER_WAKE_STP_DELTA = 0x38;

export function encodeArm64Bl(pcOffset, targetOffset) {
  const delta = targetOffset - pcOffset;
  if (delta % 4 !== 0 || delta < -0x8000000 || delta > 0x7fffffc) {
    return null;
  }
  const imm26 = (delta >> 2) & 0x03ffffff;
  const out = Buffer.alloc(4);
  out.writeUInt32LE((0x94000000 | imm26) >>> 0, 0);
  return out;
}

function findUniqueOffset(buf, pattern) {
  const first = buf.indexOf(pattern);
  if (first === -1) return -1;
  if (buf.indexOf(pattern, first + 1) !== -1) return -2;
  return first;
}

export function inspectAgyPeerWakePatch({
  agyPath,
  platform = process.platform,
  arch = process.arch,
  fs = defaultFs,
} = {}) {
  if (platform !== "darwin" || arch !== "arm64") {
    return { ok: true, status: "skipped", platform, arch };
  }
  if (!agyPath) {
    return { ok: true, status: "skipped", reason: "agy-not-installed" };
  }
  let resolvedPath = agyPath;
  try {
    resolvedPath = fs.realpathSync(agyPath);
  } catch {
    return { ok: true, status: "skipped", reason: "agy-not-found" };
  }
  if (!fs.existsSync(resolvedPath)) {
    return { ok: true, status: "skipped", reason: "agy-not-found" };
  }

  const patchJsonPath = `${resolvedPath}.patch.json`;
  let buf;
  try {
    buf = fs.readFileSync(resolvedPath);
  } catch (error) {
    return {
      ok: false,
      status: "error",
      patchable: false,
      path: resolvedPath,
      patchJsonPath,
      reason: "read-failed",
      message: error?.message || String(error),
    };
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const timeAfterOffset = findUniqueOffset(buf, AGY_TIME_AFTER_SIG);
  if (timeAfterOffset < 0) {
    return {
      ok: false,
      status: "unsupported",
      patchable: false,
      path: resolvedPath,
      patchJsonPath,
      sha256,
      reason:
        timeAfterOffset === -2
          ? "ambiguous-time-after-signature"
          : "time-after-signature-not-found",
    };
  }

  const patchedOffset = findUniqueOffset(buf, AGY_PEER_WAKE_PATCH_PREFIX);
  if (
    patchedOffset >= 0 &&
    patchedOffset + AGY_PEER_WAKE_STP_DELTA + 4 <= buf.length
  ) {
    const expectedBl = encodeArm64Bl(
      patchedOffset + AGY_PEER_WAKE_PATCH_PREFIX.length,
      timeAfterOffset,
    );
    const actualBl = buf.subarray(
      patchedOffset + AGY_PEER_WAKE_PATCH_PREFIX.length,
      patchedOffset + AGY_PEER_WAKE_PATCH_PREFIX.length + 4,
    );
    const actualStp = buf.subarray(
      patchedOffset + AGY_PEER_WAKE_STP_DELTA,
      patchedOffset + AGY_PEER_WAKE_STP_DELTA + 4,
    );
    if (
      expectedBl &&
      actualBl.equals(expectedBl) &&
      actualStp.equals(AGY_PEER_WAKE_PATCH_STP)
    ) {
      let metadataOk = false;
      if (fs.existsSync(patchJsonPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(patchJsonPath, "utf8"));
          metadataOk =
            meta?.sha256 === sha256 &&
            Array.isArray(meta?.patches) &&
            meta.patches.includes("peer-wake");
        } catch {
          metadataOk = false;
        }
      }
      if (metadataOk) {
        return {
          ok: true,
          status: "patched",
          patchable: false,
          binaryPatched: true,
          path: resolvedPath,
          patchJsonPath,
          sha256,
          callOffset: patchedOffset,
          timeAfterOffset,
        };
      }
      return {
        ok: false,
        status: "metadata-outdated",
        patchable: true,
        binaryPatched: true,
        path: resolvedPath,
        patchJsonPath,
        sha256,
        callOffset: patchedOffset,
        timeAfterOffset,
        fix: "tfx doctor --fix",
      };
    }
  }

  const origOffset = findUniqueOffset(buf, AGY_PEER_WAKE_ORIG_CALL);
  if (
    origOffset >= 0 &&
    origOffset + AGY_PEER_WAKE_STP_DELTA + 4 <= buf.length
  ) {
    const expectedBl = encodeArm64Bl(
      origOffset + AGY_PEER_WAKE_PATCH_PREFIX.length,
      timeAfterOffset,
    );
    const actualStp = buf.subarray(
      origOffset + AGY_PEER_WAKE_STP_DELTA,
      origOffset + AGY_PEER_WAKE_STP_DELTA + 4,
    );
    if (expectedBl && actualStp.equals(AGY_PEER_WAKE_ORIG_STP)) {
      return {
        ok: false,
        status: "unpatched",
        patchable: true,
        binaryPatched: false,
        path: resolvedPath,
        patchJsonPath,
        sha256,
        callOffset: origOffset,
        timeAfterOffset,
        fix: "tfx doctor --fix",
      };
    }
  }

  return {
    ok: false,
    status: "unsupported",
    patchable: false,
    path: resolvedPath,
    patchJsonPath,
    sha256,
    reason:
      origOffset === -2
        ? "ambiguous-call-site-signature"
        : "call-site-signature-not-found",
  };
}

export function applyAgyPeerWakePatch({
  agyPath,
  version,
  platform = process.platform,
  arch = process.arch,
  fs = defaultFs,
  execFileSyncFn = execFileSync,
} = {}) {
  const state = inspectAgyPeerWakePatch({ agyPath, platform, arch, fs });
  if (state.status === "patched" || state.status === "skipped") {
    return { ...state, changed: false };
  }
  if (!state.patchable) {
    return { ...state, ok: false, changed: false };
  }

  let resolvedVersion = version || "";
  if (!resolvedVersion) {
    try {
      const out = String(
        execFileSyncFn(state.path, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }) || "",
      );
      resolvedVersion = out.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || "unknown";
    } catch {
      resolvedVersion = "unknown";
    }
  }

  let finalSha256 = state.sha256;
  let backupEntry = null;
  if (state.status === "unpatched") {
    const rawBuf = fs.readFileSync(state.path);
    const currentSha256 = createHash("sha256").update(rawBuf).digest("hex");
    if (currentSha256 !== state.sha256) {
      throw new Error("agy binary changed during patch preparation");
    }

    let backupKey = `${resolvedVersion}-orig`;
    let backupPath = `${state.path}.bak-${backupKey}`;
    if (fs.existsSync(backupPath)) {
      const existingBackupSha = createHash("sha256")
        .update(fs.readFileSync(backupPath))
        .digest("hex");
      if (existingBackupSha !== state.sha256) {
        backupKey = `${resolvedVersion}-orig-${state.sha256.slice(0, 8)}`;
        backupPath = `${state.path}.bak-${backupKey}`;
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(state.path, backupPath);
        }
      }
    } else {
      fs.copyFileSync(state.path, backupPath);
    }
    backupEntry = { key: backupKey, path: backupPath, sha256: state.sha256 };

    const buf = Buffer.from(rawBuf);
    const expectedBl = encodeArm64Bl(
      state.callOffset + AGY_PEER_WAKE_PATCH_PREFIX.length,
      state.timeAfterOffset,
    );
    AGY_PEER_WAKE_PATCH_PREFIX.copy(buf, state.callOffset);
    expectedBl.copy(buf, state.callOffset + AGY_PEER_WAKE_PATCH_PREFIX.length);
    AGY_PEER_WAKE_PATCH_STP.copy(
      buf,
      state.callOffset + AGY_PEER_WAKE_STP_DELTA,
    );

    const tmpPath = `${state.path}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, buf, { mode: 0o755 });
    try {
      fs.chmodSync(tmpPath, 0o755);
      execFileSyncFn("codesign", ["-f", "-s", "-", tmpPath], {
        stdio: "ignore",
        timeout: 30000,
      });
      const preRenameSha256 = createHash("sha256")
        .update(fs.readFileSync(state.path))
        .digest("hex");
      if (preRenameSha256 !== state.sha256) {
        throw new Error("agy binary changed before atomic replace");
      }
      fs.renameSync(tmpPath, state.path);
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      throw error;
    }
    finalSha256 = createHash("sha256")
      .update(fs.readFileSync(state.path))
      .digest("hex");
  }

  let existingMeta = {};
  if (fs.existsSync(state.patchJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(state.patchJsonPath, "utf8"));
      existingMeta =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {
      existingMeta = {};
    }
  }
  const patches = Array.isArray(existingMeta.patches)
    ? [...new Set([...existingMeta.patches, "peer-wake"])]
    : ["peer-wake"];
  const backups = {
    ...(backupEntry
      ? {
          [backupEntry.key]: {
            path: backupEntry.path,
            sha256: backupEntry.sha256,
          },
        }
      : {}),
    ...(existingMeta.backups && typeof existingMeta.backups === "object"
      ? existingMeta.backups
      : {}),
  };
  const nextMeta = {
    ...existingMeta,
    version:
      resolvedVersion !== "unknown"
        ? resolvedVersion
        : existingMeta.version || "unknown",
    sha256: finalSha256,
    patches,
    appliedAt: new Date().toISOString(),
    backups,
  };
  fs.writeFileSync(
    state.patchJsonPath,
    `${JSON.stringify(nextMeta, null, 2)}\n`,
    "utf8",
  );

  return {
    ok: true,
    status: "patched",
    changed: true,
    binaryPatched: true,
    previousStatus: state.status,
    path: state.path,
    patchJsonPath: state.patchJsonPath,
    sha256: finalSha256,
  };
}

export function commandExists(name) {
  try {
    execFileSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name], {
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export function inspectMacTimeoutDependency({
  platform = process.platform,
  commandExists: exists = commandExists,
} = {}) {
  if (platform !== "darwin") {
    return { ok: true, status: "skipped", platform };
  }

  if (exists("gtimeout")) {
    return { ok: true, status: "ok", platform, provider: "gtimeout" };
  }
  if (exists("timeout")) {
    return { ok: true, status: "ok", platform, provider: "timeout" };
  }

  return {
    ok: false,
    status: "missing",
    platform,
    fix: "brew install coreutils",
  };
}
