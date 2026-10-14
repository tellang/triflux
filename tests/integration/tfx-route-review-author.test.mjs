import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildHeadlessCommand } from "../../hub/team/headless.mjs";
import { buildCliCommand } from "../../hub/team/pane.mjs";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const route = toBashPath(join(root, "scripts/tfx-route.sh"));
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(TFX_|CODEX_|CLAUDE_|CLAUDECODE|GEMINI_|XDG_CONFIG_HOME|NODE_BIN|AGY_BIN)/.test(
        key,
      ),
  ),
);

function runRoute({
  role = "code-reviewer",
  author,
  weekly,
  weeklyResetsAt,
  cli = "auto",
  env = {},
  launch = "route",
  workerCli,
  prompt = "review fixture",
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "tfx-review-author-"));
  const cache = join(home, ".claude/cache");
  const argvPath = join(home, "argv.json");
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, "tmp"));
  writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-6-sol"\n');
  if (weekly !== undefined) {
    writeFileSync(
      join(cache, "claude-usage-cache.json"),
      weekly === "invalid-json"
        ? "{"
        : JSON.stringify({ data: { weeklyPercent: weekly, weeklyResetsAt } }),
    );
  }
  const fakeCli = join(home, "fake-cli");
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--print --dangerously-skip-permissions'); }
else if (args.includes('models')) { console.log(''); }
else { require('node:fs').writeFileSync(process.env.ROUTE_ARGV, JSON.stringify(args)); console.log('review fixture result'); }
`,
    { mode: 0o755 },
  );
  try {
    let args = [route, role, prompt, "review"];
    if (launch === "headless") {
      const saved = process.env.TFX_CLI_MODE;
      process.env.TFX_CLI_MODE = cli;
      try {
        const command = buildHeadlessCommand(
          workerCli || role,
          prompt,
          join(home, "result.txt"),
          {
            handoff: false,
            routeScript: route,
            ...(workerCli ? { role } : {}),
          },
        );
        assert.match(command, /tfx-route\.sh/, "실제 CLI 직접 실행을 차단한다");
        args = ["-lc", command];
      } finally {
        if (saved === undefined) delete process.env.TFX_CLI_MODE;
        else process.env.TFX_CLI_MODE = saved;
      }
    } else if (launch === "pane") {
      const command = buildCliCommand(role, prompt);
      assert.match(command, /tfx-route\.sh/, "실제 CLI 직접 실행을 차단한다");
      args = ["-lc", command];
    }
    const result = spawnSync(BASH_EXE, args, {
      cwd: home,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...baseEnv,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, ".config"),
        TMPDIR: join(home, "tmp"),
        NODE_BIN: process.execPath,
        CODEX_BIN: toBashPath(fakeCli),
        AGY_BIN: toBashPath(fakeCli),
        CLAUDE_BIN: process.execPath,
        CLAUDE_BIN_ARGS_JSON: JSON.stringify([
          join(root, "tests/fixtures/fake-claude-cli.mjs"),
        ]),
        FAKE_CLAUDE_ARGV_OUT: argvPath,
        ROUTE_ARGV: argvPath,
        TFX_ROUTE_SCRIPT: route,
        GH_TOKEN: "fixture-token",
        TFX_PREFLIGHT_LOADED: "1",
        TFX_CODEX_OK: "1",
        TFX_ANTIGRAVITY_OK: "1",
        TFX_DISABLE_CODEX: "0",
        TFX_DISABLE_ANTIGRAVITY: "0",
        TFX_CLI_MODE: cli,
        TFX_HEARTBEAT: "0",
        TFX_HARD_CEILING_SEC: "0",
        TFX_MCP_HEALTH_CHECK: "0",
        TFX_QUOTA_REROUTE: "0",
        ...(author === undefined ? {} : { TFX_REVIEW_AUTHOR: author }),
        ...env,
      },
    });
    if (launch === "headless") {
      for (const [key, suffix] of [
        ["stdout", ""],
        ["stderr", ".err"],
      ]) {
        try {
          result[key] += readFileSync(
            join(home, `result.txt${suffix}`),
            "utf8",
          );
        } catch {}
      }
    }
    let argv = [];
    try {
      argv = JSON.parse(readFileSync(argvPath, "utf8"));
    } catch {
      /* 거부된 요청은 실행하지 않는다. */
    }
    return { ...result, output: `${result.stdout}\n${result.stderr}`, argv };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const role of ["code-reviewer", "quality-reviewer"]) {
  for (const [author, weekly, expected] of [
    [undefined, undefined, "claude"],
    ["codex", 79.9, "claude"],
    ["codex", 80, "antigravity"],
    ["claude", 100, "codex"],
    ["antigravity", 79.9, "claude"],
    ["antigravity", 80, "codex"],
  ]) {
    test(`${role}: author=${author ?? "default"}, weekly=${weekly} selects ${expected}`, () => {
      const r = runRoute({ role, author, weekly });
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`type=${expected} agent=${role}`));
      assert.match(
        r.output,
        new RegExp(
          `\\[tfx-route\\].*review_author=${author ?? "codex"}.*usage_switch=${weekly >= 80 && author !== "claude"}`,
        ),
      );
      if (expected === "claude") {
        assert.equal(r.argv[r.argv.indexOf("--model") + 1], "opus");
        assert.equal(r.argv[r.argv.indexOf("--effort") + 1], "high");
        assert.ok(r.argv.includes("--verbose"), r.output);
      } else if (expected === "codex") {
        assert.equal(r.argv[r.argv.indexOf("--profile") + 1], "sol_high");
        assert.ok(r.argv.includes("review"), r.output);
      } else
        assert.match(r.argv[r.argv.indexOf("--model") + 1], /Argon \(High\)/);
    });
  }
}

for (const weekly of ["invalid-json", "80", null]) {
  test(`unusable usage cache (${weekly}) keeps Opus`, () => {
    const r = runRoute({ weekly });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.argv[r.argv.indexOf("--model") + 1], "opus");
  });
}

for (const author of ["unknown", "", "Codex"]) {
  test(`rejects invalid author ${JSON.stringify(author)} before dispatch`, () => {
    const r = runRoute({ author });
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /TFX_REVIEW_AUTHOR/);
    assert.deepEqual(r.argv, []);
  });
}

for (const cli of ["codex", "antigravity"]) {
  test(`explicit CLI ${cli} overrides the default Opus reviewer`, () => {
    const r = runRoute({ cli });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`type=${cli} agent=code-reviewer`));
  });
}

test("security-reviewer uses Argon High", () => {
  const r = runRoute({ role: "security-reviewer" });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /type=antigravity agent=security-reviewer/);
  assert.match(r.argv[r.argv.indexOf("--model") + 1], /Argon \(High\)/);
});

for (const launch of ["headless", "pane"]) {
  for (const role of ["code-reviewer", "quality-reviewer"]) {
    test(`${launch} ${role} dispatches through author policy`, () => {
      const r = runRoute({ launch, role, author: "codex" });
      assert.equal(r.status, 0, r.output);
      assert.match(
        r.output,
        /\[tfx-route\] reviewer=claude review_author=codex/,
      );
      assert.equal(r.argv[r.argv.indexOf("--model") + 1], "opus");
      assert.equal(r.argv[r.argv.indexOf("--effort") + 1], "high");
      assert.ok(r.argv.includes("--verbose"), r.output);
    });
  }
  test(`${launch} preserves explicit CLI choice`, () => {
    const r = runRoute({ launch, cli: "antigravity" });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /\[tfx-route\] reviewer=antigravity/);
  });
}

for (const workerCli of ["codex", "claude"]) {
  test(`headless ${workerCli} assignment preserves reviewer role policy`, () => {
    const r = runRoute({ launch: "headless", workerCli });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /reviewer=claude review_author=codex/);
  });
}

test("pane passes quoted multiline prompts without shell execution", () => {
  const prompt = "literal 'quote'\n$(exit 19) `exit 20`";
  const r = runRoute({ launch: "pane", prompt });
  assert.equal(r.status, 0, r.output);
  assert.ok(r.output.includes(prompt), r.output);
});

test("Claude review worker failure remains a failure", () => {
  const r = runRoute({
    env: {
      CLAUDE_BIN_ARGS_JSON: JSON.stringify([
        "-e",
        "process.stderr.write('fixture failure'); process.exit(9)",
      ]),
    },
  });
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /Claude 리뷰 워커 실패/);
  assert.doesNotMatch(r.output, /status: success|TFX_NEEDS_FALLBACK/);
});

for (const env of [
  { TFX_DISABLE_ANTIGRAVITY: "1" },
  { TFX_ANTIGRAVITY_OK: "0", AGY_BIN: "/missing/tfx-agy" },
]) {
  test(`Codex author never gets self-review on Argon fallback: ${JSON.stringify(env)}`, () => {
    const r = runRoute({ author: "codex", weekly: 85, env });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /\[tfx-route\] reviewer=claude review_author=codex/);
    assert.equal(r.argv[r.argv.indexOf("--model") + 1], "opus");
  });
}

for (const author of ["claude", "antigravity"]) {
  test(`${author} author is excluded when Codex is unavailable`, () => {
    const r = runRoute({ author, weekly: 85, env: { TFX_CODEX_OK: "0" } });
    assert.equal(r.status, 0, r.output);
    assert.match(
      r.output,
      new RegExp(`reviewer=${author === "claude" ? "antigravity" : "claude"}`),
    );
  });
}

test("missing Claude reviewer falls back to another vendor", () => {
  const r = runRoute({ env: { CLAUDE_BIN: "/missing/tfx-claude" } });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /reviewer=antigravity review_author=codex/);
});

test("no available cross-vendor reviewer fails before dispatch", () => {
  const r = runRoute({
    author: "codex",
    weekly: 85,
    env: {
      TFX_DISABLE_ANTIGRAVITY: "1",
      CLAUDE_BIN: "/missing/tfx-claude",
    },
  });
  assert.equal(r.status, 78, r.output);
  assert.deepEqual(r.argv, []);
});

for (const [weeklyResetsAt, expected] of [
  ["2000-01-01T00:00:00Z", "claude"],
  ["2999-01-01T00:00:00Z", "antigravity"],
]) {
  test(`weekly reset ${weeklyResetsAt} selects ${expected}`, () => {
    const r = runRoute({ weekly: 85, weeklyResetsAt });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`reviewer=${expected}`));
  });
}
