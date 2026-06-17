// cto/lake-root.mjs - resolve the canonical project root for the CTO lake.
//
// CTO lake (.triflux/lake/current.json) 는 repo 루트에 하나만 둔다. 그런데
// runStatus/runCollect/runDashboard 는 process.cwd() 를 기본 rootDir 로 쓰므로,
// repo 루트가 아닌 하위 폴더(예: packages/triflux)에서 `tfx cto` 를 부르면 lake
// 를 못 찾아 "run tfx cto collect" 가 반복되고, collect 는 엉뚱한 하위 폴더에
// 새 .triflux/lake 를 만든다. cwd 에서 `.git` 마커를 위로 탐색해 toplevel 로
// 올려 이 불일치를 없앤다.
//
// git worktree 는 별도 프로젝트가 아니라 같은 프로젝트의 작업 디렉터리다. 따라서
// linked worktree 안에서 호출하더라도 `git rev-parse --git-common-dir` 로 canonical
// project root(일반적으로 main checkout)를 찾아 같은 CTO lake 를 공유한다. git 명령을
// 사용할 수 없으면 기존의 `.git` 상향 탐색으로 fallback 한다.

import { execFileSync as defaultExecFileSync } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";

const MAX_DEPTH = 64;

function execGit(cwd, args, execFileSync) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

function resolveViaGitCommonDir(cwd, execFileSync) {
  try {
    const commonDir = execGit(
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      execFileSync,
    );
    if (commonDir && basename(commonDir) === ".git") {
      return dirname(commonDir);
    }

    // Bare repos and submodules can have non-`.git` common dirs. In that case,
    // `--show-toplevel` is the safest project root signal.
    const topLevel = execGit(
      cwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      execFileSync,
    );
    return topLevel || null;
  } catch {
    return null;
  }
}

/**
 * cwd 에서 가장 가까운 git toplevel(`.git` 디렉토리 또는 파일이 있는 폴더)을
 * 찾아 반환한다. linked worktree 에서는 worktree 루트가 아니라 git common dir 의
 * project root 를 반환해 프로젝트당 CTO lake 하나를 유지한다. 못 찾으면 cwd 를
 * 그대로 돌려준다(기존 동작 보존).
 *
 * @param {string} cwd 시작 디렉토리(보통 process.cwd())
 * @param {object} [opts]
 * @param {(path: string) => boolean} [opts.existsSync] 테스트용 주입 seam
 * @param {typeof defaultExecFileSync} [opts.execFileSync] 테스트용 git seam
 * @returns {string}
 */
export function resolveLakeRootDir(cwd, opts = {}) {
  const exists = opts?.existsSync || defaultExistsSync;
  const execFileSync = opts?.execFileSync || defaultExecFileSync;
  // 비문자열(객체/숫자 등 truthy 포함) 또는 빈 문자열이면 항상 "" 를 반환해
  // @returns {string} 계약을 지킨다 — truthy 비문자열을 그대로 누설하지 않는다.
  if (typeof cwd !== "string" || !cwd) return "";

  const gitRoot = resolveViaGitCommonDir(cwd, execFileSync);
  if (gitRoot) return gitRoot;

  let dir = cwd;
  const { root } = parse(dir);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (exists(join(dir, ".git"))) return dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
