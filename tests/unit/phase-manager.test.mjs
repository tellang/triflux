import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  coerceLegacyPhase,
  PHASE_ENUM,
  PHASE_STATUS,
  readPhase,
  syncToGstack,
  writePhase,
} from "../../hub/lib/phase-manager.mjs";

const TEMP_DIRS = [];
const RESTORES = [];

function registerTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function setupWorkspace(prefix = "tfx-phase-manager-") {
  const root = registerTempDir(prefix);
  pushCwd(root);
  return root;
}

function fullcycleStatePath(root, runId) {
  return join(root, ".tfx", "fullcycle", runId, "state.json");
}

function phaseFilePath(root, runId) {
  return join(root, ".tfx", "phases", `${runId}.json`);
}

afterEach(() => {
  while (RESTORES.length > 0) {
    RESTORES.pop()();
  }

  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("hub/lib/phase-manager.mjs", () => {
  it("exports the expected enums", () => {
    assert.deepEqual(PHASE_ENUM, [
      "Research",
      "Strategy",
      "Execution",
      "Validation",
    ]);
    assert.deepEqual(PHASE_STATUS, ["active", "complete", "failed"]);
  });

  it("readPhase reads explicit phase fields from state.json", async () => {
    const root = setupWorkspace();
    const runId = "run-explicit";

    writeJson(fullcycleStatePath(root, runId), {
      run_id: runId,
      phase: "Execution",
      phase_status: "failed",
      last_phase: "Strategy",
      untouched: true,
    });

    const result = await readPhase(runId);
    assert.deepEqual(result, {
      phase: "Execution",
      phaseStatus: "failed",
      lastPhase: "Strategy",
    });
  });

  it("readPhase coerces legacy current_phase when phase is missing", async () => {
    const root = setupWorkspace();
    const runId = "run-legacy";
    const statePath = fullcycleStatePath(root, runId);

    writeJson(statePath, {
      run_id: runId,
      current_phase: "phase2-plan",
      last_successful_phase: "phase1-research",
      untouched: "keep",
    });

    const result = await readPhase(runId);
    assert.deepEqual(result, {
      phase: "Strategy",
      phaseStatus: "active",
      lastPhase: "Research",
    });

    const migrated = readJson(statePath);
    assert.equal(migrated.phase, "Strategy");
    assert.equal(migrated.phase_status, "active");
    assert.equal(migrated.last_phase, "Research");
    assert.equal(migrated.current_phase, "strategy");
    assert.equal(migrated.last_successful_phase, "research");
    assert.equal(migrated.untouched, "keep");
  });

  it("readPhase returns null when no state file exists", async () => {
    const root = setupWorkspace();
    const result = await readPhase("missing-run");
    assert.equal(result, null);
    assert.equal(root.includes("tfx-phase-manager-"), true);
  });

  it("readPhase falls back to .tfx/phases/{runId}.json when fullcycle state is absent", async () => {
    const root = setupWorkspace();
    const runId = "session-123";

    writeJson(phaseFilePath(root, runId), {
      run_id: runId,
      phase: "Validation",
      phase_status: "active",
      last_phase: "Execution",
    });

    const result = await readPhase(runId);
    assert.deepEqual(result, {
      phase: "Validation",
      phaseStatus: "active",
      lastPhase: "Execution",
    });
  });

  it("writePhase writes valid enum/status values and preserves other fields", async () => {
    const root = setupWorkspace();
    const runId = "run-write";
    const statePath = fullcycleStatePath(root, runId);

    writeJson(statePath, {
      run_id: runId,
      untouched: 42,
      last_successful_phase: "research",
      nested: { keep: true },
    });

    await writePhase(runId, "Execution");

    const state = readJson(statePath);
    assert.equal(state.phase, "Execution");
    assert.equal(state.phase_status, "active");
    assert.equal(state.current_phase, "execution");
    assert.equal(state.last_successful_phase, "research");
    assert.deepEqual(state.nested, { keep: true });
    assert.equal(state.untouched, 42);
  });

  it("writePhase updates last phase fields when status is complete", async () => {
    const root = setupWorkspace();
    const runId = "run-complete";
    const statePath = fullcycleStatePath(root, runId);

    writeJson(statePath, {
      run_id: runId,
      last_successful_phase: "strategy",
    });

    await writePhase(runId, "Validation", "complete");

    const state = readJson(statePath);
    assert.equal(state.phase, "Validation");
    assert.equal(state.phase_status, "complete");
    assert.equal(state.last_phase, "Validation");
    assert.equal(state.current_phase, "validation");
    assert.equal(state.last_successful_phase, "validation");
  });

  it("writePhase throws for invalid phases", async () => {
    setupWorkspace();
    await assert.rejects(
      writePhase("run-invalid-phase", "Unknown"),
      /invalid phase/i,
    );
  });

  it("writePhase throws for invalid statuses", async () => {
    setupWorkspace();
    await assert.rejects(
      writePhase("run-invalid-status", "Research", "paused"),
      /invalid phase status/i,
    );
  });

  it("writePhase falls back to .tfx/phases/{runId}.json when fullcycle state is absent", async () => {
    const root = setupWorkspace();
    const runId = "session-write";
    const phasePath = phaseFilePath(root, runId);

    writeJson(phasePath, {
      run_id: runId,
      extra: "keep",
    });

    await writePhase(runId, "Strategy", "failed");

    const state = readJson(phasePath);
    assert.equal(state.phase, "Strategy");
    assert.equal(state.phase_status, "failed");
    assert.equal(state.current_phase, "strategy");
    assert.equal(state.extra, "keep");
  });

  it("syncToGstack is a no-op when ~/.gstack is missing", async () => {
    const root = setupWorkspace();
    const homeDir = registerTempDir("tfx-no-gstack-home-");
    setHomeDir(homeDir);

    writeJson(fullcycleStatePath(root, "run-noop"), {
      run_id: "run-noop",
      phase: "Research",
      phase_status: "active",
    });

    await assert.doesNotReject(syncToGstack("run-noop", "triflux"));
    assert.equal(
      readFileSync(fullcycleStatePath(root, "run-noop"), "utf8").length > 0,
      true,
    );
  });

  it("syncToGstack injects phase and triflux_run_id into the latest checkpoint frontmatter", async () => {
    const root = setupWorkspace();
    const homeDir = registerTempDir("tfx-gstack-home-");
    const slug = "triflux";
    const runId = "run-sync";
    const checkpointsDir = join(
      homeDir,
      ".gstack",
      "projects",
      slug,
      "checkpoints",
    );
    const olderPath = join(checkpointsDir, "older.md");
    const latestPath = join(checkpointsDir, "latest.md");

    setHomeDir(homeDir);
    mkdirSync(checkpointsDir, { recursive: true });
    writeJson(fullcycleStatePath(root, runId), {
      run_id: runId,
      phase: "Execution",
      phase_status: "active",
    });

    writeFileSync(
      olderPath,
      "---\nstatus: in-progress\nbranch: main\n---\nold\n",
      "utf8",
    );
    writeFileSync(
      latestPath,
      "---\nstatus: in-progress\nbranch: feature/phase\n---\nnew\n",
      "utf8",
    );

    const now = new Date();
    utimesSync(olderPath, now, new Date(now.getTime() - 10_000));
    utimesSync(latestPath, now, new Date(now.getTime() + 10_000));

    await syncToGstack(runId, slug);

    const updated = readFileSync(latestPath, "utf8");
    assert.match(updated, /^---\r?\n/m);
    assert.match(updated, /phase: Execution/);
    assert.match(updated, /triflux_run_id: run-sync/);

    const older = readFileSync(olderPath, "utf8");
    assert.doesNotMatch(older, /triflux_run_id:/);
  });

  it("syncToGstack skips when no checkpoint markdown files exist", async () => {
    const root = setupWorkspace();
    const homeDir = registerTempDir("tfx-empty-gstack-home-");
    const slug = "triflux";
    const runId = "run-empty";

    setHomeDir(homeDir);
    mkdirSync(join(homeDir, ".gstack", "projects", slug, "checkpoints"), {
      recursive: true,
    });
    writeJson(fullcycleStatePath(root, runId), {
      run_id: runId,
      phase: "Validation",
      phase_status: "active",
    });

    await assert.doesNotReject(syncToGstack(runId, slug));
  });

  it("coerceLegacyPhase maps research, strategy, execution, validation, complete and unknown cases", () => {
    assert.equal(coerceLegacyPhase("phase1-interview"), "Research");
    assert.equal(coerceLegacyPhase("strategy review"), "Strategy");
    assert.equal(coerceLegacyPhase("phase4-ship"), "Execution");
    assert.equal(coerceLegacyPhase("phase5-qa"), "Validation");
    assert.equal(coerceLegacyPhase("complete"), "complete");
    assert.equal(coerceLegacyPhase("something-else"), null);
  });

  it("writePhase uses atomic replacement so concurrent readers only observe valid JSON", async () => {
    const root = setupWorkspace();
    const runId = "run-atomic";
    const statePath = fullcycleStatePath(root, runId);

    writeJson(statePath, {
      run_id: runId,
      untouched: "x".repeat(50_000),
      last_successful_phase: "research",
    });

    const readErrors = [];
    let stop = false;

    const reader = (async () => {
      while (!stop) {
        try {
          const raw = await readFile(statePath, "utf8");
          JSON.parse(raw);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            readErrors.push(error);
          }
        }
      }
    })();

    for (let index = 0; index < 25; index += 1) {
      const phase = index % 2 === 0 ? "Execution" : "Validation";
      const status = index % 3 === 0 ? "complete" : "active";
      await writePhase(runId, phase, status);
    }

    stop = true;
    await reader;

    const finalState = readJson(statePath);
    assert.equal(readErrors.length, 0);
    assert.doesNotThrow(() => JSON.stringify(finalState));
    assert.equal(finalState.untouched.length, 50_000);
  });
});
