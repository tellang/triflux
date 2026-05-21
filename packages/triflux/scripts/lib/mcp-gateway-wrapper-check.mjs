import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function checkWrapperSourcing({
  wrapperPath = path.join(os.homedir(), ".local", "bin", "mcp-gateway-wrapper.sh"),
  marker = "secrets.env",
} = {}) {
  let text;
  try {
    text = await readFile(wrapperPath, "utf8");
  } catch (error) {
    const result = { status: "missing", wrapperPath };
    if (error?.code !== "ENOENT") {
      result.message = `wrapper read failed: ${error?.message || String(error)}`;
    }
    return result;
  }

  if (text.includes(marker)) {
    return { status: "ok", wrapperPath };
  }

  return {
    status: "warn",
    wrapperPath,
    message: "wrapper exists but does not source secrets.env",
    suggestedFix: "Re-run: node scripts/install-mcp-gateway-startup.mjs",
  };
}
