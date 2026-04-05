import { execFileSync } from "node:child_process";

export const PSMUX_RECOMMENDED_VERSION = "3.3.1";
export const PSMUX_REQUIRED_COMMANDS = [
  "new-session",
  "attach-session",
  "kill-session",
  "capture-pane",
];

export const PSMUX_OPTIONAL_COMMANDS = [
  "detach-client",
];

export const PSMUX_INSTALL_COMMANDS = [
  "winget install marlocarlo.psmux",
  "scoop install psmux",
  "choco install psmux",
  "cargo install psmux",
];

export const PSMUX_UPDATE_COMMANDS = [
  "winget upgrade marlocarlo.psmux",
  "scoop update psmux",
  "choco upgrade psmux",
  "cargo install psmux --force",
];

export function formatPsmuxCommandList(commands = PSMUX_INSTALL_COMMANDS, indent = "") {
  return commands.map((command) => `${indent}${command}`).join("\n");
}

export function formatPsmuxInstallGuidance(indent = "") {
  return formatPsmuxCommandList(PSMUX_INSTALL_COMMANDS, indent);
}

export function formatPsmuxUpdateGuidance(indent = "") {
  return formatPsmuxCommandList(PSMUX_UPDATE_COMMANDS, indent);
}

export function parsePsmuxVersion(output = "") {
  const match = String(output).match(/psmux\s+v?(\d+\.\d+\.\d+)/i);
  return match?.[1] || null;
}

export function compareSemver(a, b) {
  const left = String(a || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
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
      (command) => !helpOutput || !helpOutput.includes(command),
    );
    const missingOptionalCommands = PSMUX_OPTIONAL_COMMANDS.filter(
      (command) => !helpOutput || !helpOutput.includes(command),
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
      installHint: formatPsmuxInstallGuidance("  "),
      updateHint: formatPsmuxUpdateGuidance("  "),
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
      installHint: formatPsmuxInstallGuidance("  "),
      updateHint: formatPsmuxUpdateGuidance("  "),
    };
  }
}
