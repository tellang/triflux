const fs = require("fs");
const { syncBuiltinESMExports } = require("module");

const originalWriteFileSync = fs.writeFileSync;

function isCodexConfigPath(targetPath) {
  return typeof targetPath === "string"
    && targetPath.replace(/\\/g, "/").endsWith("/.codex/config.toml");
}

fs.writeFileSync = function patchedWriteFileSync(targetPath, ...args) {
  if (isCodexConfigPath(targetPath)) {
    throw "undefined";
  }
  return originalWriteFileSync.call(this, targetPath, ...args);
};

syncBuiltinESMExports();
