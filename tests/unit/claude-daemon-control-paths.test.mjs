import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveClaudeDaemonPaths as deriveFromControl } from "../../hub/team/claude-daemon-control.mjs";
import { deriveClaudeDaemonPaths as deriveFromBridge } from "../../hub/team/claude-native-bridge.mjs";

// daemon-control 이 단일 owner 이고 native-bridge 는 그것을 re-export 한다.
test("deriveClaudeDaemonPaths returns the superset incl rendezvousDir+ptyDir+hash", () => {
  const configDir = path.join(os.tmpdir(), "claude-paths-superset");
  const hash = crypto
    .createHash("sha256")
    .update(path.resolve(configDir))
    .digest("hex")
    .slice(0, 8);

  const paths = deriveFromControl({ configDir, uid: 501, tmpRoot: "/tmp" });

  assert.equal(paths.configDir, path.resolve(configDir));
  assert.equal(paths.hash, hash);
  assert.equal(paths.daemonDir, `/tmp/cc-daemon-501/${hash}`);
  assert.equal(paths.controlSock, `/tmp/cc-daemon-501/${hash}/control.sock`);
  // native-bridge 가 추가로 의존하던 필드들이 이제 canonical owner 에 포함된다.
  assert.equal(paths.rendezvousDir, `/tmp/cc-daemon-501/${hash}/rv`);
  assert.equal(paths.ptyDir, `/tmp/cc-daemon-501/${hash}/pty`);
  assert.equal(
    paths.rosterPath,
    path.join(path.resolve(configDir), "daemon", "roster.json"),
  );
  assert.equal(
    paths.sessionsDir,
    path.join(path.resolve(configDir), "sessions"),
  );
  assert.equal(paths.jobsDir, path.join(path.resolve(configDir), "jobs"));
});

test("native-bridge re-exports the canonical deriveClaudeDaemonPaths (same implementation)", () => {
  assert.equal(deriveFromBridge, deriveFromControl);
});

test("parity: derived field set covers what both former callsites needed", () => {
  const paths = deriveFromControl({
    configDir: path.join(os.tmpdir(), "claude-paths-parity"),
    uid: 501,
    tmpRoot: "/tmp",
  });
  // headless(deriveClaudeControlPaths) 가 읽던 필드
  const headlessNeeds = ["controlSock", "sessionsDir", "jobsDir"];
  // native-bridge 가 읽던 필드 (interactive 브랜치 포함)
  const bridgeNeeds = [
    "configDir",
    "daemonDir",
    "controlSock",
    "rendezvousDir",
    "ptyDir",
    "rosterPath",
    "sessionsDir",
    "jobsDir",
  ];
  for (const key of [...headlessNeeds, ...bridgeNeeds]) {
    assert.ok(
      Object.hasOwn(paths, key),
      `expected derived paths to include ${key}`,
    );
  }
});
