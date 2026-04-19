import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  detectAdapter,
  gstackTimelineAdapter,
  nullTimelineAdapter,
} from "../../hub/lib/timeline-adapter.mjs";

const TEMP_DIRS = [];
const RESTORES = [];

function registerTempDir(prefix) {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function setEnv(name, value) {
  const previous = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  RESTORES.push(() => {
    if (previous == null) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

function setHomeDir(homeDir) {
  setEnv("HOME", homeDir);
  setEnv("USERPROFILE", homeDir);
}

function pushCwd(nextCwd) {
  const previous = process.cwd();
  process.chdir(nextCwd);
  RESTORES.push(() => process.chdir(previous));
}

function createGitRepo(name = "timeline-adapter-repo") {
  const root = registerTempDir(`tfx-${name}-`);
  const repoDir = join(root, "workspace");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# temp repo\n");
  execFileSync("git", ["init"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  return repoDir;
}

function readJsonLines(filePath) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function logFixtureEvents(adapter) {
  await adapter.logEvent({
    skill: "plan",
    event: "start",
    branch: "main",
    session: "sess-1",
  });
  await adapter.logEvent({
    skill: "plan",
    event: "finish",
    branch: "main",
    session: "sess-1",
    outcome: "ok",
    durationS: 3,
  });
  await adapter.logEvent({
    skill: "review",
    event: "start",
    branch: "feature/x",
    session: "sess-2",
  });
}

afterEach(() => {
  while (RESTORES.length > 0) {
    RESTORES.pop()();
  }

  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("hub/lib/timeline-adapter.mjs", () => {
  it("nullTimelineAdapter는 .omc/timeline.jsonl에 기록하고 최근 이벤트를 순서대로 반환한다", async () => {
    const repoDir = createGitRepo("null-adapter");
    pushCwd(repoDir);

    await logFixtureEvents(nullTimelineAdapter);

    const recent = await nullTimelineAdapter.readRecent(10);
    assert.equal(recent.length, 3);
    assert.deepEqual(
      recent.map((entry) => entry.event),
      ["start", "finish", "start"],
    );

    const filePath = join(repoDir, ".omc", "timeline.jsonl");
    assert.equal(readJsonLines(filePath).length, 3);
  });

  it("gstackTimelineAdapter는 ~/.gstack/projects/{slug}/timeline.jsonl에 기록하고 getLastSession을 필터링한다", async () => {
    const repoDir = createGitRepo("gstack-adapter");
    const homeDir = registerTempDir("tfx-home-");
    const slug = "workspace";
    const gstackProjectDir = join(homeDir, ".gstack", "projects", slug);
    mkdirSync(gstackProjectDir, { recursive: true });

    pushCwd(repoDir);
    setHomeDir(homeDir);

    await logFixtureEvents(gstackTimelineAdapter);
    const recent = await gstackTimelineAdapter.readRecent(10);

    assert.equal(recent.length, 3);
    assert.deepEqual(
      recent.map((entry) => entry.skill),
      ["plan", "plan", "review"],
    );

    const lastMain = await gstackTimelineAdapter.getLastSession({
      branch: "main",
    });
    assert.equal(lastMain?.session, "sess-1");
    assert.equal(lastMain?.event, "finish");

    const lastPlan = await gstackTimelineAdapter.getLastSession({
      branch: "main",
      skill: "plan",
    });
    assert.equal(lastPlan?.session, "sess-1");

    const missing = await gstackTimelineAdapter.getLastSession({
      branch: "main",
      skill: "review",
    });
    assert.equal(missing, null);

    const filePath = join(gstackProjectDir, "timeline.jsonl");
    assert.equal(readJsonLines(filePath).length, 3);
  });

  it("detectAdapter는 ~/.gstack 존재 여부에 따라 kind를 선택한다", () => {
    const repoDir = createGitRepo("detect-adapter");
    const noGstackHome = registerTempDir("tfx-no-gstack-");
    pushCwd(repoDir);
    setHomeDir(noGstackHome);

    const fallback = detectAdapter();
    assert.equal(fallback.kind, "null");
    assert.equal(fallback.adapter, nullTimelineAdapter);

    const gstackHome = registerTempDir("tfx-with-gstack-");
    mkdirSync(join(gstackHome, ".gstack"), { recursive: true });
    setHomeDir(gstackHome);

    const detected = detectAdapter();
    assert.equal(detected.kind, "gstack");
    assert.equal(detected.adapter, gstackTimelineAdapter);
  });
});
