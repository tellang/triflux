// cto/lake-root.mjs - resolve the git repo toplevel for the CTO lake.
//
// CTO lake (.triflux/lake/current.json) 는 repo 루트에 하나만 둔다. 그런데
// runStatus/runCollect/runDashboard 는 process.cwd() 를 기본 rootDir 로 쓰므로,
// repo 루트가 아닌 하위 폴더(예: packages/triflux)에서 `tfx cto` 를 부르면 lake
// 를 못 찾아 "run tfx cto collect" 가 반복되고, collect 는 엉뚱한 하위 폴더에
// 새 .triflux/lake 를 만든다. cwd 에서 `.git` 마커를 위로 탐색해 toplevel 로
// 올려 이 불일치를 없앤다.
//
// git worktree 는 자체 `.git` 파일을 가지므로 worktree 루트에서 멈춘다 — lake
// 격리(워크트리별 collect)가 그대로 유지된다. `.git` 을 못 찾으면 cwd 를 그대로
// 반환해 기존 동작을 보존한다.

import { existsSync as defaultExistsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

const MAX_DEPTH = 64;

/**
 * cwd 에서 가장 가까운 git toplevel(`.git` 디렉토리 또는 파일이 있는 폴더)을
 * 찾아 반환한다. 못 찾으면 cwd 를 그대로 돌려준다(기존 동작 보존).
 *
 * @param {string} cwd 시작 디렉토리(보통 process.cwd())
 * @param {object} [opts]
 * @param {(path: string) => boolean} [opts.existsSync] 테스트용 주입 seam
 * @returns {string}
 */
export function resolveLakeRootDir(cwd, opts = {}) {
  const exists = opts?.existsSync || defaultExistsSync;
  // 비문자열(객체/숫자 등 truthy 포함) 또는 빈 문자열이면 항상 "" 를 반환해
  // @returns {string} 계약을 지킨다 — truthy 비문자열을 그대로 누설하지 않는다.
  if (typeof cwd !== "string" || !cwd) return "";

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
