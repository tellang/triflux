import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// 설정이 바뀔 때마다 백업이 쌓여 끝없이 늘었다. 같은 대상의 백업은 최근 몇 개만 남긴다.
export const BACKUP_KEEP = 5;

// `<파일>.<label>-<시각>` 으로 백업하고, 같은 label 의 오래된 백업을 지운다.
export function writeRotatedBackup(
  path,
  content,
  { label, suffix, mode, keep = BACKUP_KEEP },
) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.${label}-`;
  const backupPath = join(directory, `${prefix}${suffix}`);
  if (!existsSync(backupPath))
    writeFileSync(backupPath, content, { encoding: "utf8", mode });
  const backups = readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const { name } of backups.slice(keep))
    rmSync(join(directory, name), { force: true });
  return backupPath;
}
