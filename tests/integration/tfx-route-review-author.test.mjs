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
  cli,
  env = {},
  launch = "route",
  workerCli,
  prompt = "review fixture",
  profile,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "tfx-review-author-"));
  const cache = join(home, ".claude/cache");
  const argvPath = join(home, "argv.json");
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, "tmp"));
  writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-6-sol"\n');
  if (profile !== undefined) {
    writeFileSync(join(home, "machine-profile.env"), profile);
  }
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
    if (launch !== "route") {
      const callerEnv = {
        TFX_CLI_MODE: cli,
        TFX_REVIEW_AUTHOR: author,
        TFX_ROUTE_SCRIPT: route,
      };
      const saved = Object.fromEntries(
        Object.keys(callerEnv).map((key) => [key, process.env[key]]),
      );
      for (const [key, value] of Object.entries(callerEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        const command =
          launch === "headless"
            ? buildHeadlessCommand(
                workerCli || role,
                prompt,
                join(home, "result.txt"),
                {
                  handoff: false,
                  routeScript: route,
                  ...(workerCli ? { role } : {}),
                },
              )
            : buildCliCommand(role, prompt);
        assert.match(command, /tfx-route\.sh/, "실제 CLI 직접 실행을 차단한다");
        args = ["-lc", command];
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
    const executionEnv = {
      ...baseEnv,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      TFX_MACHINE_PROFILE_PATH: join(home, "machine-profile.env"),
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
      ...(cli === undefined ? {} : { TFX_CLI_MODE: cli }),
      TFX_HEARTBEAT: "0",
      TFX_HARD_CEILING_SEC: "0",
      TFX_MCP_HEALTH_CHECK: "0",
      TFX_QUOTA_REROUTE: "0",
      ...(author === undefined ? {} : { TFX_REVIEW_AUTHOR: author }),
      ...env,
    };
    if (launch !== "route") {
      delete executionEnv.TFX_REVIEW_AUTHOR;
      delete executionEnv.TFX_CLI_MODE;
    }
    const result = spawnSync(BASH_EXE, args, {
      cwd: home,
      encoding: "utf8",
      timeout: 20_000,
      env: executionEnv,
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
        assert.equal(r.argv[r.argv.indexOf("--profile") + 1], "sol");
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
    for (const [author, reviewer] of [
      ["codex", "claude"],
      ["claude", "codex"],
      ["antigravity", "claude"],
    ]) {
      test(`${launch} ${role} passes ${author} author through the command alone`, () => {
        const r = runRoute({ launch, role, author });
        assert.equal(r.status, 0, r.output);
        assert.match(
          r.output,
          new RegExp(`reviewer=${reviewer} review_author=${author}`),
        );
        if (reviewer === "claude") {
          assert.equal(r.argv[r.argv.indexOf("--model") + 1], "opus");
          assert.equal(r.argv[r.argv.indexOf("--effort") + 1], "high");
          assert.ok(r.argv.includes("--verbose"), r.output);
        } else {
          assert.equal(r.argv[r.argv.indexOf("--profile") + 1], "sol");
          assert.ok(r.argv.includes("review"), r.output);
        }
      });
    }
  }
  for (const cli of ["codex", "antigravity"]) {
    test(`${launch} preserves explicit CLI ${cli} through the command alone`, () => {
      const r = runRoute({ launch, cli, author: "codex" });
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`reviewer=${cli} review_author=codex`));
    });
  }
  for (const key of ["author", "cli"]) {
    test(`${launch} quotes ${key} shell metacharacters without executing them`, () => {
      const value = "literal 'quote' $(exit 19) `exit 20`";
      const r = runRoute({ launch, [key]: value });
      assert.ok(r.output.includes(value), r.output);
      if (key === "author") {
        assert.notEqual(r.status, 0, r.output);
        assert.deepEqual(r.argv, []);
      } else {
        assert.equal(r.status, 0, r.output);
        assert.ok(r.argv.length > 0, r.output);
      }
    });
  }
}

for (const workerCli of ["codex", "claude"]) {
  test(`headless ${workerCli} assignment preserves reviewer role policy`, () => {
    const r = runRoute({ launch: "headless", workerCli, author: "claude" });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /reviewer=codex review_author=claude/);
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

test("Antigravity fallback defaults to Codex", () => {
  const r = runRoute({ role: "writer", env: { TFX_DISABLE_ANTIGRAVITY: "1" } });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /type=codex agent=writer/);
  assert.equal(r.argv[0], "exec");
});

for (const [role, model, effort] of [
  ["security-reviewer", "fable", "high"],
  ["designer", "opus", "high"],
  ["document-specialist", "opus", undefined],
  ["writer", "opus", undefined],
  ["antigravity", "opus", undefined],
  ["agy", "opus", undefined],
]) {
  for (const unavailable of [
    { TFX_DISABLE_ANTIGRAVITY: "1" },
    { TFX_ANTIGRAVITY_OK: "0", AGY_BIN: "/missing/tfx-agy" },
  ]) {
    test(`${role}: explicit Claude fallback executes ${model} (${JSON.stringify(unavailable)})`, () => {
      const r = runRoute({
        role,
        env: { TFX_ANTIGRAVITY_FALLBACK: "claude", ...unavailable },
      });
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`type=claude agent=${role}`));
      assert.match(r.output, /antigravity.*claude.*fallback/);
      assert.match(r.output, /claude:review fixture/);
      assert.doesNotMatch(
        r.output,
        /ROUTE_TYPE=claude-native|TFX_NEEDS_FALLBACK/,
      );
      assert.equal(r.argv[r.argv.indexOf("--model") + 1], model);
      if (effort) assert.equal(r.argv[r.argv.indexOf("--effort") + 1], effort);
      else assert.ok(!r.argv.includes("--effort"));
    });
  }
}

