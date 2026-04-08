import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  activateSkill,
  deactivateSkill,
  getActiveSkills,
  pruneOrphanSkillStates,
} from "../../scripts/lib/skill-state.mjs";

const TEMP_DIRS = [];
let warningCalls = [];
let originalConsoleWarn;

function makeTempStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-skill-state-test-"));
  TEMP_DIRS.push(dir);
  return dir;
}

beforeEach(() => {
  warningCalls = [];
  originalConsoleWarn = console.warn;
  console.warn = (...args) => {
    warningCalls.push(args);
  };
});

afterEach(() => {
  console.warn = originalConsoleWarn;
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

      const parsed = JSON.parse(await readFile(filePath, "utf8"));

      assert.equal(parsed.skillName, "my-skill");
      assert.equal(parsed.pid, process.pid);
      assert.ok(typeof parsed.activatedAt === "number");
      assert.equal(parsed.hasStopHook, false);
    });

    it("stop-hook 등록 시 상태 파일에 hasStopHook을 기록한다", async () => {
      const stateDir = makeTempStateDir();
      await activateSkill("hooked-skill", {
        stateDir,
        onStop: async () => {},
      });

      const parsed = JSON.parse(
        await readFile(join(stateDir, "hooked-skill-active.json"), "utf8"),
      );
      assert.equal(parsed.hasStopHook, true);
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

    it("등록된 stop-hook을 호출한 뒤 상태 파일을 삭제한다", async () => {
      const stateDir = makeTempStateDir();
      let called = 0;

      await activateSkill("hook-skill", {
        stateDir,
        onStop: async () => {
          called += 1;
        },
      });

      await deactivateSkill("hook-skill", { stateDir });

      assert.equal(called, 1);
      assert.ok(!existsSync(join(stateDir, "hook-skill-active.json")));
      assert.equal(warningCalls.length, 0);
    });

    it("stop-hook이 실패해도 deactivate를 완료한다", async () => {
      const stateDir = makeTempStateDir();

      await activateSkill("failing-hook", {
        stateDir,
        onStop: async () => {
          throw new Error("boom");
        },
      });

      await assert.doesNotReject(() =>
        deactivateSkill("failing-hook", { stateDir }),
      );

      assert.ok(!existsSync(join(stateDir, "failing-hook-active.json")));
      assert.equal(warningCalls.length, 1);
      assert.match(String(warningCalls[0][0]), /Failed to run stop-hook/);
      assert.equal(warningCalls[0][1]?.message, "boom");
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
      await activateSkill("skill-b", {
        stateDir,
        onStop: async () => {},
      });

      const active = await getActiveSkills({ stateDir });
      const names = active.map((s) => s.skillName).sort();

      assert.deepEqual(names, ["skill-a", "skill-b"]);
      const hookFlags = Object.fromEntries(
        active.map((entry) => [entry.skillName, entry.hasStopHook]),
      );
      assert.deepEqual(hookFlags, {
        "skill-a": false,
        "skill-b": true,
      });
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
      assert.equal(warningCalls.length, 0);
    });

    it("죽은 pid의 상태 파일을 삭제하고 스킬명 배열을 반환한다", async () => {
      const stateDir = makeTempStateDir();
      const deadPid = 999999999;

      await writeFile(
        join(stateDir, "dead-skill-active.json"),
        JSON.stringify({
          skillName: "dead-skill",
          pid: deadPid,
          activatedAt: Date.now(),
          hasStopHook: false,
        }),
        "utf8",
      );

      await activateSkill("alive-skill", { stateDir });

      const pruned = await pruneOrphanSkillStates({ stateDir });
      assert.deepEqual(pruned, ["dead-skill"]);

      const active = await getActiveSkills({ stateDir });
      assert.equal(active.length, 1);
      assert.equal(active[0].skillName, "alive-skill");
      assert.equal(warningCalls.length, 0);
    });

    it("orphan에 stop-hook이 있으면 실행하지 않고 경고만 남긴다", async () => {
      const stateDir = makeTempStateDir();
      const deadPid = 999999999;

      await writeFile(
        join(stateDir, "orphan-hook-active.json"),
        JSON.stringify({
          skillName: "orphan-hook",
          pid: deadPid,
          activatedAt: Date.now(),
          hasStopHook: true,
        }),
        "utf8",
      );

      const pruned = await pruneOrphanSkillStates({ stateDir });

      assert.deepEqual(pruned, ["orphan-hook"]);
      assert.ok(!existsSync(join(stateDir, "orphan-hook-active.json")));
      assert.equal(warningCalls.length, 1);
      assert.match(
        String(warningCalls[0][0]),
        /Skipping stop-hook for orphaned skill state: orphan-hook/,
      );
    });
  });
});
