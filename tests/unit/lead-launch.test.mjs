import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  launchLead,
  leadDisplayName,
  leadSessionName,
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