test("Claude fallback requires an available Claude binary", () => {
  const r = runRoute({
    role: "writer",
    env: {
      TFX_DISABLE_ANTIGRAVITY: "1",
      TFX_ANTIGRAVITY_FALLBACK: "claude",
      CLAUDE_BIN: "/missing/tfx-claude",
    },
  });
  assert.equal(r.status, 78, r.output);
  assert.deepEqual(r.argv, []);
});

test("Antigravity Claude fallback worker failure remains a failure", () => {
  const r = runRoute({
    role: "writer",
    env: {
      TFX_DISABLE_ANTIGRAVITY: "1",
      TFX_ANTIGRAVITY_FALLBACK: "claude",
      CLAUDE_BIN_ARGS_JSON: JSON.stringify([
        "-e",
        "process.stderr.write('fixture failure'); process.exit(9)",
      ]),
    },
  });
  assert.notEqual(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /status: success|ROUTE_TYPE=claude-native/);
});

for (const value of ["gemini", "", "$(exit 19)"]) {
  for (const source of ["env", "profile"]) {
    test(`rejects invalid Antigravity fallback ${JSON.stringify(value)} from ${source}`, () => {
      const r = runRoute({
        role: "writer",
        env: source === "env" ? { TFX_ANTIGRAVITY_FALLBACK: value } : {},
        profile:
          source === "profile"
            ? `TFX_ANTIGRAVITY_FALLBACK=${value}\n`
            : undefined,
      });
      assert.notEqual(r.status, 0, r.output);
      assert.match(r.output, /TFX_ANTIGRAVITY_FALLBACK/);
      assert.deepEqual(r.argv, []);
    });
  }
}

for (const override of [undefined, "codex"]) {
  test(`profile Claude fallback respects runtime override ${override}`, () => {
    const r = runRoute({
      role: "writer",
      profile: "TFX_ANTIGRAVITY_FALLBACK=claude\n",
      env: {
        TFX_DISABLE_ANTIGRAVITY: "1",
        ...(override === undefined
          ? {}
          : { TFX_ANTIGRAVITY_FALLBACK: override }),
      },
    });
    assert.equal(r.status, 0, r.output);
    assert.match(
      r.output,
      new RegExp(`type=${override ?? "claude"} agent=writer`),
    );
    assert.ok(r.argv.length > 0);
  });
}

test("Antigravity fallback setting does not permit author self-review", () => {
  const r = runRoute({
    author: "claude",
    weekly: 85,
    env: { TFX_CODEX_OK: "0", TFX_ANTIGRAVITY_FALLBACK: "claude" },
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /reviewer=antigravity review_author=claude/);
});
