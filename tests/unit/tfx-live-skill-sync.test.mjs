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
  assert.match(
    adapter.slice(frontmatterEnd),
    /^## Codex host contract\n\nInvoke this skill as `\$tfx-live`/,
  );
  assert.ok(adapter.endsWith(canonical.slice(frontmatterEnd)));
});
