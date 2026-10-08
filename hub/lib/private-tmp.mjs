import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 공용 /tmp 의 고정 이름은 다른 사용자가 먼저 만들거나 읽을 수 있다.
// uid 를 넣은 0700 루트를 쓰고, 남의 것이거나 링크면 쓰지 않는다.
// Windows 는 TEMP 가 이미 사용자별이라 그대로 쓴다.
// scripts/tfx-route.sh 의 resolve_tmp_dir 가 같은 규칙을 셸로 따른다.
export function privateTmpRoot({
  base = tmpdir(),
  uid = process.getuid?.(),
} = {}) {
  if (uid === undefined) return base;
  return ensureOwnedDir(join(base, `triflux-${uid}`), uid);
}

// 루트가 예전에 느슨했다면 그 사이 남이 하위에 링크를 심었을 수 있어 하위도 같은 검사를 한다.
export function privateTmpDir(name, { base, uid = process.getuid?.() } = {}) {
  const dir = join(privateTmpRoot({ base, uid }), name);
  if (uid === undefined) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return ensureOwnedDir(dir, uid);
}

function ensureOwnedDir(dir, uid) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid) {
    throw new Error(`unsafe temp dir (not owned by uid ${uid}): ${dir}`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}
