import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("Codex tfx-live adapter keeps the canonical skill body", () => {
  const canonical = readFileSync("skills/tfx-live/SKILL.md", "utf8");
  const adapter = readFileSync(
    "adapters/codex/skills/tfx-live/SKILL.md",
    "utf8",
  );
  const frontmatterEnd = canonical.indexOf("\n---\n", 4) + 5;
  assert.ok(frontmatterEnd > 4);
  assert.ok(adapter.startsWith(canonical.slice(0, frontmatterEnd)));
  const body = canonical.slice(frontmatterEnd);
  const hostContract =
    "\n## Codex 호스트 계약\n\nCodex에서는 `$tfx-live`로 호출한다. CLI의 `--cli`는 현재 호스트가 아니라 대상 세션을 선택한다.\n";
  assert.ok(body.startsWith("\n# tfx-live\n"));
  assert.equal(
    adapter.slice(frontmatterEnd),
    body.replace("\n# tfx-live\n", `\n# tfx-live\n${hostContract}`),
  );
});

test("agy tfx-live adapter keeps the canonical skill body", () => {
  const canonical = readFileSync("skills/tfx-live/SKILL.md", "utf8");
  const adapter = readFileSync("adapters/agy/skills/tfx-live/SKILL.md", "utf8");
  const frontmatterEnd = canonical.indexOf("\n---\n", 4) + 5;
  assert.ok(frontmatterEnd > 4);
  assert.ok(adapter.startsWith(canonical.slice(0, frontmatterEnd)));
  const body = canonical.slice(frontmatterEnd);
  const hostContract =
    "\n## agy 호스트 계약\n\nagy 에서는 이 스킬을 읽고 셸에서 `tfx-live` 명령을 실행한다. CLI 의 `--cli` 는 현재 호스트가 아니라 대상 세션을 고른다. 로컬 Claude, Codex, agy 대상은 `<홈 절대경로>/.claude/scripts/tfx-peer send`를 쓴다. `tfx-peer`와 `tfx-live`는 run_command 의 `BypassSandbox: true`로 실행한다. 터미널 샌드박스가 `~/.claude/scripts` 실행과 tmux, Claude 소켓 연결을 막는다.\n";
  assert.ok(body.startsWith("\n# tfx-live\n"));
  assert.equal(
    adapter.slice(frontmatterEnd),
    body.replace("\n# tfx-live\n", `\n# tfx-live\n${hostContract}`),
  );
});

test("Codex and agy tfx-live adapters ship the canonical references", () => {
  const dir = "skills/tfx-live/references";
  const names = readdirSync(dir).sort();
  for (const host of ["codex", "agy"]) {
    const adapterDir = `adapters/${host}/skills/tfx-live/references`;
    assert.deepEqual(readdirSync(adapterDir).sort(), names);
    for (const name of names) {
      assert.equal(
        readFileSync(`${adapterDir}/${name}`, "utf8"),
        readFileSync(`${dir}/${name}`, "utf8"),
      );
    }
  }
});
