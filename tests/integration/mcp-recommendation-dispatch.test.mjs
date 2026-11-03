import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recommendMcp } from "../../hub/lib/mcp-recommendations.mjs";
import {
  buildHeadlessCommand,
  prepareHeadlessMcpRecommendation,
} from "../../hub/team/headless.mjs";
import { refreshMcpCatalog } from "../../scripts/lib/mcp-recommendation-catalog.mjs";
import { BASH_EXE } from "../helpers/bash-path.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const run = promisify(execFile);

test("Claude direct backend receives recommendation on stdin with the original task", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "tfx-mcp-claude-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "claude");
  writeFileSync(bin, "#!/bin/sh\ncat\n");
  chmodSync(bin, 0o755);
  let calls = 0;
  const recommendation = await prepareHeadlessMcpRecommendation(
    { cli: "claude", cwd: home, prompt: "원 작업" },
    {
      env: { HOME: home, XDG_CACHE_HOME: join(home, "cache") },
      jevOptions: {
        env: {},
        batchClient: async ({ state, questions }) => {
          calls++;
          const { task, candidates } = JSON.parse(state);
          assert.equal(task, "원 작업");
          return Object.fromEntries(
            Object.keys(questions).map((key, index) => [
              key,
              {
                value: candidates[index].id === "local:context7",
                confidence: 0.96,
              },
            ]),
          );
        },
      },
    },
  );
  const resultFile = join(home, "result.txt");
  const command = buildHeadlessCommand("claude", "원 작업", resultFile, {
    cwd: home,
    mcpRecommendation: recommendation,
    handoff: false,
  });
  await run(BASH_EXE, ["-c", command], {
    env: { ...process.env, PATH: `${home}:${process.env.PATH}`, HOME: home },
    timeout: 5000,
  });
  const content = readFileSync(resultFile, "utf8");
  assert.match(content, /원 작업/);
  assert.match(content, /"status":"recommended"/);
  assert.match(content, /"applied":false/);
  assert.match(content, /mcp-registry|mcp-server-catalog/);
  assert.equal(calls, 1);
});

