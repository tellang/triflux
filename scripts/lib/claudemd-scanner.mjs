import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function findAllClaudeMdPaths(options = {}) {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const homeDir = options.homeDir ? resolve(options.homeDir) : homedir();
  const includeGlobal = options.includeGlobal !== false;
  const includeProject = options.includeProject !== false;

  const candidates = [];
  if (includeGlobal) candidates.push(join(homeDir, ".claude", "CLAUDE.md"));
  if (includeProject) candidates.push(join(cwd, "CLAUDE.md"));

  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (existsSync(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}
