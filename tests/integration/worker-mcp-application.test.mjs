import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildHeadlessCommand } from "../../hub/team/headless.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "mcp-application-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const put = (path, data) => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TFX_") &&
        !["JEV_API_KEY", "TYPESAFE_API_KEY", "CODEX_HOME"].includes(key),
    ),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    TMPDIR: home,
    TFX_PREFLIGHT_LOADED: "1",
    TFX_CODEX_OK: "1",
    TFX_ANTIGRAVITY_OK: "1",
    TFX_HEARTBEAT: "0",
    TFX_HARD_CEILING_SEC: "0",
    TFX_MCP_HEALTH_CHECK: "0",
    TFX_ALLOW_SMALL_CODEX_CONFIG: "1",
    TFX_TEAM_NAME: "",
    TFX_JEV: "1",
    TFX_JEV_STATS: "0",
    JEV_API_KEY: "",
    TYPESAFE_API_KEY: "",
    TFX_TEST_LOG: join(home, "worker.json"),
    TFX_TEST_JEV_LOG: join(home, "jev.jsonl"),
  });
  put(
    ".codex/config.toml",
    'model="gpt-6-luna"\nmodel_reasoning_effort="low"\n[mcp_servers.docs]\nurl="https://mcp.context7.com/mcp?key=PRIVATE"\nenabled_tools=["query-docs"]\ndisabled_tools=["resolve-library-id"]\n[mcp_servers.other]\nurl="https://other.example/mcp"\n',
  );
  put(
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://mcp.context7.com/mcp?key=PRIVATE",
          headers: { Authorization: "PRIVATE" },
        },
        other: { url: "https://other.example/mcp" },
      },
    }),
  );
  env.TFX_JEV_CLI = put(
    "jev",
    `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); fs.appendFileSync(process.env.TFX_TEST_JEV_LOG, JSON.stringify(a)+'\\n');
const q = a[1] || ''; const value = q.includes('Candidate metadata:') && q.includes('"id":"local:context7"');
const choice = q.includes('complexity') ? 'standard' : q.includes('permission') ? 'workspace_auto' : q.includes('MCP') || q.includes('server profile') ? 'none' : 'keep';
console.log(JSON.stringify({choice,value,confidence:0.98}));
`,
  );
  env.CODEX_BIN =
    env.AGY_BIN =
    env.CLAUDE_BIN =
      put(
        "worker",
        `#!${process.execPath}
const fs=require('fs'), path=require('path'); const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('fixture'); process.exit(0); }
if(args.includes('--help')) { console.log('--print --dangerously-skip-permissions'); process.exit(0); }
function record(input) {
 const file=args[args.indexOf('--mcp-config')+1];
 const mcp=args.includes('--mcp-config') ? {file,config:JSON.parse(fs.readFileSync(file,'utf8')),mode:fs.statSync(file).mode&511,dirMode:fs.statSync(path.dirname(file)).mode&511}:null;
 fs.writeFileSync(process.env.TFX_TEST_LOG,JSON.stringify({args,input,mcp}));
}
if(args.includes('stream-json')) require('readline').createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line); if(f.type==='user'){record(f.message.content); console.log(JSON.stringify({type:'result',subtype:'success',result:'WORKER_OK'}));}});
else { record(''); console.log('WORKER_OK'); }
`,
      );
  chmodSync(env.TFX_JEV_CLI, 0o755);
  chmodSync(env.CODEX_BIN, 0o755);
  const recommendation = {
    cli: "claude",
    status: "recommended",
    recommendations: [
      {
        id: "local:context7",
        source: { id: "local", url: "file:///catalog" },
        installationStatus: "present",
        confidence: 0.98,
      },
    ],
    applied: false,
  };
  return { home, env, put, recommendation };
}

