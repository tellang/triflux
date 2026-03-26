import { existsSync } from 'node:fs';

const GIT_BASH_PATHS = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
];

/** Git Bash executable — avoids WSL bash which uses different path format */
export const BASH_EXE = GIT_BASH_PATHS.find(p => existsSync(p)) || 'bash';

/**
 * Convert Windows path to Git Bash (MSYS2) format.
 * C:\Users\foo → /c/Users/foo
 * C:/Users/foo → /c/Users/foo
 * /already/posix → /already/posix (unchanged)
 */
export function toBashPath(p) {
  return p
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
}
