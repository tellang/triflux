# Shard C — integration test + SSOT docs + 4-layer mirror 검증

> Index: [issue-281-auto-router-swarm-dispatch.md](./issue-281-auto-router-swarm-dispatch.md)
> Worktree branch: `feat/issue-281-shard-c-integration-ssot-mirror`
> CLI: Codex
> 의존: Shard A, B 완료 후 통합 검증 (cherry-pick 또는 rebase 로 두 brunch 흡수)

## 신규 파일: `tests/integration/tfx-auto-routing.test.mjs`

Issue #281 회귀 가드 3 case (실제 git repo + decideDispatchMode 통합):

```javascript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideDispatchMode } from '../../hub/lib/tfx-route-args.mjs';

describe('Issue #281 — auto router 코드 변경 자동 swarm dispatch', () => {
  let cwd;

  function setupRepo({ dirty = false }) {
    cwd = mkdtempSync(join(tmpdir(), 'tfx-281-int-'));
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@x'], { cwd });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd });
    writeFileSync(join(cwd, 'seed.txt'), 'seed');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd });
    if (dirty) writeFileSync(join(cwd, 'change.txt'), 'x');
    return cwd;
  }

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = null;
  });

  test('case 1: 코드 변경 0건 + 2+ 태스크 → multi', () => {
    setupRepo({ dirty: false });
    const result = decideDispatchMode({ tasks: ['t1', 't2'] }, { cwd });
    expect(result.mode).toBe('multi');
    expect(result.escalated).toBe(false);
    expect(result.warning).toBeNull();
  });

  test('case 2: 코드 변경 ≥ 1건 + 2+ 태스크 → swarm 자동 escalate', () => {
    setupRepo({ dirty: true });
    const result = decideDispatchMode({ tasks: ['t1', 't2'] }, { cwd });
    expect(result.mode).toBe('swarm');
    expect(result.escalated).toBe(true);
    expect(result.warning).toMatch(/swarm dispatch 자동 escalate/);
    expect(result.warning).toMatch(/Issue #281/);
  });

  test('case 3: --parallel 3 명시 + 코드 변경 → warning + 사용자 결정 존중 (multi)', () => {
    setupRepo({ dirty: true });
    const result = decideDispatchMode({ tasks: ['t1', 't2'], parallel: 3 }, { cwd });
    expect(result.mode).toBe('multi');
    expect(result.escalated).toBe(false);
    expect(result.warning).toMatch(/WARNING: 코드 변경/);
    expect(result.warning).toMatch(/사용자 명시.*존중/);
  });
});
```

## SSOT docs 정식화 톤 갱신

### `.claude/rules/tfx-execution-skill-map.md`

| 라인 | 현재 (드래프트 톤) | 갱신 (정식화 톤) |
|------|------------------|----------------|
| L44 안티패턴 행 | `tfx-auto --parallel 만 명시하고 코드 변경 포함 → Issue #87 미해결 갭으로 multi dispatch + cwd 공유 race` | `tfx-auto --parallel N 명시 + 코드 변경 → warning 후 사용자 결정 존중. swarm 권장이지만 사용자 명시 override 시 multi 진행 (Issue #281 closed).` |
| L48-49 핵심 룰 | `MANDATORY: 코드 변경 포함 병렬은 사용자가 직접 --parallel swarm --isolation worktree 플래그 명시. tfx-auto 자동 swarm dispatch 는 Issue #87 미해결.` | `tfx-auto 는 2+ 태스크 + 코드 변경 자동 감지 시 swarm 으로 escalate (Issue #281 closed). 사용자 명시 --parallel N override 시 warning 후 사용자 결정 존중.` |
| L57-59 알려진 한계 | `현재 tfx-auto 는 2+ 태스크를 만나면 multi 로만 dispatch 한다. 코드 변경 포함 시 자동 swarm dispatch 로직은 Issue #87 (auto 라우터 강화) 에서 추적.` | 섹션 자체 삭제 (또는 "## 해결됨" 으로 변경 후 Issue #87 + #281 close 링크) |

### `.claude/rules/tfx-routing.md`

- L21/L22 ladder 표: 변경 없음 (정책 자체는 동일, dispatch 자동화만 추가)
- L90 Layer 2 예시: `tfx-auto --parallel swarm --mode consensus --isolation worktree` 유지 (사용자 명시 경로는 그대로)
- L130 "충돌 해소" 섹션에 1줄 추가: `tfx-auto 자동 swarm escalate: 2+ 태스크 + 코드 변경 ≥ 1건 시 자동. 명시 --parallel N override 가능 (warning).`

## 4-layer mirror 통합 검증

PR 머지 직전 / Shard C 마무리 시 실행:

```bash
# packages/core mirror 검증 (Shard A + B 산출물)
diff -q hub/lib/staged-file-detect.mjs packages/core/hub/lib/staged-file-detect.mjs
diff -q hub/lib/tfx-route-args.mjs packages/core/hub/lib/tfx-route-args.mjs

# packages/triflux mirror 검증 (root → publish 패키지)
for f in hub/lib/staged-file-detect.mjs hub/lib/tfx-route-args.mjs bin/triflux.mjs scripts/tfx-route.sh; do
  diff -q "$f" "packages/triflux/$f" || echo "DRIFT: $f"
done

# packages/remote 영향 없음 확인 (auto router 는 @triflux/core 의존)
git diff --name-only origin/main..HEAD | grep '^packages/remote/' && echo "FAIL: remote 영향 있음" || echo "OK: remote 무영향"

# tests/ mirror 제외 확인 (npm files 미포함이므로 packages/{core,triflux}/tests/ 에 untracked 신규 디렉토리 금지)
ls packages/core/tests packages/triflux/tests 2>/dev/null && echo "FAIL: tests/ mirror 시도" || echo "OK: tests/ 미러 제외"

# npm pack tarball size (binary 누수 회피)
(cd packages/triflux && npm pack --dry-run 2>&1 | tail -3)
```

기대값 모두 OK + npm pack size ~1MB.

## Acceptance

- [ ] 3 case integration test 통과 (`npm test -- tfx-auto-routing`)
- [ ] SSOT docs L44/L48-49/L57-59 정식화 톤 갱신 (Shard B + A 결과 반영)
- [ ] `.claude/rules/tfx-routing.md` 충돌 해소 섹션 1줄 추가
- [ ] 4-layer mirror 검증 스크립트 출력 모두 OK
- [ ] npm pack size ~1MB
- [ ] cross-review verdict: Claude 작성 코드는 Codex review, Codex 작성 코드는 Claude review

## 안티패턴 회피

- packages/{core,triflux}/tests/ 에 신규 디렉토리 생성 금지 (mirror 제외)
- SSOT 라인 갱신 시 Issue #87 / #281 close 링크 보존
- AI trailer / Co-Authored-By 금지 (release commit + PR body 모두)
