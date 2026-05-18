# Shard 1 — P1 macOS Multiplexer Identity Fix

> Source: [docs/research/macos-process-lifecycle-leak-report-2026-05-18.md](../../docs/research/macos-process-lifecycle-leak-report-2026-05-18.md)
> Cited ranges: §"Multiplexer identity mismatch" (lines 99-134), §"macOS tmux/psmux compatibility regression" (lines 273-326), §"P1 Recommended Fix" (lines 391-408)
> Worktree branch: `fix/macos-lifecycle-s1-mux-identity`

## Problem

`hub/team/session.mjs::detectMultiplexer()` 가 `hasPsmux()` alias 를 literal mux identity 로 변환:

- 보고서 lines 300-311 의 발췌:
  ```
  if (hasPsmux()) {
    _cachedMux = "psmux";
    return _cachedMux;
  }
  if (hasTmux()) {
    _cachedMux = "tmux";
    return _cachedMux;
  }
  ```
- `hasPsmux = hasMultiplexer` 는 psmux.mjs 가 정의한 alias (보고서 line 294) — 의미는 "primary mux 가용", 즉 darwin/Linux 에서는 tmux 도 true 반환
- session.mjs 는 이 alias 를 "literal psmux binary 존재" 로 오인 → darwin + tmux only host 에서 cache 가 `"psmux"`
- `terminal-opener.mjs::buildAttachCommand` (보고서 lines 318-323) 가 `mux === "psmux"` 분기에서 `psmux attach-session` 명령 emit → host 에 psmux 바이너리 없으니 실행 실패

라이브 evidence (보고서 lines 111-119):
```
platform: darwin
psmuxModuleMultiplexerType: tmux  ← psmux.mjs 는 옳게 tmux 해석
sessionDetectMultiplexer: psmux   ← session.mjs 가 오해
hasMultiplexer: true
hasPsmuxAlias: true
```

## Fix Direction (보고서 lines 396-401)

1. `hub/team/session.mjs::detectMultiplexer()`:
   - `hasPsmux()` first-check 제거
   - 대신 `psmux.mjs::getMultiplexerType()` (= `PSMUX_BIN` 환경 또는 platform-aware default) 를 literal mux-type resolver 로 사용
   - 또는 platform + binary 존재 검증으로 분기: darwin/linux + tmux 가용 → `"tmux"`; psmux 바이너리 명시 + 가용 → `"psmux"`; 그 외 → null
2. Windows primary 는 `"psmux"` 유지 (보고서 line 398) — POSIX 와 분기 명시
3. `hub/team/terminal-opener.mjs::buildAttachCommand`:
   - `mux === "psmux"` 분기는 보존 (Windows path 용)
   - 단 호출 전제 강화: `PSMUX_BIN` env 명시 + 바이너리 존재 검증 동반 (그렇지 않으면 darwin 에서 호출되지 않음)
4. `hasPsmux` backward-compatible alias 는 그대로 export — 외부 호출자 가 있을 수 있음 — 단 session.mjs 내부에서는 신뢰 금지 (literal mux identity 추론 우회)

## Acceptance Criteria (보고서 lines 404-408)

- darwin + tmux 가용 + psmux 부재 → `detectMultiplexer() === "tmux"`
- darwin 의 terminal opener → attach command 가 `tmux attach-session` 포함
- Windows path → 여전히 `detectMultiplexer() === "psmux"`
- `hasPsmux` alias 는 literal mux identity 로 누설되지 않음 (호출 시점에 의미 명확)

## Regression Tests (필수 추가)

`tests/unit/multiplexer-resolution.test.mjs` 확장:
- `darwin + tmux available + psmux missing → detectMultiplexer() === "tmux"` (보고서 line 405)
- `darwin terminal-opener emits "tmux attach-session"` (line 406)
- `windows path remains "psmux"` (line 407)
- `hasPsmux() alias true on darwin (because tmux available) but detectMultiplexer() !== "psmux"` (line 408)

`tests/unit/terminal-opener.test.mjs`:
- `buildAttachCommand("tmux", "demo")` returns string containing `tmux attach-session -t 'demo'`
- `buildAttachCommand("psmux", "demo")` 호출은 `PSMUX_BIN` env 명시 + 가상 binary 존재 stub 시에만 정상 — 그 외에는 호출 자체가 darwin 에서 일어나지 않도록 caller 검증

## Files (root + mirror)

| Root path | packages/triflux mirror | packages/remote mirror |
|-----------|-------------------------|------------------------|
| `hub/team/session.mjs` | byte-identical (cp 또는 동시 Edit) | **Edit only** — `@triflux/core/*` import 경로 보존 |
| `hub/team/terminal-opener.mjs` | byte-identical | Edit only |
| `tests/unit/multiplexer-resolution.test.mjs` | mirror 제외 (npm files 미포함) | mirror 제외 |
| `tests/unit/terminal-opener.test.mjs` | mirror 제외 | mirror 제외 |

Mirror verify (`.claude/rules/tfx-mirror-policy.md §검증`):
```bash
diff -q hub/team/session.mjs packages/triflux/hub/team/session.mjs   # exit 0
diff -q hub/team/terminal-opener.mjs packages/triflux/hub/team/terminal-opener.mjs   # exit 0
grep -E "@triflux/core/" packages/remote/hub/team/session.mjs   # non-empty
grep -E "@triflux/core/" packages/remote/hub/team/terminal-opener.mjs   # non-empty
```

## Cross-review

- Author CLI: codex (gpt-5.3-codex)
- Reviewer: claude (opus-4-7) — platform edge case
- ultrareview 1회: 머지 직전 `claude ultrareview <pr-s1>` (Pro 무료 1회 소비, severity=critical 시 머지 차단)

## Verify (PR body 에 포함)

```bash
pnpm test tests/unit/multiplexer-resolution.test.mjs tests/unit/terminal-opener.test.mjs
node -e "import('./hub/team/session.mjs').then(m=>console.log(m.detectMultiplexer()))"
diff -q hub/team/session.mjs packages/triflux/hub/team/session.mjs
diff -q hub/team/terminal-opener.mjs packages/triflux/hub/team/terminal-opener.mjs
grep "@triflux/core/" packages/remote/hub/team/session.mjs
```

기대 결과: 모두 0 또는 비어있지 않은 출력. darwin 명령 출력은 `"tmux"` (또는 null), 절대 `"psmux"` 아님.
