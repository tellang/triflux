import { execFileSync } from "node:child_process";

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
