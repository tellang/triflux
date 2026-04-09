---
name: tfx-qa
description: >
  테스트 스위트(unit/integration)를 실행하고, 실패한 테스트의 출력을 파싱하여
  원인을 진단한 뒤, 구현 코드(또는 잘못된 테스트)를 수정하고 재실행하여
  전체 통과시키는 반복 수정 사이클. 'qa', '검증해', '테스트 돌려',
  'test-fix', '테스트 통과시켜', 'run tests and fix' 같은 요청에 사용.
  일반 디버깅이 아닌 자동화된 테스트 스위트 수정에 특화.
triggers:
  - qa
  - 검증
  - 테스트 검증
  - test-fix
argument-hint: "[테스트 명령 또는 파일 경로]"
---

# tfx-qa -- Light Test-Fix Cycle

> **Deep version**: tfx-deep-qa. Escalate with "제대로/꼼꼼히" modifier.

## Workflow

### Step 1: Detect test runner

Use the user-provided command if given. Otherwise auto-detect:

```bash
if [ -f package.json ] && grep -q '"test"' package.json; then TEST_CMD="npm test"
elif [ -f pytest.ini ] || grep -q '\[tool\.pytest' pyproject.toml 2>/dev/null; then TEST_CMD="pytest"
elif grep -q '^test:' Makefile 2>/dev/null; then TEST_CMD="make test"
fi
```

If a file path is given instead, scope with Glob: `Glob("**/*{filename}*.test.*")`.

### Step 2: Execute and parse

Run the test command via Bash and capture output. Claude directly parses the results:

```bash
Bash("{TEST_CMD} 2>&1")
```

Extract failures from output using framework-specific patterns:
- **Jest/Vitest**: lines matching `FAIL` + stack traces between `●` markers
- **pytest**: lines after `FAILURES` header, each `FAILED` line = `file::test -- reason`
- **make/generic**: non-zero exit + stderr lines containing `Error`/`FAIL`/`assert`

Build a structured failure list:

```
failures = [
  { file: "src/auth.ts", test: "should validate token", error: "Expected true, got false", line: 42 },
  ...
]
```

If zero failures, skip to Step 4.

### Step 3: Fix-and-rerun (max 3 rounds)

For each round while `failures` is non-empty:

1. **Locate**: for each failure, `Read(file, offset=line-10, limit=20)` to get surrounding context.
2. **Diagnose**: identify whether the bug is in implementation code or the test assertion.
3. **Fix**: use `Edit(file, old_string, new_string)` to patch the implementation code. Only edit test code when the assertion itself is provably wrong.
4. **Re-run**: `Bash("{TEST_CMD} 2>&1")` and re-parse failures as in Step 2.
5. **Check**: if all pass, exit loop. Otherwise continue to next round.

After 3 rounds, collect any unresolved failures for the report.

### Step 4: Report

```markdown
## QA Results: {target}

| Round | Pass | Fail | Fixes Applied |
|-------|------|------|---------------|
| 1 | {n} | {n} | -- |
| 2 | {n} | {n} | {summary} |

### Final: {pass}/{total} passing
- Modified: {file list}
- Unresolved: {failures, if any + root cause analysis}

### Fix Details
- `{file}:{line}` -- {what and why}
```

Unresolved failures after 3 rounds get root cause analysis and manual investigation suggestions.