for (const cli of ["codex", "antigravity", "claude"]) {
  const modes = ["headless", "headless_prior"];
  if (cli !== "claude") modes.push("direct", "disabled", "no_recommendation");
  if (cli === "codex") modes.push("headless_quoted");
  for (const mode of modes) {
    test(`${cli} ${mode}: one recommendation reaches worker without changing config or explicit profile`, {
      timeout: 30000,
    }, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "tfx-mcp-dispatch-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const put = (name, content) => {
        const path = join(home, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return path;
      };
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith("TFX_") &&
              ![
                "JEV_API_KEY",
                "TYPESAFE_API_KEY",
                "CODEX_HOME",
                "XDG_CACHE_HOME",
              ].includes(key),
          ),
        ),
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, "cache"),
        TFX_MACHINE_PROFILE_PATH: join(home, "machine.env"),
        TFX_PREFLIGHT_LOADED: "1",
        TFX_CODEX_OK: "1",
        TFX_ANTIGRAVITY_OK: "1",
        TFX_CODEX_TRANSPORT: "exec",
        TFX_HEARTBEAT: "0",
        TFX_MCP_HEALTH_CHECK: "0",
        TFX_HARD_CEILING_SEC: "0",
        TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
        TFX_CLI_MODE: cli === "claude" ? "auto" : cli,
        TFX_REVIEW_AUTHOR: "codex",
        TFX_CODEX_PROFILE: "sol_high",
        TFX_GEMINI_PROFILE: "argon",
        TFX_EXECUTION_MODE: "workspace_auto",
        TFX_TEAM_NAME: "",
        TFX_JEV_STATS: "0",
        JEV_API_KEY: "fixture-key",
        TFX_JEV: mode === "disabled" ? "0" : "1",
        TFX_TEST_NODE_REAL: process.execPath,
        TFX_TEST_NODE_LOG: join(home, "node.log"),
        TFX_TEST_EXEC_LOG: join(home, "exec.json"),
      };
      const config = put(
        ".codex/config.toml",
        '[mcp_servers.existing]\nurl="https://existing.example/mcp"\n',
      );
      env.CODEX_HOME = join(home, ".codex");
      env.NODE_BIN = put(
        "node-wrapper",
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TFX_TEST_NODE_LOG"\nexec "$TFX_TEST_NODE_REAL" "$@"\n',
      );
      chmodSync(env.NODE_BIN, 0o755);
      const before = readFileSync(config, "utf8");
      const bin = put(
        "worker.cjs",
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--print --dangerously-skip-permissions'); process.exit(0); }
function record(input) {
  fs.writeFileSync(process.env.TFX_TEST_EXEC_LOG, JSON.stringify({ args, input }));
}
if (args.includes('stream-json')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line);
    if (frame.type !== 'user') return;
    record(frame.message.content);
    console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fixture', result: 'WORKER_OK' }));
    process.exit(0);
  });
} else {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch {}
  record(input);
  console.log('WORKER_OK');
}
`,
      );
      chmodSync(bin, 0o755);
      env.CODEX_BIN = bin;
      env.AGY_BIN = bin;
      env.CLAUDE_BIN = bin;
      put(
        "package.json",
        JSON.stringify({
          name: "dispatch-fixture",
        }),
      );
      await refreshMcpCatalog({
        env,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            servers: [
              {
                server: {
                  name: "io.example/postgres",
                  description: "PostgreSQL schema index database lookup",
                  version: "1.0",
                  remotes: [
                    {
                      type: "streamable-http",
                      url: "https://postgres.example/mcp",
                    },
                  ],
                },
              },
            ],
            metadata: {},
          }),
        }),
      });
      const requests = [];
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        requests.push(payload);
        const candidates = payload.questions.candidate_0
          ? JSON.parse(payload.state).candidates
          : [];
        const answers = Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [
            key,
            {
              choice:
                key === "complexity"
                  ? "standard"
                  : key === "execution_mode"
                    ? "workspace_auto"
                    : key === "mcp_profile"
                      ? "none"
                      : Object.keys(question.criteria || {})[0],
              value:
                key.startsWith("candidate_") && mode !== "no_recommendation"
                  ? candidates[Number(key.slice(10))]?.id ===
                    "official:io.example/postgres"
                  : false,
              confidence: 0.96,
            },
          ]),
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ answers }));
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      t.after(() => new Promise((done) => server.close(done)));
      env.JEV_API_URL = `http://127.0.0.1:${server.address().port}`;
      const task =
        "PostgreSQL 개발 DB의 스키마와 인덱스를 조회하여 쿼리 병목을 분석한다. 데이터 변경은 하지 않는다.";
      const originalTask =
        mode === "headless_quoted"
          ? `${task}\n' " $HOME $(touch '${join(home, "injected")}') \`touch '${join(home, "injected")}'\`\n\n`
          : task;
      const contextFile =
        mode === "headless_prior"
          ? put(
              "prior.md",
              "unrelated previous workspace instructions\n".repeat(500),
            )
          : undefined;
      const resultFile = join(home, "result.txt");
      const role =
        cli === "claude"
          ? mode === "headless_prior"
            ? "quality-reviewer"
            : "code-reviewer"
          : cli === "codex"
            ? "executor"
            : "antigravity";
      assert.equal(
        await prepareHeadlessMcpRecommendation({
          cli,
          role,
          prompt: originalTask,
        }),
        null,
      );
      const savedMode = process.env.TFX_CLI_MODE;
      const savedAuthor = process.env.TFX_REVIEW_AUTHOR;
      let cmd;
      try {
        process.env.TFX_CLI_MODE = env.TFX_CLI_MODE;
        process.env.TFX_REVIEW_AUTHOR = env.TFX_REVIEW_AUTHOR;
        cmd = buildHeadlessCommand(
          cli === "claude" ? "codex" : cli,
          originalTask,
          resultFile,
          {
            role,
            contextFile,
            cwd: home,
            routeScript: join(ROOT, "scripts", "tfx-route.sh"),
            mcp: "none",
          },
        );
      } finally {
        if (savedMode === undefined) delete process.env.TFX_CLI_MODE;
        else process.env.TFX_CLI_MODE = savedMode;
        if (savedAuthor === undefined) delete process.env.TFX_REVIEW_AUTHOR;
        else process.env.TFX_REVIEW_AUTHOR = savedAuthor;
      }
      if (mode.startsWith("headless")) {
        const taskFile = cmd.match(
          /(\/[^\s'"]*prompt-[a-f0-9-]+\.txt\.task)/i,
        )?.[1];
        assert.ok(taskFile);
        assert.equal(readFileSync(taskFile, "utf8"), originalTask);
        if (process.platform !== "win32") {
          assert.equal(statSync(taskFile).mode & 0o777, 0o600);
          assert.equal(statSync(taskFile.slice(0, -5)).mode & 0o777, 0o600);
          assert.equal(statSync(dirname(taskFile)).mode & 0o777, 0o700);
        }
      }
      const args = !mode.startsWith("headless")
        ? [
            join(ROOT, "scripts", "tfx-route.sh"),
            cli === "codex" ? "executor" : "antigravity",
            originalTask,
            "none",
          ]
        : ["-lc", cmd];
      const outcome = await run(BASH_EXE, args, {
        cwd: home,
        env,
        timeout: 25000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const stderr = !mode.startsWith("headless")
        ? outcome.stderr
        : readFileSync(`${resultFile}.err`, "utf8");
      const worker = JSON.parse(readFileSync(env.TFX_TEST_EXEC_LOG, "utf8"));
      assert.ok(JSON.stringify(worker).includes(task));
      if (mode !== "disabled") {
        assert.equal(
          JSON.parse(
            requests.find((request) => request.questions.candidate_0).state,
          ).task,
          originalTask,
        );
      }
      assert.doesNotMatch(
        JSON.stringify(worker),
        /PostgreSQL schema index database lookup/,
      );
      const nodeCalls = readFileSync(env.TFX_TEST_NODE_LOG, "utf8");
      if (mode === "disabled") {
        assert.doesNotMatch(nodeCalls, /judge-mcp/);
        assert.doesNotMatch(stderr, /MCP recommendation/);
        assert.doesNotMatch(JSON.stringify(worker), /MCP recommendation/);
      } else if (mode === "no_recommendation") {
        assert.match(stderr, /"status":"no_recommendation"/);
        assert.doesNotMatch(stderr, /recommendation_bridge_failed/);
        assert.doesNotMatch(JSON.stringify(worker), /MCP recommendation/);
      } else {
        assert.match(stderr, /"status":"recommended"/);
        assert.match(stderr, /"applied":false/);
        assert.match(stderr, /registry.modelcontextprotocol.io/);
        assert.match(JSON.stringify(worker), /MCP recommendation/);
      }
      assert.equal(
        requests.filter((request) => request.questions.candidate_0).length,
        mode === "disabled" ? 0 : 1,
      );
      if (mode !== "disabled") {
        const state = JSON.parse(
          requests.find((request) => request.questions.candidate_0).state,
        );
        assert.equal(state.cli, cli === "antigravity" ? "agy" : cli);
        let expectedCandidates;
        await recommendMcp(
          { cliType: cli, cwd: home, task: originalTask },
          {
            env,
            jevOptions: {
              env: {},
              batchClient: async ({ state, questions }) => {
                expectedCandidates = JSON.parse(state).candidates.map(
                  ({ id }) => id,
                );
                return Object.fromEntries(
                  Object.keys(questions).map((key) => [
                    key,
                    { value: false, confidence: 0.96 },
                  ]),
                );
              },
            },
          },
        );
        assert.deepEqual(
          state.candidates.map(({ id }) => id),
          expectedCandidates,
        );
      }
      if (mode.startsWith("headless")) {
        const content = worker.input || worker.args.join(" ");
        assert.ok(content.includes(originalTask));
        assert.match(content, /\[workspace\]/);
        assert.match(content, /--- HANDOFF ---/);
        if (contextFile) assert.match(content, /<prior_context/);
      }
      assert.equal(existsSync(join(home, "injected")), false);
      assert.equal(readFileSync(config, "utf8"), before);
      assert.doesNotMatch(
        JSON.stringify(worker.args),
        /mcp_servers\..*enabled=true/,
      );
    });
  }
}
