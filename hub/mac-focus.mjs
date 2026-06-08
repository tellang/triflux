import { exec } from "node:child_process";

export function focusSessionOnMac(sessionId, udsId) {
  // A simple AppleScript to activate iTerm
  // In a real scenario, this would iterate windows/tabs to find the matching session.
  // For this minimal version, we simply activate iTerm.
  const script = `
    tell application "iTerm"
      activate
    end tell
  `;
  exec(`osascript -e '${script}'`, (err) => {
    if (err) console.error("mac-focus error:", err);
  });
}
