import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let treeKill = null;
try {
  treeKill = require("tree-kill");
} catch {
  treeKill = null;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillTree(pid) {
  return new Promise((resolve) => {
    if (treeKill) {
      treeKill(pid, "SIGTERM", () => resolve());
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
    resolve();
  });
}

export class PidTracker {
  constructor(path, options = {}) {
    this.path = path;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.killTree = options.killTree ?? defaultKillTree;
  }

  track(pid) {
    if (!pid) return;
    appendFileSync(this.path, `${pid}\n`);
  }

  list() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  async cleanup() {
    for (const pid of this.list()) {
      if (!this.isAlive(pid)) continue;
      await this.killTree(pid);
    }
    rmSync(this.path, { force: true });
  }
}
