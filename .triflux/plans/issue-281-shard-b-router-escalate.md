# Shard B — router auto-escalate 로직

> Index: [issue-281-auto-router-swarm-dispatch.md](./issue-281-auto-router-swarm-dispatch.md)
> Worktree branch: `feat/issue-281-shard-b-router-escalate`
> CLI: Codex
> 의존: Shard A 의 `hub/lib/staged-file-detect.mjs` (import)

## 진입 전 grep 필수

shard 진입 첫 행위 — 기존 인자 파싱 구조 확인:

```bash
grep -n "parallel\|isolation\|tasks" hub/lib/tfx-route-args.mjs | head -30
grep -n "tfx-auto\|--parallel\|dispatch" bin/triflux.mjs | head -30
grep -n "auto_reroute\|auto)" scripts/tfx-route.sh | head -20
```

## 수정 파일 1: `hub/lib/tfx-route-args.mjs`

신규 함수 `decideDispatchMode(args, opts)` 추가:

```javascript
import { hasCodeChange } from './staged-file-detect.mjs';

/**
 * Decide dispatch mode based on parsed args + cwd git state.
 *
 * Issue #281 — auto router 코드 변경 자동 swarm dispatch.
 *
 * @param {object} args - parseRouteArgs() result (existing shape)
 *   - tasks: string[] (or count)
 *   - parallel: number | 'swarm' | null
 *   - isolation: 'worktree' | null
 *   - cli: 'codex' | 'claude' | 'gemini' | null
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Function} [opts.detector] - injectable hasCodeChange (test seam)
 * @returns {{
 *   mode: 'single' | 'multi' | 'swarm',
 *   escalated: boolean,
 *   warning: string | null,
 *   reason: string,
 * }}
 */
export function decideDispatchMode(args, { cwd = process.cwd(), detector = hasCodeChange } = {}) {
  const tasksCount = Array.isArray(args.tasks) ? args.tasks.length : (args.tasks ?? 0);
  const hasUserParallel = args.parallel != null && args.parallel !== 'swarm';
  const hasUserSwarm = args.parallel === 'swarm' || args.isolation === 'worktree';
  const codeChanged = detector({ cwd });

  // 사용자 명시 swarm → 그대로
  if (hasUserSwarm) {
    return { mode: 'swarm', escalated: false, warning: null, reason: 'user-explicit-swarm' };
  }

  // case 3: 사용자 --parallel N 명시 + 코드 변경 → warning + 사용자 결정 존중
  if (hasUserParallel && codeChanged) {
    return {
      mode: 'multi',
      escalated: false,
      warning: `[tfx-auto] WARNING: 코드 변경 감지 (cwd race 위험). --parallel swarm --isolation worktree 권장. 사용자 명시 --parallel=${args.parallel} 존중하여 multi 로 진행.`,
      reason: 'user-explicit-multi-with-code-change',
    };
  }

  // case 2: 2+ 태스크 + 코드 변경 → swarm 자동 escalate
  if (tasksCount >= 2 && codeChanged) {
    return {
      mode: 'swarm',
      escalated: true,
      warning: `[tfx-auto] 코드 변경 ${tasksCount}건 태스크 + dirty cwd 감지. swarm dispatch 자동 escalate (--parallel swarm --isolation worktree). Issue #281.`,
      reason: 'auto-escalate-code-change',
    };
  }

  // case 1: 2+ 태스크 + 코드 변경 0건 → multi
  if (tasksCount >= 2 || hasUserParallel) {
    return { mode: 'multi', escalated: false, warning: null, reason: 'multi-no-code-change' };
  }

  // 1 task → single
  return { mode: 'single', escalated: false, warning: null, reason: 'single-task' };
}
```

기존 `parseRouteArgs()` 와 export 충돌 없는지 확인 후 추가.

## 수정 파일 2: `bin/triflux.mjs`

tfx-auto dispatch 분기 (정확 위치는 진입 후 grep `tfx-auto` 로 확인):

```javascript
import { decideDispatchMode } from '../hub/lib/tfx-route-args.mjs';

