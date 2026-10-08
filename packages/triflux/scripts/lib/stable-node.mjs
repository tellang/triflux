import { realpathSync } from "node:fs";
import { join } from "node:path";

// process.execPath 는 Homebrew 의 bin/node 링크를 따라가 버전이 박힌 Cellar 경로가 된다.
// 그 경로는 brew upgrade node 뒤 사라지므로, 같은 바이너리를 가리키는 bin/node 별칭이 있으면 그쪽을 쓴다.
// 그 밖(nvm, volta, 시스템 node, Windows)은 fallback 을 쓴다. 기본은 execPath 이고,
// 오래 남는 명령(HUD statusLine)은 버전이 박힌 경로 대신 "node" 를 넘겨 PATH 에 맡긴다.
export function resolveStableNodeBin(execPath = process.execPath, opts = {}) {
  const env = opts.env || process.env;
  const realpath = opts.realpath || realpathSync;
  const fallback = opts.fallback ?? execPath;
  const candidates = [];
  if (env.HOMEBREW_PREFIX)
    candidates.push(join(env.HOMEBREW_PREFIX, "bin", "node"));
  candidates.push(
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/home/linuxbrew/.linuxbrew/bin/node",
  );
  let target;
  try {
    target = realpath(execPath);
  } catch {
    return fallback;
  }
  for (const candidate of candidates) {
    if (candidate === execPath) return execPath;
    try {
      if (realpath(candidate) === target) return candidate;
    } catch {
      // 이 기기에 없는 후보
    }
  }
  return fallback;
}
