import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
      { run },
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
      { run },
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
        { run },
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
      { run },
    );
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });
});
