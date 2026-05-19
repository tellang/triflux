# Shard A — staged-file-detect helper + 단위 테스트

> Index: [issue-281-auto-router-swarm-dispatch.md](./issue-281-auto-router-swarm-dispatch.md)
> Worktree branch: `feat/issue-281-shard-a-staged-file-detect`
> CLI: Codex (default per `.claude/rules/tfx-routing.md`)
> 의존: 없음 (가장 먼저 진입)

## 신규 파일 1: `hub/lib/staged-file-detect.mjs`

```javascript
import { execFileSync } from 'node:child_process';

/**
 * Detect code change files via git in cwd.
 * Counts staged + unstaged + untracked separately and deduplicates.
 * Gracefully returns 0 counts when cwd is not a git repo or git fails.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - working directory (default: process.cwd())
 * @param {boolean} [opts.includeStaged=true]
 * @param {boolean} [opts.includeUnstaged=true]
 * @param {boolean} [opts.includeUntracked=true]
 * @returns {{
 *   stagedCount: number,
 *   unstagedCount: number,
 *   untrackedCount: number,
 *   totalChanged: number,
 *   files: string[]
 * }}
 */
export function detectChangedFiles({
  cwd = process.cwd(),
  includeStaged = true,
  includeUnstaged = true,
  includeUntracked = true,
} = {}) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const staged = includeStaged ? run(['diff', '--cached', '--name-only']) : [];
  const unstaged = includeUnstaged ? run(['diff', '--name-only']) : [];
  const untracked = includeUntracked ? run(['ls-files', '--others', '--exclude-standard']) : [];
  const all = [...new Set([...staged, ...unstaged, ...untracked])];
  return {
    stagedCount: staged.length,
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    totalChanged: all.length,
    files: all,
  };
}

/**
 * Convenience: true when any tracked or untracked file changed in cwd.
 */
export function hasCodeChange(opts) {
  return detectChangedFiles(opts).totalChanged > 0;
}
```

## 신규 파일 2: `tests/unit/staged-file-detect.test.mjs`

테스트 케이스 (각 case 는 mkdtemp + git init 으로 격리):

1. **empty clean repo** → `totalChanged === 0`
2. **staged file 1개** (write + `git add`) → `stagedCount === 1`, `totalChanged === 1`
3. **unstaged + untracked 혼합** (tracked 파일 modify + new file) → `unstagedCount ≥ 1`, `untrackedCount ≥ 1`, `totalChanged === stagedCount + unstagedCount + untrackedCount` (중복 없을 때)
4. **non-git cwd** (`/tmp` plain dir) → `totalChanged === 0` (graceful)
5. **includeStaged: false** → staged 항목 카운트 제외
6. **중복 파일** (같은 파일을 stage 후 또 modify) → 1번만 카운트 (Set 중복 제거)

테스트 프레임워크: vitest (다른 `tests/unit/*.test.mjs` 참조)

## 4-layer mirror (`.claude/rules/tfx-mirror-policy.md`)

| 파일 | mirror 위치 | 방식 |
|------|------------|------|
| `hub/lib/staged-file-detect.mjs` | `packages/core/hub/lib/staged-file-detect.mjs` | byte-identical cp |
| `hub/lib/staged-file-detect.mjs` | `packages/triflux/hub/lib/staged-file-detect.mjs` | byte-identical cp |
| `tests/unit/staged-file-detect.test.mjs` | mirror 제외 (tests/ npm files 미포함) | — |

검증:
```bash
diff -q hub/lib/staged-file-detect.mjs packages/core/hub/lib/staged-file-detect.mjs
diff -q hub/lib/staged-file-detect.mjs packages/triflux/hub/lib/staged-file-detect.mjs
```

## Acceptance

- [ ] `detectChangedFiles()` + `hasCodeChange()` 두 함수 export
- [ ] 단위 테스트 6 case 통과 (`npm test -- staged-file-detect`)
- [ ] packages/core + packages/triflux mirror byte-identical (diff -q exit 0)
- [ ] non-git cwd 에서 graceful (throw 없음)
- [ ] lint clean (`npm run lint`)

## 안티패턴 회피

- `git status --porcelain` 사용 금지 — staged/unstaged/untracked 구분이 모호 (XY 코드 파싱 필요)
- 동기 execFileSync 사용 (router 진입점에서 호출, async overhead 회피)
- shell injection 방지 — execFileSync(args[]) 형식 사용 (execSync(string) 금지)
