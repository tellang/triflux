import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

/**
 * agy CLI 1.0.0 prompt 전달 패턴 회귀테스트.
 *
 * 정밀 sanity matrix (10종) 로 도출한 mechanism:
 * - `--print` 는 string value-taking flag (Go flag library)
 * - flag 순서 critical: `--print` 가 먼저 + 다른 flag 가 뒤면 value 흡수 사고 (timeout)
 * - `--dangerously-skip-permissions` 가 먼저 + `--print` 가 뒤 = 정상 (T10)
 * - `--print=VALUE` syntax = 정상 (T1, Go flag default)
 *
 * wrapper 의 antigravity case 가 사용해야 할 정답 패턴을 명시적으로 검증한다.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ROUTE_SCRIPT = toBashPath(
  resolve(PROJECT_ROOT, "scripts", "tfx-route.sh"),
);
const FIXTURE_BIN = toBashPath(
  resolve(PROJECT_ROOT, "tests", "fixtures", "bin"),
);
// Stub hub-ensure so full-route invocations never bind/spawn a hub on the
// canonical port (27888) against the live dev hub (v10.33.1 follow-up #1).
const HUB_ENSURE_STUB = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "no-op-hub-ensure.mjs",
);

function getAgyPath() {
  const result = spawnSync("which", ["agy"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const AGY_PATH = getAgyPath();

// 실측 agy CLI 를 직접 호출하는 5종 flag-mechanism regression 은 OAuth
// 토큰 차감이 발생한다. CI / 기본 `npm test` 에서는 항상 skip 하고, 명시적
// `TFX_AGY_LIVE=1 npm test` 또는 release 직전 검증 시에만 실행한다.
// tfx-route.sh routing regression (이 파일 line 217+) 은 `tests/fixtures/bin/agy`
// mock 으로 PATH override 되어 OAuth 와 무관하게 항상 실행된다.
const AGY_LIVE_REGRESSION =
  process.env.TFX_AGY_LIVE === "1" || process.env.TFX_AGY_LIVE === "true";

const TEST_PROMPT = "Reply with single word: hi";
const WELCOME_KEYWORDS = [
  "antigravity",
  "scratch",
  "how can i help",
  "active workspace",
  "timed out",
  "flag needs an argument",
];
const LEAK_FLAGS = ["--dangerously-skip-permissions", "--add-dir", "--print="];

function hasHi(text) {
  return text.toLowerCase().includes("hi");
}

function hasWelcomeOrFailure(text) {
  const lower = text.toLowerCase();
  return WELCOME_KEYWORDS.some((kw) => lower.includes(kw));
}

function leakedFlags(text) {
  return LEAK_FLAGS.filter((flag) => text.includes(flag));
}

function createRouteHome() {
  const home = mkdtempSync(join(tmpdir(), "tfx-route-agy-home-"));
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "config.toml"), "", "utf8");
  return home;
}

function runBash(command, extraEnv = {}) {
  const home = createRouteHome();
  return spawnSync(BASH_EXE, ["-c", command], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH || ""}`,
      AGY_BIN: "agy",
      HOME: home,
      USERPROFILE: home,
      TFX_TEAM_NAME: "",
      TFX_TEAM_TASK_ID: "",
      TFX_TEAM_AGENT_NAME: "",
      TFX_TEAM_LEAD_NAME: "",
      TFX_HUB_URL: "",
      TFX_HUB_ENSURE_SCRIPT: HUB_ENSURE_STUB,
      TMUX: "",
      TFX_CLI_MODE: "auto",
      TFX_NO_CLAUDE_NATIVE: "0",
      TFX_CODEX_TRANSPORT: "exec",
      TFX_MCP_HEALTH_CHECK: "0",
      ...extraEnv,
    },
  });
}

function out(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

test("agy --print prompt-passing regression tests", {
  skip: !AGY_PATH
    ? "agy not in PATH"
    : !AGY_LIVE_REGRESSION
      ? "set TFX_AGY_LIVE=1 to run real-agy regression (OAuth cost)"
      : false,
}, async (t) => {
  await t.test(
    "1. alpha commit pattern: --print --dangerously + stdin pipe -> success",
    { timeout: 100000 },
    () => {
      const result = spawnSync(
        AGY_PATH,
        ["--print", "--dangerously-skip-permissions"],
        {
          input: TEST_PROMPT,
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, PAGER: "cat" },
        },
      );
      assert.strictEqual(
        result.status,
        0,
        `Should exit 0. status=${result.status} signal=${result.signal} stderr=${result.stderr}`,
      );
      assert.ok(
        hasHi(result.stdout),
        `Should contain 'hi'. Got: ${result.stdout}`,
      );
      const leaks = leakedFlags(result.stdout);
      assert.deepStrictEqual(
        leaks,
        [],
        `Flag pollution detected in stdout: ${leaks.join(", ")}. Got: ${result.stdout}`,
      );
    },
  );

  await t.test(
    "2. Tier 1 broken pattern: positional + stdin closed -> failure",
    { timeout: 100000 },
    () => {
      const result = spawnSync(
        AGY_PATH,
        ["--print", "--dangerously-skip-permissions", "--", TEST_PROMPT],
        {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, PAGER: "cat" },
        },
      );
      const combined = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        !hasHi(combined) || hasWelcomeOrFailure(combined),
        `Broken pattern should NOT pass prompt. status=${result.status} signal=${result.signal} output: ${combined}`,
      );
    },
  );

  await t.test(
    "3. alternative flag order: --dangerously first + --print + positional -> success",
    { timeout: 100000 },
    () => {
      const result = spawnSync(
        AGY_PATH,
        ["--dangerously-skip-permissions", "--print", TEST_PROMPT],
        {
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, PAGER: "cat" },
        },
      );
      assert.strictEqual(
        result.status,
        0,
        `Should exit 0. status=${result.status}`,
      );
      assert.ok(
        hasHi(result.stdout),
        `Should contain 'hi'. Got: ${result.stdout}`,
      );
      const leaks = leakedFlags(result.stdout);
      assert.deepStrictEqual(
        leaks,
        [],
        `Flag pollution detected in stdout: ${leaks.join(", ")}. Got: ${result.stdout}`,
      );
    },
  );

  await t.test(
    "4. alternative equals syntax: --print=VALUE + --dangerously -> success",
    { timeout: 100000 },
    () => {
      const result = spawnSync(
        AGY_PATH,
        [`--print=${TEST_PROMPT}`, "--dangerously-skip-permissions"],
        {
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, PAGER: "cat" },
        },
      );
      assert.strictEqual(
        result.status,
        0,
        `Should exit 0. status=${result.status}`,
      );
      assert.ok(
        hasHi(result.stdout),
        `Should contain 'hi'. Got: ${result.stdout}`,
      );
      const leaks = leakedFlags(result.stdout);
      assert.deepStrictEqual(
        leaks,
        [],
        `Flag pollution detected in stdout: ${leaks.join(", ")}. Got: ${result.stdout}`,
      );
    },
  );

  await t.test(
    "5. flag absorption guard: --print + --add-dir + positional -> timeout/failure",
    { timeout: 100000 },
    () => {
      const result = spawnSync(
        AGY_PATH,
        ["--print", "--add-dir", "/tmp", TEST_PROMPT],
        {
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, PAGER: "cat" },
        },
      );
      const combined = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        !hasHi(combined) || hasWelcomeOrFailure(combined),
        `--print + --add-dir + positional should NOT pass prompt cleanly. status=${result.status} signal=${result.signal} output: ${combined}`,
      );
    },
  );

  await t.test(
    "6. flag absorption guard: --print + --sandbox + positional -> timeout/failure",
    { timeout: 100000 },
    () => {
      const result = spawnSync(
        AGY_PATH,
        ["--print", "--sandbox", "/tmp", TEST_PROMPT],
        {
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, PAGER: "cat" },
        },
      );
      const combined = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        !hasHi(combined) || hasWelcomeOrFailure(combined),
        `--print + --sandbox + positional should NOT pass prompt cleanly. status=${result.status} signal=${result.signal} output: ${combined}`,
      );
    },
  );
});

test("tfx-route.sh routes Antigravity through agy --print stdin", () => {
  const result = runBash(
    `bash "${ROUTE_SCRIPT}" antigravity 'Return exactly: AGY_OK' minimal 120`,
  );

  assert.equal(result.status, 0, out(result));
  assert.match(out(result), /type=antigravity/);
  assert.match(result.stdout, /AGY_OK/);
  assert.doesNotMatch(out(result), /ROUTE_TYPE=claude-native/);
});

test("TFX_CLI_MODE=antigravity remaps codex-routed agents to agy", () => {
  const result = runBash(
    `TFX_CLI_MODE=antigravity bash "${ROUTE_SCRIPT}" executor 'Return exactly: AGY_OK' minimal 120`,
  );

  assert.equal(result.status, 0, out(result));
  assert.match(out(result), /TFX_CLI_MODE=antigravity: executor/);
  assert.match(out(result), /type=antigravity/);
  assert.match(result.stdout, /AGY_OK/);
});

test("direct gemini route redirects to Antigravity when preflight marked agy ready", () => {
  const result = runBash(
    `TFX_ANTIGRAVITY_OK=1 bash "${ROUTE_SCRIPT}" gemini 'Return exactly: AGY_OK' minimal 120`,
  );

  assert.equal(result.status, 0, out(result));
  assert.match(out(result), /agent: gemini/);
  assert.match(out(result), /cli: antigravity/);
  assert.match(out(result), /type=antigravity/);
  assert.match(result.stdout, /AGY_OK/);
  assert.doesNotMatch(out(result), /type=gemini/);
});
