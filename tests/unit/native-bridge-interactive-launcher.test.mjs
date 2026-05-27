import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { launchAdoptedInteractiveWorker } from "../../hub/team/interactive-native-launcher.mjs";

function createLauncherFakes({ rosterPath, startedWorker } = {}) {
  const calls = {
    start: [],
    build: [],
    merge: [],
    workerClose: 0,
  };
  const worker = {
    pid: 4242,
    async close() {
      calls.workerClose += 1;
    },
    ...startedWorker,
  };
  const deps = {
    async startInteractiveNativeWorker(options) {
      calls.start.push(options);
      return {
        short: options.short,
        rvSock: options.rvSock,
        ptySock: options.ptySock,
        pid: options.pid,
        ...worker,
      };
    },
    buildNativeWorkerRosterEntry(options) {
      calls.build.push(options);
      return {
        built: true,
        short: options.short,
        pid: options.pid,
        rendezvousSock: options.rendezvousSock,
        ptySock: options.ptySock,
        name: options.name,
      };
    },
    async mergeRosterWorkers(pathname, workers) {
      calls.merge.push({ rosterPath: pathname, workers });
      await fs.mkdir(path.dirname(pathname), { recursive: true });
      let roster = { proto: 1, supervisorPid: 0, updatedAt: 1, workers: {} };
      try {
        roster = JSON.parse(await fs.readFile(pathname, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      roster.workers = { ...(roster.workers || {}), ...workers };
      await fs.writeFile(pathname, `${JSON.stringify(roster, null, 2)}\n`);
      return roster;
    },
    deriveClaudeDaemonPaths() {
      return { rosterPath };
    },
  };
  return { calls, deps, worker };
}

test("launchAdoptedInteractiveWorker starts an interactive worker and registers a roster adoption entry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-int-launch-"));
  const rosterPath = path.join(tmp, "claude", "daemon", "roster.json");
  const { calls, deps } = createLauncherFakes({ rosterPath });

  const handle = await launchAdoptedInteractiveWorker({
    cwd: "/tmp/project",
    sessionName: "tfx-session",
    launchCmd: "codex --profile gpt55_low",
    cli: "codex",
    role: "executor",
    configDir: path.join(tmp, "claude"),
    pid: 4242,
    _deps: deps,
  });

  assert.match(handle.short, /^[a-f0-9]{8}$/);
  assert.equal(handle.displayName, "Triflux codex executor");
  assert.equal(handle.rosterPath, rosterPath);
  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].short, handle.short);
  assert.equal(calls.start[0].sessionName, "tfx-session");
  assert.equal(calls.start[0].cwd, "/tmp/project");
  assert.equal(calls.start[0].launchCmd, "codex --profile gpt55_low");
  assert.equal(calls.start[0].pid, 4242);
  assert.ok(calls.start[0].rvSock.endsWith(`${handle.short}.rv.sock`));
  assert.ok(calls.start[0].ptySock.endsWith(`${handle.short}.pty.sock`));

  assert.deepEqual(calls.build, [
    {
      short: handle.short,
      pid: 4242,
      cwd: "/tmp/project",
      rendezvousSock: calls.start[0].rvSock,
      ptySock: calls.start[0].ptySock,
      name: "Triflux codex executor",
      prompt: "Triflux codex executor",
    },
  ]);
  assert.deepEqual(calls.merge, [
    {
      rosterPath,
      workers: {
        [handle.short]: {
          built: true,
          short: handle.short,
          pid: 4242,
          rendezvousSock: calls.start[0].rvSock,
          ptySock: calls.start[0].ptySock,
          name: "Triflux codex executor",
        },
      },
    },
  ]);

  await handle.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test("launchAdoptedInteractiveWorker close removes only its roster key and is idempotent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-int-close-"));
  const rosterPath = path.join(tmp, "claude", "daemon", "roster.json");
  await fs.mkdir(path.dirname(rosterPath), { recursive: true });
  await fs.writeFile(
    rosterPath,
    `${JSON.stringify({
      proto: 1,
      supervisorPid: 123,
      updatedAt: 1,
      workers: { existing: { pid: 1, sessionId: "existing" } },
    })}\n`,
  );
  const { calls, deps } = createLauncherFakes({ rosterPath });

  const handle = await launchAdoptedInteractiveWorker({
    cwd: "/tmp/project",
    sessionName: "tfx-session",
    configDir: path.join(tmp, "claude"),
    pid: 4242,
    _deps: deps,
  });

  let roster = JSON.parse(await fs.readFile(rosterPath, "utf8"));
  assert.ok(roster.workers.existing);
  assert.ok(roster.workers[handle.short]);

  await handle.close();
  await handle.close();

  roster = JSON.parse(await fs.readFile(rosterPath, "utf8"));
  assert.ok(roster.workers.existing);
  assert.equal(roster.workers[handle.short], undefined);
  assert.equal(calls.workerClose, 1);

  await fs.rm(tmp, { recursive: true, force: true });
});
