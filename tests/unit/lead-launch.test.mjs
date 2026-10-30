import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_JEV_STATS_PATH } from "../../hub/lib/jev-addon.mjs";
import {
  launchLead,
  leadDisplayName,
  leadEntryPrompt,
  leadSessionName,
  offerLeadLaunchers,
  resolveLauncher,
} from "../../hub/team/lead-launch.mjs";

function config(content) {
  const path = join(mkdtempSync(join(tmpdir(), "tfx-lead-")), "lead.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

function fakeRun(replies) {
  const calls = [];
  const run = async (_node, [, ...args]) => {
    calls.push(args);
    return { stdout: JSON.stringify(replies[args[0]]) };
  };
  return { calls, run };
}

describe("tfx lead", () => {
  for (const mode of [
    "applied",
    "explicit",
    "launcher",
    "not_ready",
    "throw",
    "ask_throw",
    "low",
    "disabled",
    "stats_off",
    "custom_no_file",
  ]) {
    it(`lead_model_selection은 시작 인자 선택과 ready를 구분한다: ${mode}`, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "lead-history-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const statsFile = join(home, "stats.jsonl");
      const defaultBefore = existsSync(DEFAULT_JEV_STATS_PATH)
        ? readFileSync(DEFAULT_JEV_STATS_PATH, "utf8")
        : null;
      const error = new Error("private start exception");
      const calls = [];
      const options = {
        modelOptions: { home, env: {} },
        jevOptions: {
          ...(mode === "custom_no_file" ? {} : { statsFile }),
          env: {
            TFX_JEV: mode === "disabled" ? "0" : "",
            TFX_JEV_STATS: mode === "stats_off" ? "off" : "",
          },
          batchClient: async () => ({
            complexity: {
              choice: "deep",
              confidence: mode === "low" ? 0.2 : 0.95,
            },
            execution_mode: { choice: "workspace_auto", confidence: 0.86 },
            mcp_profile: { choice: "none", confidence: 0.28 },
          }),
        },
        run: async (_node, [, ...args]) => {
          calls.push(args);
          if (
            (mode === "throw" && args[0] === "start") ||
            (mode === "ask_throw" && args[0] === "ask")
          )
            throw error;
          return {
            stdout: JSON.stringify(
              args[0] === "start"
                ? { ready: mode !== "not_ready" }
                : { ok: true },
            ),
          };
        },
      };
      const input = {
        cli: "codex",
        role: "private role",
        task: "private task",
        launcher: mode === "launcher" ? "private launcher" : "codex",
        ...(mode === "explicit" ? { model: "chosen-model" } : {}),
      };
      const invoke = () => launchLead(input, options);
      if (["throw", "ask_throw"].includes(mode))
        await assert.rejects(invoke, (caught) => caught === error);
      else await invoke();
      const text = existsSync(statsFile) ? readFileSync(statsFile, "utf8") : "";
      assert.doesNotMatch(text, /private (role|task|launcher|start exception)/);
      if (["disabled", "stats_off", "custom_no_file"].includes(mode)) {
        assert.equal(text, "");
        assert.equal(
          existsSync(DEFAULT_JEV_STATS_PATH)
            ? readFileSync(DEFAULT_JEV_STATS_PATH, "utf8")
            : null,
          defaultBefore,
        );
        return;
      }
      const rows = text.trim().split("\n").map(JSON.parse);
      const history = rows.filter((row) => row.hook === "lead_model_selection");
      assert.equal(history.length, 1);
      const row = history[0];
      const applied = ["applied", "not_ready", "ask_throw"].includes(mode);
      assert.equal(row.appliedTo, applied ? "start_args" : null);
      assert.equal(row.startReady, !["throw", "not_ready"].includes(mode));
      assert.equal(row.startStatus, mode === "throw" ? "threw" : "returned");
      assert.equal(
        row.source,
        ["explicit", "launcher"].includes(mode)
          ? "explicit"
          : mode === "low"
            ? "default"
            : "jev",
      );
      assert.equal(row.recommendedEffort, mode === "low" ? null : "xhigh");
      assert.equal(
        row.effectiveEffort,
        ["explicit", "launcher", "low"].includes(mode) ? null : "xhigh",
      );
      assert.equal(
        row.effectiveModel,
        mode === "explicit"
          ? "chosen-model"
          : ["launcher", "low"].includes(mode)
            ? null
            : row.recommendedModel,
      );
      assert.equal(
        row.reason,
        mode === "throw"
          ? "start_failed"
          : mode === "explicit"
            ? "explicit_model_effort_preserved"
            : mode === "launcher"
              ? "launcher_preserved"
              : mode === "low"
                ? "no_accepted_recommendation"
                : "jev_applied",
      );
      if (mode !== "low") assert.equal(row.confidence, 0.905);
      assert.equal(calls.filter((args) => args[0] === "start").length, 1);
      assert.ok(!calls.some((args) => args[0] === "stop"));
      if (mode === "throw") assert.equal(calls.length, 1);
    });
  }
  it("CLI는 task와 역할을 나누고 JSON 및 human 출력에 선택 근거를 표시한다", (t) => {
    const home = mkdtempSync(join(tmpdir(), "lead-parser-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const fake = `export const resolveLauncher = ({ cli, flag }) => flag || cli;
      export const launchLead = async (input) => ({ok:true, ...input, name:input.role, session:'fake-lead', routing:{enabled:true,attempted:true,complexity:'deep',recommendedProfile:'astra_xhigh',effectiveModel:'fake-model',effectiveEffort:'xhigh',confidence:0.9,source:'jev',reason:'jev_applied',appliedTo:'start_args'}});`;
    const hook = `import { registerHooks } from 'node:module';
      registerHooks({resolve(specifier, context, next) { if (specifier === '../hub/team/lead-launch.mjs' && context.parentURL.endsWith('/bin/triflux.mjs')) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(fake)}`)},shortCircuit:true}; return next(specifier, context); }});`;
    const invoke = (...args) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(hook)}`,
          new URL("../../bin/triflux.mjs", import.meta.url).pathname,
          "lead",
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, "config"),
            CODEX_HOME: join(home, "codex"),
            TFX_JEV: "0",
          },
        },
      );
    const json = invoke(
      "프로젝트",
      "리드",
      "--cli",
      "codex",
      "--task",
      "승계 준비와 워커 평가",
      "--json",
    );
    assert.equal(json.status, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.role, "프로젝트 리드");
    assert.equal(result.task, "승계 준비와 워커 평가");
    assert.equal(result.routing.appliedTo, "start_args");
    const human = invoke("리드", "--task", "짧은 요약");
    assert.equal(human.status, 0, human.stderr);
    for (const field of [
      "enabled=true",
      "attempted=true",
      "deep",
      "astra_xhigh",
      "fake-model",
      "xhigh",
      "0.9",
      "jev_applied",
      "start_args",
    ])
      assert.ok(human.stdout.includes(field), field);
    const missing = invoke("리드", "--task");
    assert.notEqual(missing.status, 0);
    const help = invoke("--help");
    assert.match(help.stdout, /--task/);
  });
  it("Jev deep 권고를 resolver의 concrete start 인자에만 반영한다", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "lead-model-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".config", "triflux"), { recursive: true });
    writeFileSync(
      join(home, ".config", "triflux", "models.json"),
      JSON.stringify({ astra: "gpt-9-astra" }),
    );
    const { calls, run } = fakeRun({
      start: { ready: true },
      ask: { ok: true },
    });
    const requests = [];
    const result = await launchLead(
      {
        cli: "codex",
        role: "프로젝트 리드",
        task: "완료 구현 평가와 다중 워커 조정",
        cwd: "/p/app",
        launcher: "codex",
      },
      {
        run,
        modelOptions: { home, env: {}, allowCommand: false, persist: false },
        jevOptions: {
          env: {},
          batchClient: async (request) => {
            requests.push(request);
            return {
              complexity: { choice: "deep", confidence: 0.9 },
              execution_mode: { choice: "bypass", confidence: 0.99 },
              mcp_profile: { choice: "none", confidence: 0.95 },
            };
          },
        },
      },
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0].state, /완료 구현 평가와 다중 워커 조정/u);
    assert.match(requests[0].state, /multiple workers/u);
    assert.deepEqual(calls[0].slice(-4), [
      "--model",
      "gpt-9-astra",
      "--effort",
      "xhigh",
    ]);
    assert.deepEqual(calls[0].slice(0, -4), [
      "start",
      "--cli",
      "codex",
      "--session",
      "app-lead",
      "--name",
      result.name,
      "--launcher",
      "codex",
      "--cwd",
      "/p/app",
    ]);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["start", "ask"],
    );
    assert.equal(result.routing.recommendedProfile, "astra_xhigh");
    assert.equal(result.routing.effectiveModel, "gpt-9-astra");
    assert.equal(result.routing.effectiveEffort, "xhigh");
    assert.equal(result.routing.appliedTo, "start_args");
    assert.equal(result.routing.source, "jev");
    assert.equal(result.routing.attempted, true);
  });

  for (const override of [
    { model: "chosen" },
    { effort: "low" },
    { model: "chosen", effort: "high" },
    { launcher: "codex --profile sol" },
    { launcher: "custom-wrapper" },
  ]) {
    it(`명시 옵션과 런처를 보존한다: ${JSON.stringify(override)}`, async () => {
      const { calls, run } = fakeRun({
        start: { ready: true },
        ask: { ok: true },
      });
      const result = await launchLead(
        {
          cli: "codex",
          role: "리드",
          cwd: "/p/app",
          launcher: "codex",
          ...override,
        },
        {
          run,
          jevOptions: {
            env: {},
            batchClient: async () => ({
              complexity: { choice: "deep", confidence: 0.9 },
            }),
          },
        },
      );
      assert.deepEqual(calls[0].slice(11), [
        ...(override.model ? ["--model", override.model] : []),
        ...(override.effort ? ["--effort", override.effort] : []),
      ]);
      assert.equal(calls[0][8], override.launcher || "codex");
      assert.equal(result.routing.source, "explicit");
      assert.match(result.routing.reason, /preserved/);
      assert.equal(result.routing.appliedTo, null);
      assert.equal(result.routing.recommendedProfile, "astra_xhigh");
    });
  }

  for (const mode of ["disabled", "error", "low", "unsupported"]) {
    it(`Jev ${mode} 때 기본 시작을 유지하고 start 실패 뒤 ask하지 않는다`, async () => {
      const { calls, run } = fakeRun({ start: { ready: false } });
      const result = await launchLead(
        { cli: "codex", role: "리드", cwd: "/p/app", launcher: "codex" },
        {
          run,
          jevOptions: {
            env: { TFX_JEV: mode === "disabled" ? "0" : "1" },
            batchClient: async () => {
              if (mode === "error") throw new Error("timeout secret");
              return {
                complexity: {
                  choice: mode === "unsupported" ? "unknown" : "deep",
                  confidence: mode === "low" ? 0.1 : 0.9,
                },
              };
            },
          },
        },
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].length, 11);
      assert.equal(result.routing.source, "default");
      assert.equal(result.routing.attempted, mode !== "disabled");
      assert.equal(result.routing.appliedTo, null);
    });
  }

  it("잘못된 CLI와 빈 역할은 Jev와 start를 호출하지 않는다", async () => {
    const options = {
      run: async () => assert.fail("start 호출"),
      jevOptions: { env: {}, batchClient: async () => assert.fail("Jev 호출") },
    };
    await assert.rejects(launchLead({ cli: "invalid", role: "리드" }, options));
    await assert.rejects(launchLead({ cli: "codex", role: " " }, options));
  });

  for (const cli of ["claude", "agy"]) {
    it(`${cli}도 기존 권고와 resolver로 모델을 선택한다`, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "lead-other-cli-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const { calls, run } = fakeRun({
        start: { ready: true },
        ask: { ok: true },
      });
      const result = await launchLead(
        { cli, role: "리드", cwd: "/p/app", launcher: cli },
        {
          run,
          modelOptions: { home, env: {} },
          jevOptions: {
            env: {},
            batchClient: async () => ({
              complexity: { choice: "deep", confidence: 0.9 },
            }),
          },
        },
      );
      assert.equal(result.routing.source, "jev");
      assert.equal(result.routing.effectiveEffort, "high");
      assert.match(
        result.routing.effectiveModel,
        cli === "agy" ? /Argon/ : /^opus$/,
      );
      assert.equal(calls[0].at(-3), result.routing.effectiveModel);
      assert.equal(calls[0].at(-1), "high");
    });
  }

  it("알 수 없는 프로필 권고를 CLI 모델로 넘기지 않는다", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "lead-unknown-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const { calls, run } = fakeRun({
      start: { ready: true },
      ask: { ok: true },
    });
    const result = await launchLead(
      { cli: "codex", role: "리드", launcher: "codex" },
      {
        run,
        modelOptions: { home, env: {} },
        jevOptions: { env: {}, batchClient: async () => ({}) },
        judgeRouting: async () => ({
          complexity: "deep",
          codexProfile: "not_a_profile",
          confidence: 0.9,
        }),
      },
    );
    assert.equal(result.routing.reason, "unsupported_profile");
    assert.equal(result.routing.source, "default");
    assert.ok(!calls[0].includes("--model"));
    assert.ok(!calls[0].includes("--effort"));
  });
  it("실행 명령은 --launcher, lead.json, claude 순으로 고른다", () => {
    const path = config(JSON.stringify({ launcher: "omc launch" }));
    assert.equal(resolveLauncher({ flag: "x", configPath: path }), "x");
    assert.equal(resolveLauncher({ configPath: path }), "omc launch");
    assert.equal(resolveLauncher({ configPath: config() }), "claude");
    const both = config(
      JSON.stringify({ launchers: { claude: "c-wrap", codex: "x-wrap" } }),
    );
    assert.equal(resolveLauncher({ cli: "codex", configPath: both }), "x-wrap");
    assert.equal(resolveLauncher({ cli: "agy", configPath: both }), "agy");
    for (const bad of ["null", '{"launchers":"ab"}'])
      assert.throws(
        () => resolveLauncher({ configPath: config(bad) }),
        /lead\.json 는 \{"launchers"/u,
      );
    assert.throws(
      () => resolveLauncher({ configPath: config('{"launcher":"a\\nb"}') }),
      /한 줄/u,
    );
  });

  it("세션과 표시 이름을 tmux, /tfx-lead 규칙에 맞춘다", () => {
    assert.equal(leadSessionName("/p/mnk.cxas:test"), "mnk-cxas-test-lead");
    // 한글 폴더끼리 같은 이름으로 겹치지 않는다.
    assert.notEqual(leadSessionName("/p/앱"), leadSessionName("/p/웹"));
    const now = new Date(2026, 9, 28);
    assert.equal(leadDisplayName("개발리드", now), "10.28 개발리드");
    assert.equal(leadDisplayName("10.27 mnk 리드", now), "10.27 mnk 리드");
  });

  it("지정한 실행 명령으로 띄운 뒤 /tfx-lead 를 tmux 로 보낸다", async () => {
    const { calls, run } = fakeRun({
      start: { ready: true },
      ask: { ok: true },
    });
    const result = await launchLead(
      { role: "개발리드", cwd: "/p/app", launcher: "omc launch" },
      { run, jevOptions: { env: { TFX_JEV: "0" } } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.session, "app-lead");
    const start = calls[0];
    assert.equal(start[start.indexOf("--launcher") + 1], "omc launch");
    assert.equal(start[start.indexOf("--cli") + 1], "claude");
    const ask = calls[1];
    assert.equal(ask[ask.indexOf("--prompt") + 1], "/tfx-lead 개발리드");
    assert.ok(ask.includes("--via-tmux"));
  });

  it("tfx-live 가 exit 1 로 끝나도 stdout 의 원인을 돌려준다", async () => {
    const run = async () => {
      const error = new Error("Command failed");
      error.stdout = JSON.stringify({ ok: false, error: "duplicate session" });
      throw error;
    };
    const result = await launchLead(
      { role: "리드", cwd: "/p/app", launcher: "claude" },
      { run, jevOptions: { env: { TFX_JEV: "0" } } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.start.error, "duplicate session");
  });

  it("Codex, agy 리드는 mod 가 없어 스킬 파일을 읽게 한다", () => {
    assert.equal(leadEntryPrompt("claude", "개발리드"), "/tfx-lead 개발리드");
    assert.match(
      leadEntryPrompt("codex", "개발리드"),
      /skills\/tfx-lead\/SKILL\.md 를 읽고 이 세션이 개발리드 리드/u,
    );
  });

  for (const cli of ["codex", "agy"]) {
    it(`${cli} 실행 진입에 공통 스킬과 자산 선택 안내를 전달한다`, async () => {
      const { calls, run } = fakeRun({
        start: { ready: true },
        ask: { ok: true },
      });
      const result = await launchLead(
        { cli, role: "자산 연결", cwd: "/p/app", launcher: cli },
        { run, jevOptions: { env: { TFX_JEV: "0" } } },
      );
      assert.equal(result.ok, true);
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["start", "ask"],
      );
      const ask = calls[1];
      assert.equal(ask[ask.indexOf("--cli") + 1], cli);
      const prompt = ask[ask.indexOf("--prompt") + 1];
      const skillPath = prompt.slice(0, prompt.indexOf(" 를 읽고"));
      assert.ok(
        readFileSync(skillPath, "utf8").startsWith("---\nname: tfx-lead\n"),
      );
      for (const asset of ["tfx-harness", "tfx-auto", "tfx-live"])
        assert.ok(prompt.includes(asset), `${asset} 선택 안내 누락`);
      assert.ok(prompt.length < 1000, "진입에 긴 스킬 전문을 넣지 않는다");
      assert.ok(ask.includes("--no-wait"));
      assert.ok(!ask.includes("--via-tmux"));
    });
  }

  it("setup 은 설치된 CLI 중 아직 안 정한 것만 묻고 저장한다", async () => {
    const path = config(JSON.stringify({ launcher: "c-wrap" }));
    const asked = [];
    const status = await offerLeadLaunchers({
      interactive: true,
      hasCommand: (cli) => cli !== "agy",
      askText: async (question) => {
        asked.push(question);
        return "  x-wrap --flag \n";
      },
      configPath: path,
    });
    assert.equal(status, "saved");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^Codex /u);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).launchers, {
      claude: "c-wrap",
      codex: "x-wrap --flag",
    });
    // 다 정했으면 다시 묻지 않는다.
    const again = await offerLeadLaunchers({
      interactive: true,
      hasCommand: (cli) => cli !== "agy",
      askText: async () => assert.fail("다시 물었다"),
      configPath: path,
    });
    assert.equal(again, "present");
  });

  it("물을 수 없으면 저장하지 않고 미룬다", async () => {
    const path = config();
    const status = await offerLeadLaunchers({
      interactive: false,
      hasCommand: () => true,
      askText: async () => assert.fail("비대화형에서 물었다"),
      configPath: path,
    });
    assert.equal(status, "deferred");
    assert.equal(resolveLauncher({ configPath: path }), "claude");
  });

  it("세션이 준비되지 않으면 /tfx-lead 를 보내지 않는다", async () => {
    const { calls, run } = fakeRun({
      start: { ready: false, blockedBy: "claude-trust-folder" },
    });
    const result = await launchLead(
      { role: "리드", cwd: "/p/app", launcher: "claude" },
      { run, jevOptions: { env: { TFX_JEV: "0" } } },
    );
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });
});
