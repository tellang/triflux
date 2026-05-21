import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeRosterWorkers } from "../../hub/team/claude-native-bridge.mjs";

test("mergeRosterWorkers preserves concurrent roster updates", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-roster-race-"));
  const rosterPath = path.join(tmp, "claude", "daemon", "roster.json");
  const workers = Array.from({ length: 24 }, (_, index) => ({
    short: `w${index}`,
    entry: { pid: 1000 + index, sessionId: `session-${index}` },
  }));

  await Promise.all(
    workers.map(({ short, entry }) =>
      mergeRosterWorkers(rosterPath, { [short]: entry }),
    ),
  );

  const roster = JSON.parse(await fs.readFile(rosterPath, "utf8"));
  assert.deepEqual(
    Object.keys(roster.workers).sort(),
    workers.map(({ short }) => short).sort(),
  );

  await fs.rm(tmp, { recursive: true, force: true });
});