for (const cli of ["codex", "claude", "antigravity"]) {
  test(`${cli} route: original task, one recommendation, final provider, private launch configuration`, {
    timeout: 30000,
  }, async (t) => {
    const f = fixture(t),
      result = join(f.home, "result.txt"),
      metadataFile = join(f.home, "mcp.json");
    f.put(
      ".claude/cache/mcp-enabled.json",
      JSON.stringify({ enabled: ["other", "docs"] }),
    );
    f.env.TFX_CLI_MODE = cli === "claude" ? "auto" : cli;
    f.env.TFX_REVIEW_AUTHOR = "codex";
    f.env.TFX_WORKER_MCP_FILE = metadataFile;
    const originals = [".codex/config.toml", ".claude.json"].map((path) =>
      readFileSync(join(f.home, path), "utf8"),
    );
    const task = "원 작업 ' $HOME $(touch should-not-exist)\n";
    const taskFile = f.put("task", task);
    const args = [
      join(root, "scripts/tfx-route.sh"),
      cli === "claude" ? "code-reviewer" : "executor",
      "조립된 프롬프트",
      "auto",
      "",
      "",
      taskFile,
    ];
    await run("/bin/bash", args, { cwd: f.home, env: f.env, timeout: 25000 });
    const worker = JSON.parse(readFileSync(f.env.TFX_TEST_LOG, "utf8"));
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    assert.equal(metadata.application.cli, cli === "antigravity" ? "agy" : cli);
    assert.equal(metadata.application.runtimeConfirmed, false);
    assert.equal(metadata.application.toolVerified, false);
    const queries = readFileSync(f.env.TFX_TEST_JEV_LOG, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const candidates = queries.filter((a) =>
      (a[1] || "").includes("Candidate metadata:"),
    );
    assert.ok(candidates.length > 0);
    assert.equal(
      candidates.filter((a) => (a[1] || "").includes('"id":"local:context7"'))
        .length,
      1,
    );
    for (const a of candidates)
      assert.ok(
        a.some((v) => v.includes(task.trim())),
        JSON.stringify(a),
      );
    if (cli === "codex") {
      assert.equal(worker.args[0], "exec");
      assert.ok(
        worker.args.includes("mcp_servers.docs.enabled=true"),
        JSON.stringify({
          application: metadata.application,
          flags: worker.args.filter((arg) => arg.startsWith("mcp_servers.")),
        }),
      );
      assert.ok(worker.args.includes("mcp_servers.other.enabled=false"));
      assert.ok(
        !worker.args.some((arg) => arg.includes("mcp_servers.context7.")),
      );
      assert.ok(
        !worker.args.some((arg) => arg.includes("docs.enabled_tools=[]")),
      );
      assert.equal(metadata.application.appliedTo, "start_args");
      // 사용자 기본 luna/low와 다른 Jev 선택이 실행 인자에 반영된다.
      assert.equal(worker.args[worker.args.indexOf("--profile") + 1], "sol");
      assert.ok(worker.args.includes('model_reasoning_effort="high"'));
    } else if (cli === "claude") {
      assert.ok(worker.args.includes("--strict-mcp-config"));
      assert.equal(worker.mcp.mode, 0o600);
      assert.equal(worker.mcp.dirMode, 0o700);
      assert.deepEqual(Object.keys(worker.mcp.config.mcpServers), ["docs"]);
      assert.equal(
        worker.mcp.config.mcpServers.docs.headers.Authorization,
        "PRIVATE",
      );
      assert.equal(existsSync(worker.mcp.file), false);
      assert.equal(metadata.application.appliedTo, "start_args");
    } else {
      assert.equal(metadata.application.status, "deferred");
      assert.ok(
        metadata.application.reasons.includes(
          "agy_server_session_isolation_unverified",
        ),
      );
    }
    assert.doesNotMatch(
      JSON.stringify(worker.args),
      /PRIVATE|headers|Authorization/,
    );
    assert.doesNotMatch(
      JSON.stringify(metadata),
      /PRIVATE|headers|Authorization/,
    );
    assert.deepEqual(
      [".codex/config.toml", ".claude.json"].map((path) =>
        readFileSync(join(f.home, path), "utf8"),
      ),
      originals,
    );
    assert.equal(existsSync(join(f.home, "should-not-exist")), false);
    assert.equal(existsSync(result), false);
  });
}

for (const outcome of ["success", "failure", "cancel"]) {
  test(`Claude direct ${outcome}: private config survives until child reads and is cleaned afterwards`, {
    timeout: 15000,
  }, async (t) => {
    const f = fixture(t);
    const bin = join(f.home, "claude");
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2); const file=args[args.indexOf('--mcp-config')+1];
setTimeout(()=>{ fs.writeFileSync(process.env.TFX_TEST_LOG,JSON.stringify({file,config:JSON.parse(fs.readFileSync(file,'utf8')),args})); ${outcome === "cancel" ? "setInterval(()=>{},1000)" : `process.exit(${outcome === "failure" ? 2 : 0})`} },50);
`,
    );
    chmodSync(bin, 0o755);
    const resultFile = join(f.home, "direct.txt");
    const cmd = buildHeadlessCommand("claude", "원 작업", resultFile, {
      cwd: f.home,
      mcpRecommendation: f.recommendation,
      handoff: false,
    });
    const env = { ...f.env, PATH: `${f.home}:${f.env.PATH}` };
    if (outcome === "cancel") {
      const child = spawn(
        "/bin/bash",
        ["-c", `exec ${cmd.slice(cmd.indexOf(" && ") + 4)}`],
        { cwd: f.home, env, stdio: "ignore" },
      );
      t.after(() => child.kill("SIGKILL"));
      await new Promise((done, reject) => {
        const timer = setInterval(() => {
          if (existsSync(f.env.TFX_TEST_LOG)) {
            clearInterval(timer);
            done();
          }
        }, 20);
        setTimeout(() => {
          clearInterval(timer);
          reject(new Error("child did not read config"));
        }, 4000).unref();
      });
      const closed = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await closed;
    } else {
      try {
        await run("/bin/bash", ["-c", cmd], {
          cwd: f.home,
          env,
          timeout: 8000,
        });
        assert.equal(outcome, "success");
      } catch (error) {
        assert.equal(outcome, "failure", error.stderr);
        assert.equal(error.code, 2);
      }
    }
    const worker = JSON.parse(readFileSync(f.env.TFX_TEST_LOG, "utf8"));
    assert.equal(
      worker.config.mcpServers.docs.headers.Authorization,
      "PRIVATE",
    );
    assert.equal(existsSync(worker.file), false);
    assert.equal(existsSync(dirname(worker.file)), false);
    const metadata = JSON.parse(readFileSync(`${resultFile}.mcp.json`, "utf8"));
    assert.equal(metadata.application.appliedTo, "start_args");
    assert.equal(metadata.application.runtimeConfirmed, false);
  });
}

test("concurrent Claude calls use independent private configs and preserve the shared registration", {
  timeout: 10000,
}, async (t) => {
  const f = fixture(t);
  const bin = join(f.home, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),file=args[args.indexOf('--mcp-config')+1];
setTimeout(()=>console.log(JSON.stringify({file, readable:!!fs.readFileSync(file)})),100);
`,
  );
  chmodSync(bin, 0o755);
  const before = readFileSync(join(f.home, ".claude.json"));
  const files = [join(f.home, "one.txt"), join(f.home, "two.txt")];
  const commands = files.map((file) =>
    buildHeadlessCommand("claude", "원 작업", file, {
      cwd: f.home,
      mcpRecommendation: f.recommendation,
      handoff: false,
    }),
  );
  await Promise.all(
    commands.map((cmd) =>
      run("/bin/bash", ["-c", cmd], {
        cwd: f.home,
        env: { ...f.env, PATH: `${f.home}:${f.env.PATH}` },
        timeout: 8000,
      }),
    ),
  );
  const results = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
  assert.notEqual(results[0].file, results[1].file);
  for (const result of results) {
    assert.equal(result.readable, true);
    assert.equal(existsSync(result.file), false);
  }
  assert.deepEqual(readFileSync(join(f.home, ".claude.json")), before);
});

