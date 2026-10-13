import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("tfx-lead and tfx-live agree on how Claude sends to a local Claude session", () => {
  const lead = readFileSync("skills/tfx-lead/SKILL.md", "utf8");
  const live = readFileSync("skills/tfx-live/SKILL.md", "utf8");
  const leadRow = lead
    .split("\n")
    .find((line) => line.startsWith("| Claude 세션에 보내기 |"));
  const claudeLeadCell = leadRow.split("|")[2];
  const liveRule = live
    .split("\n")
    .find((line) => line.includes("SendMessage 도구로 보낸다"));
  for (const rule of [claudeLeadCell, liveRule]) {
    assert.match(rule, /같은 기기/);
    assert.match(rule, /SendMessage/);
    assert.match(rule, /tfx-live list-sessions --cli claude/);
    assert.match(rule, /이름을 못 찾거나 원격/);
  }
});
