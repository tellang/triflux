import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  activateSkill,
  deactivateSkill,
  getActiveSkills,
  pruneOrphanSkillStates,
} from "../../scripts/lib/skill-state.mjs";

const TEMP_DIRS = [];

function makeTempStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-skill-state-test-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("skill-state.mjs", () => {
  describe("activateSkill", () => {
    it("상태 파일을 생성한다", async () => {
      const stateDir = makeTempStateDir();
      await activateSkill("my-skill", { stateDir });

      const filePath = join(stateDir, "my-skill-active.json");
      assert.ok(existsSync(filePath), "state file should exist");

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);

      assert.equal(parsed.skillName, "my-skill");
      assert.equal(parsed.pid, process.pid);
      assert.ok(typeof parsed.activatedAt === "number");
    });

    it("중복 활성화 시 에러를 던진다", async () => {
      const stateDir = makeTempStateDir();
      await activateSkill("dup-skill", { stateDir });

      await assert.rejects(
        () => activateSkill("dup-skill", { stateDir }),
        /Skill already active: dup-skill/,
      );
    });

    it("경로 탐색이 포함된 skillName은 에러를 던진다", async () => {
      const stateDir = makeTempStateDir();

      await assert.rejects(
        () => activateSkill("../escaped", { stateDir }),
        /Invalid skill name: \.\.\/escaped/,
      );
    });

    it("stateDir이 없으면 자동 생성한다", async () => {
      const base = makeTempStateDir();
      const stateDir = join(base, "nested", "state");

      await activateSkill("new-skill", { stateDir });

      assert.ok(existsSync(join(stateDir, "new-skill-active.json")));
    });
  });

  describe("deactivateSkill", () => {
    it("상태 파일을 삭제한다", async () => {
      const stateDir = makeTempStateDir();
      await activateSkill("rm-skill", { stateDir });

      const filePath = join(stateDir, "rm-skill-active.json");
      assert.ok(existsSync(filePath));

      await deactivateSkill("rm-skill", { stateDir });
      assert.ok(!existsSync(filePath));
    });

    it("없는 스킬을 deactivate해도 에러가 없다", async () => {
      const stateDir = makeTempStateDir();
      await assert.doesNotReject(() =>
        deactivateSkill("ghost-skill", { stateDir }),
      );
    });
  });

  describe("getActiveSkills", () => {
    it("활성 스킬 목록을 반환한다", async () => {
      const stateDir = makeTempStateDir();
      await activateSkill("skill-a", { stateDir });
      await activateSkill("skill-b", { stateDir });

      const active = await getActiveSkills({ stateDir });
      const names = active.map((s) => s.skillName).sort();

      assert.deepEqual(names, ["skill-a", "skill-b"]);
      for (const entry of active) {
        assert.equal(entry.pid, process.pid);
        assert.ok(typeof entry.activatedAt === "number");
      }
    });

    it("stateDir이 없으면 빈 배열을 반환한다", async () => {
      const stateDir = join(tmpdir(), `nonexistent-${Date.now()}`);
      const active = await getActiveSkills({ stateDir });
      assert.deepEqual(active, []);
    });
  });

  describe("pruneOrphanSkillStates", () => {
    it("살아있는 pid의 스킬은 그대로 둔다", async () => {
      const stateDir = makeTempStateDir();
      await activateSkill("live-skill", { stateDir });

      const pruned = await pruneOrphanSkillStates({ stateDir });
      assert.deepEqual(pruned, []);

      const active = await getActiveSkills({ stateDir });
      assert.equal(active.length, 1);
    });

    it("죽은 pid의 상태 파일을 삭제하고 스킬명 배열을 반환한다", async () => {
      const stateDir = makeTempStateDir();

      // Write a state file with a pid that cannot be alive (pid 0 is never a real process)
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(stateDir, { recursive: true });
      const deadPid = 999999999;
      await writeFile(
        join(stateDir, "dead-skill-active.json"),
        JSON.stringify({
          skillName: "dead-skill",
          pid: deadPid,
          activatedAt: Date.now(),
        }),
        "utf8",
      );

      // Also add a live skill to verify it's kept
      await activateSkill("alive-skill", { stateDir });

      const pruned = await pruneOrphanSkillStates({ stateDir });
      assert.deepEqual(pruned, ["dead-skill"]);

      const active = await getActiveSkills({ stateDir });
      assert.equal(active.length, 1);
      assert.equal(active[0].skillName, "alive-skill");
    });
  });
});