test("Claude direct explicit config is passed unchanged and automatic selection is deferred", {
  timeout: 10000,
}, async (t) => {
  const f = fixture(t);
  const explicit = f.put("explicit.json", '{"mcpServers":{}}');
  const bin = join(f.home, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(bin, 0o755);
  const file = join(f.home, "explicit.txt");
  const cmd = buildHeadlessCommand("claude", "원 작업", file, {
    cwd: f.home,
    mcpRecommendation: f.recommendation,
    mcpConfig: explicit,
    handoff: false,
  });
  await run("/bin/bash", ["-c", cmd], {
    cwd: f.home,
    env: { ...f.env, PATH: `${f.home}:${f.env.PATH}` },
    timeout: 8000,
  });
  const args = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(args.slice(-2), ["--mcp-config", explicit]);
  assert.equal(args.includes("--strict-mcp-config"), false);
  const metadata = JSON.parse(readFileSync(`${file}.mcp.json`, "utf8"));
  assert.ok(metadata.application.reasons.includes("explicit_mcp_config"));
  assert.equal(metadata.application.appliedTo, null);
  assert.equal(readFileSync(explicit, "utf8"), '{"mcpServers":{}}');
});

test("Claude route keeps unapproved project config under native trust handling", {
  timeout: 15000,
}, async (t) => {
  const f = fixture(t);
  f.put(".claude.json", "{}");
  f.put(
    ".mcp.json",
    '{"mcpServers":{"docs":{"url":"https://mcp.context7.com/mcp"}}}',
  );
  f.env.TFX_REVIEW_AUTHOR = "codex";
  f.env.TFX_WORKER_MCP_FILE = join(f.home, "pending.json");
  await run(
    "/bin/bash",
    [join(root, "scripts/tfx-route.sh"), "code-reviewer", "원 작업", "auto"],
    { cwd: f.home, env: f.env, timeout: 12000 },
  );
  const worker = JSON.parse(readFileSync(f.env.TFX_TEST_LOG, "utf8"));
  assert.equal(worker.args.includes("--mcp-config"), false);
  assert.equal(worker.args.includes("--strict-mcp-config"), false);
  const metadata = JSON.parse(readFileSync(f.env.TFX_WORKER_MCP_FILE, "utf8"));
  assert.ok(
    metadata.application.reasons.includes("project_approval_unverified"),
  );
});

test("Claude route cancellation cleans the config after its child has read it", {
  timeout: 15000,
}, async (t) => {
  const f = fixture(t);
  f.env.TFX_REVIEW_AUTHOR = "codex";
  f.env.TFX_WORKER_MCP_FILE = join(f.home, "cancel.json");
  writeFileSync(
    f.env.CLAUDE_BIN,
    `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
require('readline').createInterface({input:process.stdin}).on('line',()=>{
const file=args[args.indexOf('--mcp-config')+1]; fs.readFileSync(file); fs.writeFileSync(process.env.TFX_TEST_LOG,JSON.stringify({file})); setInterval(()=>{},1000);
});
`,
  );
  const child = spawn(
    "/bin/bash",
    [join(root, "scripts/tfx-route.sh"), "code-reviewer", "원 작업", "auto"],
    { cwd: f.home, env: f.env, stdio: "ignore" },
  );
  t.after(() => child.kill("SIGKILL"));
  await new Promise((done, reject) => {
    const timer = setInterval(() => {
      if (existsSync(f.env.TFX_TEST_LOG)) {
        clearInterval(timer);
        done();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error("route child did not read config"));
    }, 8000).unref();
  });
  const closed = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await closed;
  const { file } = JSON.parse(readFileSync(f.env.TFX_TEST_LOG, "utf8"));
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(dirname(file)), false);
});

for (const cli of ["claude", "antigravity"]) {
  test(`${cli} effort 단독 입력은 원 task 부재 시에도 중첩 ultra 제한을 보존한다`, {
    timeout: 30000,
  }, async (t) => {
    const f = fixture(t);
    Object.assign(f.env, {
      TFX_JEV: "0",
      TFX_WORKER_CLI: cli,
      TFX_CLI_MODE: cli,
      TFX_WORKER_EFFORT: "ultra",
      TFX_WORKER_INDEX: "1",
    });
    await run(
      "/bin/bash",
      [
        join(root, "scripts/tfx-route.sh"),
        cli === "claude" ? "code-reviewer" : "executor",
        "task",
        "auto",
        "",
        "",
        join(f.home, "missing.task"),
      ],
      { cwd: f.home, env: f.env, timeout: 25000 },
    );
    const args = JSON.parse(readFileSync(f.env.TFX_TEST_LOG, "utf8")).args;
    assert.equal(args[args.indexOf("--effort") + 1], "max");
    assert.ok(!args.includes("--model"));
  });
}
