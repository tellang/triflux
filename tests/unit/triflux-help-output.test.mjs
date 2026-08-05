import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const binPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "triflux.mjs",
);

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("tfx --help 출력", () => {
  it("Commands 섹션에 tfx swarm 포함", () => {
    const raw = execSync(`node "${binPath}" --help`, { encoding: "utf8" });
    const out = stripAnsi(raw);
    assert.match(out, /tfx swarm/);
  });

  it("tfx swarm --help 가 sub-help 출력", () => {
    const raw = execSync(`node "${binPath}" swarm --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /PRD|shard|worktree/i);
  });

  it("#109: Commands 섹션에 tfx synapse 포함", () => {
    const raw = execSync(`node "${binPath}" --help`, { encoding: "utf8" });
    const out = stripAnsi(raw);
    assert.match(out, /tfx synapse/);
  });

  it("#109: Commands 섹션에 tfx why 포함", () => {
    const raw = execSync(`node "${binPath}" --help`, { encoding: "utf8" });
    const out = stripAnsi(raw);
    assert.match(out, /tfx why\b/);
  });

  it("#109: tfx swarm --help 에 run 서브커맨드 노출", () => {
    const raw = execSync(`node "${binPath}" swarm --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /tfx swarm run/);
  });

  it("#188: tfx swarm --help 에 preflight 서브커맨드 노출", () => {
    const raw = execSync(`node "${binPath}" swarm --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /tfx swarm preflight/);
    assert.match(out, /go\/no-go|preflight/i);
  });

  it("stale: tfx update --help 는 업데이트를 실행하지 않고 도움말만 출력", () => {
    const raw = execSync(`node "${binPath}" update --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /tfx update/);
    assert.match(out, /Usage/);
    assert.doesNotMatch(out, /npm install -g|업데이트 완료|git pull/);
  });

  it("stale: tfx auto --help 는 현재 antigravity lane을 노출", () => {
    const raw = execSync(`node "${binPath}" auto --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /--cli <name>/);
    assert.match(out, /antigravity/);
    assert.match(out, /quick\|deep\|consensus\|live/);
    assert.match(out, /--rounds <N>/);
    assert.doesNotMatch(out, /gemini/);
  });

  it("stale: tfx auto --cli gemini 는 antigravity 호환 alias로 정규화", () => {
    const raw = execSync(`node "${binPath}" auto --cli gemini --json`, {
      encoding: "utf8",
    });
    const payload = JSON.parse(stripAnsi(raw));
    assert.equal(payload.args.cli, "antigravity");
    assert.match(payload.args.warnings.join("\n"), /deprecated.*antigravity/);
  });

  for (const command of [
    "setup",
    "doctor",
    "handoff",
    "schema",
    "synapse",
    "hooks",
    "multi",
    "notion-read",
    "review",
    "tray",
    "why",
  ]) {
    it(`stale: tfx ${command} --help 는 side-effect 없이 help 출력`, () => {
      const raw = execSync(`node "${binPath}" ${command} --help`, {
        encoding: "utf8",
      });
      const out = stripAnsi(raw);
      assert.match(out, new RegExp(`tfx ${command}`));
      assert.match(out, /Usage|tfx codex-team/);
    });
  }
});
