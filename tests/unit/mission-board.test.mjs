import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { getMissionBoardState } from "../../hud/mission-board.mjs";
import { renderMissionBoard } from "../../hud/renderers.mjs";

const TEMP_DIRS = [];

function makeTempDir() {
  const dir = join(
    tmpdir(),
    `triflux-mb-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  TEMP_DIRS.push(dir);
  return dir;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("getMissionBoardState", () => {
  it("세션 디렉토리가 없으면 null을 반환한다", async () => {
    const result = await getMissionBoardState(
      "/nonexistent/path/that/does/not/exist",
    );
    assert.equal(result, null);
  });

  it("세션 디렉토리가 비어있으면 null을 반환한다", async () => {
    const dir = makeTempDir();
    const result = await getMissionBoardState(dir);
    assert.equal(result, null);
  });

  it("세션 파일을 정확히 파싱하여 agents를 반환한다", async () => {
    const dir = makeTempDir();
    writeJson(join(dir, "exec.json"), {
      name: "exec",
      status: "done",
      startedAt: 1000,
      completedAt: 2000,
      progress: 100,
    });
    writeJson(join(dir, "ui.json"), {
      name: "ui",
      status: "active",
      startedAt: 1000,
      progress: 50,
    });
    writeJson(join(dir, "perf.json"), {
      name: "perf",
      status: "idle",
      startedAt: 1000,
      progress: 0,
    });

    const result = await getMissionBoardState(dir);
    assert.ok(result !== null);
    assert.equal(result.agents.length, 3);

    const exec = result.agents.find((a) => a.name === "exec");
    assert.ok(exec, "exec 에이전트가 존재해야 한다");
    assert.equal(exec.status, "done");
    assert.equal(exec.progress, 100);

    const ui = result.agents.find((a) => a.name === "ui");
    assert.ok(ui, "ui 에이전트가 존재해야 한다");
    assert.equal(ui.status, "active");
    assert.equal(ui.progress, 50);
  });

  it("progress 필드가 없으면 0으로 처리한다", async () => {
    const dir = makeTempDir();
    writeJson(join(dir, "worker.json"), {
      name: "worker",
      status: "active",
    });

    const result = await getMissionBoardState(dir);
    assert.ok(result !== null);
    const agent = result.agents[0];
    assert.equal(agent.progress, 0);
  });

  it("totalProgress는 에이전트 평균 progress를 반올림한 값이다", async () => {
    const dir = makeTempDir();
    writeJson(join(dir, "a.json"), {
      name: "a",
      status: "done",
      progress: 100,
    });
    writeJson(join(dir, "b.json"), {
      name: "b",
      status: "active",
      progress: 50,
    });
    writeJson(join(dir, "c.json"), { name: "c", status: "idle", progress: 0 });

    const result = await getMissionBoardState(dir);
    assert.ok(result !== null);
    // (100 + 50 + 0) / 3 = 50
    assert.equal(result.totalProgress, 50);
  });

  it("json이 아닌 파일은 무시한다", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "notes.txt"), "not json", "utf8");
    writeJson(join(dir, "exec.json"), {
      name: "exec",
      status: "done",
      progress: 100,
    });

    const result = await getMissionBoardState(dir);
    assert.ok(result !== null);
    assert.equal(result.agents.length, 1);
  });
});

describe("renderMissionBoard", () => {
  it("state가 null이면 빈 문자열을 반환한다", () => {
    assert.equal(renderMissionBoard(null), "");
  });

  it("정상 상태의 렌더링 포맷을 확인한다", () => {
    const state = {
      agents: [
        { name: "exec", status: "done", progress: 100 },
        { name: "ui", status: "active", progress: 50 },
        { name: "perf", status: "idle", progress: 0 },
      ],
      dagLevel: 0,
      totalProgress: 50,
    };
    const result = renderMissionBoard(state);
    assert.equal(result, "MB: exec:+ ui:* perf:. [1/3 50%]");
  });

  it("done 카운트와 진행률을 정확히 계산한다", () => {
    const state = {
      agents: [
        { name: "a", status: "done", progress: 100 },
        { name: "b", status: "done", progress: 100 },
        { name: "c", status: "active", progress: 30 },
      ],
      dagLevel: 0,
      totalProgress: 77,
    };
    const result = renderMissionBoard(state);
    assert.equal(result, "MB: a:+ b:+ c:* [2/3 77%]");
  });

  it("failed 상태 아이콘이 올바르게 렌더링된다", () => {
    const state = {
      agents: [{ name: "worker", status: "failed", progress: 0 }],
      dagLevel: 0,
      totalProgress: 0,
    };
    const result = renderMissionBoard(state);
    assert.equal(result, "MB: worker:! [0/1 0%]");
  });

  it("에이전트가 없을 때 done 카운트가 0이다", () => {
    const state = { agents: [], dagLevel: 0, totalProgress: 0 };
    const result = renderMissionBoard(state);
    assert.equal(result, "MB:  [0/0 0%]");
  });
});
