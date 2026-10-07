import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getTeamRow } from "../../hud/renderers.mjs";
import { stripAnsi } from "../../hud/utils.mjs";

it("최근 팀 상태 파일을 선택하고 24시간 지난 파일을 제외한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "hud-team-state-"));
  const now = Date.now();
  function write(name, completed, ageMs) {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        sessionName: name,
        members: [{ name: "executor", role: "worker", cli: "codex" }],
        tasks: [
          {
            owner: "executor",
            status: completed ? "completed" : "in_progress",
          },
        ],
      }),
    );
    utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
    return path;
  }
  try {
    const newest = write("team-state-a.json", true, 1_000);
    write("team-state-z.json", false, 60_000);
    write("team-state.json", false, 0);
    write("team-state-stale.json", false, 25 * 60 * 60 * 1000);
    assert.equal(stripAnsi(getTeamRow("full", dir).left), "1/1");
    rmSync(newest);
    assert.equal(stripAnsi(getTeamRow("full", dir).left), "0/1");
    rmSync(join(dir, "team-state-z.json"));
    assert.equal(getTeamRow("full", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("팀 상태 파일이 없으면 null을 반환한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "hud-team-empty-"));
  try {
    assert.equal(getTeamRow("full", dir), null);
    assert.equal(getTeamRow("full", join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
