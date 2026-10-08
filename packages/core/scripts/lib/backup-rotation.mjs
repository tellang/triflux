import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// 설정이 바뀔 때마다 백업이 쌓여 끝없이 늘었다. 같은 대상의 백업은 최근 몇 개만 남긴다.
export const BACKUP_KEEP = 5;

// 시각 suffix 만 받는다. label 이 더 긴 다른 백업(예: <label>-manual-...)은 남긴다.
const STAMP_SUFFIX = /^[\dT]+(?:-\d+)*$/i;

// 읽는 사이 다른 프로세스가 지웠으면 같은 것으로 보고 아래에서 다시 쓴다. 다른 읽기 오류는 그대로 던진다.
function sameContent(path, content) {
  try {
    return readFileSync(path, "utf8") === content;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

// `<파일>.<label>-<시각>` 으로 백업하고, 같은 label 의 오래된 백업을 지운다.
export function writeRotatedBackup(
  path,
  content,
  { label, suffix, mode, keep = BACKUP_KEEP },
) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.${label}-`;
  // 같은 시각 이름에 다른 원문이 이미 있으면 번호를 붙여 따로 남긴다.
  let backupPath = join(directory, `${prefix}${suffix}`);
  for (let i = 1; existsSync(backupPath); i++) {
    if (sameContent(backupPath, content)) break;
    backupPath = join(directory, `${prefix}${suffix}-${i}`);
  }
  if (!existsSync(backupPath))
    writeFileSync(backupPath, content, { encoding: "utf8", mode });
  const backups = readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith(prefix) && STAMP_SUFFIX.test(name.slice(prefix.length)),
    )
    .flatMap((name) => {
      // 다른 프로세스가 같은 백업을 먼저 지웠을 수 있다.
      try {
        return [{ name, mtime: statSync(join(directory, name)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const { name } of backups.slice(keep))
    rmSync(join(directory, name), { force: true });
  return backupPath;
}
