import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeSessionProjection,
  findClaudeSessionProjectionBySessionId,
  refreshClaudeSessionProjectionCwd,
  removeClaudeSessionProjection,
  writeClaudeSessionProjection,
} from "../../hub/team/claude-session-projection.mjs";

test("buildClaudeSessionProjection matches Claude background session shape", () => {
  const projection = buildClaudeSessionProjection({
    pid: 1234,
    procStart: "Wed May 20 08:02:53 2026",
    sessionId: "abcd1234-1111-2222-3333-444444444444",
    short: "abcd1234",
    cwd: "/tmp/project",
    name: "Triflux codex executor",
    agent: "codex",
    startedAt: 10,
    updatedAt: 20,
  });

  assert.deepEqual(projection, {
    pid: 1234,
    sessionId: "abcd1234-1111-2222-3333-444444444444",
    cwd: "/tmp/project",
    startedAt: 10,
    procStart: "Wed May 20 08:02:53 2026",
    version: "triflux-native-bridge",
    peerProtocol: 1,
    kind: "bg",
    entrypoint: "cli",
    name: "Triflux codex executor",
    agent: "codex",
    jobId: "abcd1234",
    status: "busy",
    updatedAt: 20,
    bridgeSessionId: "session_abcd1234",
  });
});

test("buildClaudeSessionProjection normalizes daemon cse bridge session ids", () => {
  const projection = buildClaudeSessionProjection({
    pid: 1234,
    procStart: "Wed May 20 08:02:53 2026",
    sessionId: "abcd1234-1111-2222-3333-444444444444",
    short: "abcd1234",
    cwd: "/tmp/project",
    name: "Triflux antigravity executor",
    agent: "antigravity",
    bridgeSessionId: "cse_01L6zfB6z3LxWqsQcB6kZmoA",
  });

  assert.equal(projection.bridgeSessionId, "session_01L6zfB6z3LxWqsQcB6kZmoA");
});

test("writeClaudeSessionProjection writes pid-named JSON and remove deletes only that file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-session-proj-"));
  const sessionsDir = path.join(tmp, "sessions");
  const projection = buildClaudeSessionProjection({
    pid: 4567,
    procStart: "Wed May 20 08:02:53 2026",
    sessionId: "feedface-1111-2222-3333-444444444444",
    short: "feedface",
    cwd: "/tmp/project",
    name: "Triflux gemini reviewer",
    agent: "gemini",
    startedAt: 100,
    updatedAt: 200,
  });

  const sessionPath = await writeClaudeSessionProjection(
    sessionsDir,
    projection,
  );
  const parsed = JSON.parse(await fs.readFile(sessionPath, "utf8"));

  assert.equal(sessionPath, path.join(sessionsDir, "4567.json"));
  assert.deepEqual(parsed, projection);

  await removeClaudeSessionProjection(sessionPath);
  await assert.rejects(() => fs.access(sessionPath), /ENOENT/);
  await fs.rm(tmp, { recursive: true, force: true });
});

test("findClaudeSessionProjectionBySessionId scans pid-named projection files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-proj-find-"));
  const sessionsDir = path.join(tmp, "sessions");
  const projection = buildClaudeSessionProjection({
    pid: 9999,
    procStart: "Wed May 20 08:02:53 2026",
    sessionId: "find-session-1",
    short: "findsess",
    cwd: "/tmp/old",
    name: "Triflux cwd test",
    agent: "claude",
  });
  const sessionPath = await writeClaudeSessionProjection(
    sessionsDir,
    projection,
  );

  const found = await findClaudeSessionProjectionBySessionId(
    sessionsDir,
    "find-session-1",
  );
  assert.equal(found.path, sessionPath);
  assert.equal(found.projection.cwd, "/tmp/old");

  await fs.rm(tmp, { recursive: true, force: true });
});

test("refreshClaudeSessionProjectionCwd updates cwd and updatedAt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-proj-refresh-"));
  const sessionsDir = path.join(tmp, "sessions");
  const projection = buildClaudeSessionProjection({
    pid: 10001,
    procStart: "Wed May 20 08:02:53 2026",
    sessionId: "refresh-session-1",
    short: "refresh1",
    cwd: "/tmp/old",
    name: "Triflux cwd refresh",
    agent: "claude",
    updatedAt: 10,
  });
  const sessionPath = await writeClaudeSessionProjection(
    sessionsDir,
    projection,
  );

  const result = await refreshClaudeSessionProjectionCwd({
    sessionsDir,
    sessionId: "refresh-session-1",
    cwd: "/tmp/new",
    updatedAt: 12345,
  });

  assert.equal(result.updated, true);
  assert.equal(result.path, sessionPath);
  assert.equal(result.projection.cwd, "/tmp/new");
  assert.equal(result.projection.updatedAt, 12345);

  await fs.rm(tmp, { recursive: true, force: true });
});