// 기존 dispatch 분기 직전에 추가:
const decision = decideDispatchMode(parsedArgs);
if (decision.warning) {
  process.stderr.write(`${decision.warning}\n`);
}
if (decision.escalated) {
  // telemetry: .omc/state/auto-escalation.log append
  const logLine = JSON.stringify({
    at: new Date().toISOString(),
    issue: 281,
    from: 'multi',
    to: 'swarm',
    tasksCount: parsedArgs.tasks?.length,
    reason: decision.reason,
  }) + '\n';
  try {
    await fs.promises.appendFile('.omc/state/auto-escalation.log', logLine);
  } catch { /* dir may not exist on fresh checkout; ignore */ }
}
// dispatch by decision.mode → single | multi | swarm
```

## 수정 파일 3: `scripts/tfx-route.sh`

shell layer 의 `auto)` 분기 (L1209 근처) 와 `auto_reroute()` (L789 근처) 도 일관성 유지. node entry (`bin/triflux.mjs`) 가 최종 decision 을 내리므로 shell layer 는 인자 normalize 만 담당하고 escalation 은 JS 에 위임 (single source of truth).

추가 변경: `auto)` 분기 docstring 갱신 — "Issue #281: auto router 가 코드 변경 감지 후 swarm escalate. shell layer 는 transparent passthrough."

## 단위 테스트 확장: `tests/unit/tfx-route-args.test.mjs`

`decideDispatchMode` 5 case (injectable detector 로 외부 git 의존 격리):

```javascript
import { decideDispatchMode } from '../../hub/lib/tfx-route-args.mjs';

const noChange = () => false;
const withChange = () => true;

test('case 0: 1 task → single', () => {
  expect(decideDispatchMode({ tasks: ['t1'] }, { detector: noChange }).mode).toBe('single');
});

test('case 1: 2+ tasks + 코드 변경 0건 → multi', () => {
  const r = decideDispatchMode({ tasks: ['t1', 't2'] }, { detector: noChange });
  expect(r.mode).toBe('multi');
  expect(r.escalated).toBe(false);
});

test('case 2: 2+ tasks + 코드 변경 → swarm auto-escalate', () => {
  const r = decideDispatchMode({ tasks: ['t1', 't2'] }, { detector: withChange });
  expect(r.mode).toBe('swarm');
  expect(r.escalated).toBe(true);
  expect(r.warning).toMatch(/자동 escalate/);
});

test('case 3: --parallel N 명시 + 코드 변경 → multi + warning', () => {
  const r = decideDispatchMode({ tasks: ['t1', 't2'], parallel: 3 }, { detector: withChange });
  expect(r.mode).toBe('multi');
  expect(r.escalated).toBe(false);
  expect(r.warning).toMatch(/WARNING: 코드 변경/);
});

test('user-explicit swarm 그대로', () => {
  const r = decideDispatchMode({ tasks: ['t1', 't2'], parallel: 'swarm', isolation: 'worktree' }, { detector: withChange });
  expect(r.mode).toBe('swarm');
  expect(r.escalated).toBe(false);
});
```

## 4-layer mirror

| 파일 | mirror 위치 | 방식 |
|------|------------|------|
| `hub/lib/tfx-route-args.mjs` | `packages/core/hub/lib/`, `packages/triflux/hub/lib/` | byte-identical cp |
| `bin/triflux.mjs` | `packages/triflux/bin/` | byte-identical cp |
| `scripts/tfx-route.sh` | `packages/triflux/scripts/` | byte-identical cp |
| `tests/unit/tfx-route-args.test.mjs` | mirror 제외 | — |

검증:
```bash
for f in hub/lib/tfx-route-args.mjs bin/triflux.mjs scripts/tfx-route.sh; do
  diff -q "$f" "packages/triflux/$f" || echo "DRIFT: $f"
done
diff -q hub/lib/tfx-route-args.mjs packages/core/hub/lib/tfx-route-args.mjs
```

## Acceptance

- [ ] `decideDispatchMode` 함수 export + 5 case 단위 테스트 통과
- [ ] tfx-auto 진입 시 warning 메시지 stderr 출력
- [ ] escalation 발생 시 `.omc/state/auto-escalation.log` append (디렉토리 없으면 graceful skip)
- [ ] shell layer `auto)` 분기 docstring 갱신
- [ ] 4-layer mirror byte-identical
- [ ] lint clean

## 안티패턴 회피

- shell layer 에서 git 호출 금지 (JS layer 가 single source of truth)
- decideDispatchMode 가 process.exit 호출 금지 (caller 가 dispatch 책임)
- warning 메시지는 stderr 만 (stdout 은 dispatch 결과 전용)
