import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

/**
 * agy CLI 1.0.0 prompt 전달 패턴 회귀테스트.
 *
 * 정밀 sanity matrix (10종) 로 도출한 mechanism:
 * - `--print` 는 string value-taking flag (Go flag library)
 * - flag 순서 critical: `--print` 가 먼저 + 다른 flag 가 뒤면 value 흡수 사고 (timeout)
 * - `--dangerously-skip-permissions` 가 먼저 + `--print` 가 뒤 = 정상 (T10)
 * - `--print=VALUE` syntax = 정상 (T1, Go flag default)
 *
 * wrapper (scripts/tfx-route.sh L2031-2046) 의 antigravity case 가 사용해야 할
 * 정답 패턴을 명시적으로 검증한다.
 */

function getAgyPath() {
  const result = spawnSync("which", ["agy"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const AGY_PATH = getAgyPath();
const TEST_PROMPT = "Reply with single word: hi";
const WELCOME_KEYWORDS = [
  "antigravity",
  "scratch",
  "how can i help",
  "active workspace",
  "timed out",
  "flag needs an argument",
];

function hasHi(text) {
  return text.toLowerCase().includes("hi");
}

function hasWelcomeOrFailure(text) {
  const lower = text.toLowerCase();
  return WELCOME_KEYWORDS.some((kw) => lower.includes(kw));
}

test("agy --print prompt-passing regression tests", { skip: !AGY_PATH ? "agy not in PATH" : false }, async (t) => {

  await t.test("1. α commit 패턴 (현재): --print --dangerously + stdin pipe -> 정상", { timeout: 30000 }, () => {
    const result = spawnSync(AGY_PATH, ["--print", "--dangerously-skip-permissions"], {
      input: TEST_PROMPT,
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, PAGER: "cat" },
    });
    assert.strictEqual(result.status, 0, `Should exit 0. status=${result.status} signal=${result.signal} stderr=${result.stderr}`);
    assert.ok(hasHi(result.stdout), `Should contain 'hi'. Got: ${result.stdout}`);
  });

  await t.test("2. Tier 1 broken 패턴 (regression guard): positional + stdin closed -> 실패", { timeout: 30000 }, () => {
    const result = spawnSync(AGY_PATH, ["--print", "--dangerously-skip-permissions", "--", TEST_PROMPT], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, PAGER: "cat" },
    });
    const combined = (result.stdout || "") + (result.stderr || "");
    assert.ok(
      !hasHi(combined) || hasWelcomeOrFailure(combined),
      `Broken pattern should NOT pass prompt. status=${result.status} signal=${result.signal} output: ${combined}`,
    );
  });

  await t.test("3. 대안 (flag swap): --dangerously 먼저 + --print + positional -> 정상", { timeout: 30000 }, () => {
    const result = spawnSync(AGY_PATH, ["--dangerously-skip-permissions", "--print", TEST_PROMPT], {
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, PAGER: "cat" },
    });
    assert.strictEqual(result.status, 0, `Should exit 0. status=${result.status}`);
    assert.ok(hasHi(result.stdout), `Should contain 'hi'. Got: ${result.stdout}`);
  });

  await t.test("4. 대안 (= syntax): --print=VALUE + --dangerously -> 정상", { timeout: 30000 }, () => {
    const result = spawnSync(AGY_PATH, [`--print=${TEST_PROMPT}`, "--dangerously-skip-permissions"], {
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, PAGER: "cat" },
    });
    assert.strictEqual(result.status, 0, `Should exit 0. status=${result.status}`);
    assert.ok(hasHi(result.stdout), `Should contain 'hi'. Got: ${result.stdout}`);
  });

  await t.test("5. flag 흡수 사고 (regression guard): --print + --add-dir + positional -> timeout", { timeout: 30000 }, () => {
    const result = spawnSync(AGY_PATH, ["--print", "--add-dir", "/tmp", TEST_PROMPT], {
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, PAGER: "cat" },
    });
    const combined = (result.stdout || "") + (result.stderr || "");
    assert.ok(
      !hasHi(combined) || hasWelcomeOrFailure(combined),
      `--print + --add-dir + positional should NOT pass prompt cleanly. status=${result.status} signal=${result.signal} output: ${combined}`,
    );
  });
});
