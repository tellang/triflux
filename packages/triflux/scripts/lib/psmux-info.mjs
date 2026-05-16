import { execFileSync } from "node:child_process";

export const PSMUX_RECOMMENDED_VERSION = "3.3.1";
export const PSMUX_REQUIRED_COMMANDS = [
  "new-session",
  "attach-session",
  "kill-session",
  "capture-pane",
];

export const PSMUX_OPTIONAL_COMMANDS = ["detach-client"];

// Windows 패키지 매니저 — winget/scoop/choco 는 Windows 전용
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

// macOS 전용 — brew 가 표준, cargo 는 cross-platform fallback
export const PSMUX_INSTALL_COMMANDS_DARWIN = [
  "brew install psmux",
  "cargo install psmux",
];

export const PSMUX_UPDATE_COMMANDS_DARWIN = [
  "brew upgrade psmux",
  "cargo install psmux --force",
];

// Linux 전용 — cargo 만 cross-platform 지원, distro 패키지는 미제공
export const PSMUX_INSTALL_COMMANDS_LINUX = ["cargo install psmux"];

export const PSMUX_UPDATE_COMMANDS_LINUX = ["cargo install psmux --force"];

// PR #258 OS-primary 분기 정책: macOS/Linux 는 tmux 가 POSIX 표준 primary,
// psmux 는 선택형. native teams fallback (tmux 또는 child process spawn) 으로 동작 가능.
export const PSMUX_FALLBACK_NOTE_DARWIN =
  "macOS 에서는 tmux 가 표준 멀티플렉서이며, " +
  "triflux 는 psmux 없이도 native teams fallback 으로 멀티모델 병렬 실행을 지원합니다.";

export const PSMUX_FALLBACK_NOTE_LINUX =
  "Linux 에서는 tmux 가 표준 멀티플렉서이며, " +
  "triflux 는 psmux 없이도 native teams fallback 으로 멀티모델 병렬 실행을 지원합니다.";

export function getPsmuxInstallCommandsFor(platform = process.platform) {
  if (platform === "darwin") return PSMUX_INSTALL_COMMANDS_DARWIN;
  if (platform === "linux") return PSMUX_INSTALL_COMMANDS_LINUX;
  // win32 또는 기타 (BSD 등) → Windows 풀 리스트로 폴백 (변경 전 동작 유지)
  return PSMUX_INSTALL_COMMANDS;
}

export function getPsmuxUpdateCommandsFor(platform = process.platform) {
  if (platform === "darwin") return PSMUX_UPDATE_COMMANDS_DARWIN;
  if (platform === "linux") return PSMUX_UPDATE_COMMANDS_LINUX;
  return PSMUX_UPDATE_COMMANDS;
}

export function getPsmuxFallbackNoteFor(platform = process.platform) {
  if (platform === "darwin") return PSMUX_FALLBACK_NOTE_DARWIN;
  if (platform === "linux") return PSMUX_FALLBACK_NOTE_LINUX;
  return null;
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
  const commands = getPsmuxInstallCommandsFor(platform);
  const list = formatPsmuxCommandList(commands, indent);
  const note = getPsmuxFallbackNoteFor(platform);
  return note ? `${list}\n${indent}(${note})` : list;
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
