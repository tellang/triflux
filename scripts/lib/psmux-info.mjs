import { execFileSync } from "node:child_process";

export const PSMUX_RECOMMENDED_VERSION = "3.3.1";
export const PSMUX_REQUIRED_COMMANDS = [
  "new-session",
  "attach-session",
  "kill-session",
  "capture-pane",
];

export const PSMUX_OPTIONAL_COMMANDS = ["detach-client"];

// Windows 전용 설치 명령
export const PSMUX_INSTALL_COMMANDS = [
  "winget install psmux",
  "scoop install psmux",
  "choco install psmux",
  "cargo install psmux",
];

export const PSMUX_UPDATE_COMMANDS = [
  "winget upgrade psmux",
  "scoop update psmux",
  "choco upgrade psmux",
  "cargo install psmux --force",
];

export function getPsmuxInstallCommandsFor(platform = process.platform) {
  if (platform === "win32") return PSMUX_INSTALL_COMMANDS;
  return [platform === "darwin" ? "brew install tmux" : "apt install tmux"];
}

export function getPsmuxUpdateCommandsFor(platform = process.platform) {
  if (platform === "win32") return PSMUX_UPDATE_COMMANDS;
  return [
    platform === "darwin"
      ? "brew upgrade tmux"
      : "apt install --only-upgrade tmux",
  ];
}

export function formatPsmuxCommandList(
  commands = PSMUX_INSTALL_COMMANDS,
  indent = "",
) {
  return commands.map((command) => `${indent}${command}`).join("\n");
}

export function formatPsmuxInstallGuidance(
  indent = "",
  platform = process.platform,
) {
  return formatPsmuxCommandList(getPsmuxInstallCommandsFor(platform), indent);
}

export function formatPsmuxUpdateGuidance(
  indent = "",
  platform = process.platform,
) {
  return formatPsmuxCommandList(getPsmuxUpdateCommandsFor(platform), indent);
}

export function parsePsmuxVersion(output = "") {
  const match = String(output).match(/psmux\s+v?(\d+\.\d+\.\d+)/i);
  return match?.[1] || null;
}

export function compareSemver(a, b) {
  const left = String(a || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function isRecommendedPsmuxVersion(version) {
  if (!version) return false;
  return compareSemver(version, PSMUX_RECOMMENDED_VERSION) >= 0;
}

export function probePsmuxSupport(options = {}) {
  const execFileSyncFn = options.execFileSyncFn || execFileSync;
  const bin = options.bin || "psmux";

  try {
    const versionOutput = execFileSyncFn(bin, ["-V"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const version = parsePsmuxVersion(versionOutput);

    let helpOutput = "";
    try {
      helpOutput = execFileSyncFn(bin, ["--help"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      helpOutput = "";
    }

    const missingCommands = PSMUX_REQUIRED_COMMANDS.filter(
      (command) => !helpOutput?.includes(command),
    );
    const missingOptionalCommands = PSMUX_OPTIONAL_COMMANDS.filter(
      (command) => !helpOutput?.includes(command),
    );

    return {
      ok: missingCommands.length === 0,
      installed: true,
      version,
      recommendedVersion: PSMUX_RECOMMENDED_VERSION,
      recommended: isRecommendedPsmuxVersion(version),
      missingCommands,
      missingOptionalCommands,
      hasHelp: helpOutput.length > 0,
      installHint: formatPsmuxInstallGuidance("  ", "win32"),
      updateHint: formatPsmuxUpdateGuidance("  ", "win32"),
    };
  } catch {
    return {
      ok: false,
      installed: false,
      version: null,
      recommendedVersion: PSMUX_RECOMMENDED_VERSION,
      recommended: false,
      missingCommands: [...PSMUX_REQUIRED_COMMANDS],
      missingOptionalCommands: [...PSMUX_OPTIONAL_COMMANDS],
      hasHelp: false,
      installHint: formatPsmuxInstallGuidance("  ", "win32"),
      updateHint: formatPsmuxUpdateGuidance("  ", "win32"),
    };
  }
}

export function probePrimaryMultiplexerSupport(options = {}) {
  const platform = options.platform || process.platform;
  const execFileSyncFn = options.execFileSyncFn || execFileSync;

  if (platform === "win32") {
    return {
      kind: "psmux",
      ...probePsmuxSupport(options),
    };
  }

  const bin = options.bin || "tmux";
  try {
    const versionOutput = execFileSyncFn(bin, ["-V"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      ok: true,
      installed: true,
      kind: "tmux",
      version: String(versionOutput || "").trim() || null,
      recommendedVersion: null,
      recommended: true,
      missingCommands: [],
      missingOptionalCommands: [],
      installHint: formatPsmuxInstallGuidance("  ", platform),
      updateHint: formatPsmuxUpdateGuidance("  ", platform),
    };
  } catch (error) {
    return {
      ok: false,
      installed: false,
      kind: "tmux",
      version: null,
      recommendedVersion: null,
      recommended: false,
      missingCommands: ["tmux"],
      missingOptionalCommands: [],
      installHint: formatPsmuxInstallGuidance("  ", platform),
      updateHint: formatPsmuxUpdateGuidance("  ", platform),
      error: error?.message || String(error),
    };
  }
}
