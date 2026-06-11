import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeDaemonDiscoveryCandidates,
  deriveClaudeDaemonPaths as deriveFromControl,
  detectCallerProvenance,
  findDaemonJobBySessionId,
  readOmcLaunchProfile,
  resolveClaudeConfigDir,
  resolveClaudeHomeDir,
} from "../../hub/team/claude-daemon-control.mjs";
import {
  deriveClaudeDaemonPaths as deriveFromBridge,
  resolveClaudeConfigDir as resolveConfigDirFromBridge,
} from "../../hub/team/claude-native-bridge.mjs";

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

// configDir 해석이 모듈마다 갈리면 control.sock hash split-brain 이 생긴다
// (probe 는 daemon-control, dispatch/roster 는 native-bridge). 단일 owner 강제.
test("native-bridge re-exports the canonical resolveClaudeConfigDir (same implementation)", () => {
  assert.equal(resolveConfigDirFromBridge, resolveClaudeConfigDir);
});

test("resolveClaudeHomeDir prefers HOME on POSIX and falls back to os.homedir()", () => {
  assert.equal(
    resolveClaudeHomeDir({ HOME: "/posix/home" }, "darwin"),
    path.resolve("/posix/home"),
  );
  assert.equal(
    resolveClaudeHomeDir({ HOME: "/posix/home" }, "linux"),
    path.resolve("/posix/home"),
  );
  // 빈 HOME 은 미설정과 동일하게 취급
  assert.equal(resolveClaudeHomeDir({ HOME: "  " }, "darwin"), os.homedir());
});

test("resolveClaudeHomeDir prefers USERPROFILE over divergent HOME on win32", () => {
  // win32 daemon launcher 의 os.homedir() 는 USERPROFILE 기반 — git-bash 가
  // HOME 을 따로 잡아도 socket hash 는 daemon 쪽(USERPROFILE)과 일치해야 한다.
  const env = { HOME: "/c/Users/x", USERPROFILE: "/win/profile" };
  assert.equal(
    resolveClaudeHomeDir(env, "win32"),
    path.resolve("/win/profile"),
  );
  // USERPROFILE 미설정이면 HOME 으로 폴백
  assert.equal(
    resolveClaudeHomeDir({ HOME: "/c/Users/x" }, "win32"),
    path.resolve("/c/Users/x"),
  );
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

test("detectCallerProvenance distinguishes vanilla Codex from OMX caller env", () => {
  assert.deepEqual(detectCallerProvenance({ CODEX_THREAD_ID: "thread-1" }), {
    claudeLauncher: "unknown",
    codexLauncher: "codex",
    signals: {
      claudeConfigDir: null,
      omxSessionId: null,
      omxEntryPath: null,
      codexThreadId: "thread-1",
    },
  });

  assert.deepEqual(
    detectCallerProvenance({
      CODEX_THREAD_ID: "thread-1",
      OMX_SESSION_ID: "omx-123",
      OMX_ENTRY_PATH:
        "/opt/homebrew/lib/node_modules/oh-my-codex/dist/cli/omx.js",
    }),
    {
      claudeLauncher: "unknown",
      codexLauncher: "omx",
      signals: {
        claudeConfigDir: null,
        omxSessionId: "omx-123",
        omxEntryPath:
          "/opt/homebrew/lib/node_modules/oh-my-codex/dist/cli/omx.js",
        codexThreadId: "thread-1",
      },
    },
  );
});

test("readOmcLaunchProfile requires a valid sourceConfigDir marker", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-omc-profile-"));
  const runtime = path.join(home, ".claude", ".omc-launch");
  const defaultConfig = path.join(home, ".claude");
  const malformed = path.join(home, "malformed-omc");
  const invalid = path.join(home, "invalid-omc");
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(malformed, { recursive: true });
  await fs.mkdir(invalid, { recursive: true });
  await fs.writeFile(
    path.join(runtime, ".omc-launch-profile.json"),
    JSON.stringify({
      sourceConfigDir: defaultConfig,
      sourceClaudeMd: path.join(defaultConfig, "CLAUDE-omc.md"),
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(malformed, ".omc-launch-profile.json"),
    "{",
    "utf8",
  );
  await fs.writeFile(
    path.join(invalid, ".omc-launch-profile.json"),
    JSON.stringify({ sourceConfigDir: "" }),
    "utf8",
  );

  try {
    assert.deepEqual(await readOmcLaunchProfile(runtime), {
      sourceConfigDir: defaultConfig,
      sourceClaudeMd: path.join(defaultConfig, "CLAUDE-omc.md"),
    });
    assert.equal(await readOmcLaunchProfile(defaultConfig), null);
    assert.equal(await readOmcLaunchProfile(malformed), null);
    assert.equal(await readOmcLaunchProfile(invalid), null);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("buildClaudeDaemonDiscoveryCandidates uses exact, env-strict, and ambient modes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-daemon-home-"));
  const base = path.join(home, ".claude");
  const omcRuntime = path.join(base, ".omc-launch");
  const explicit = path.join(home, "custom-claude");
  await fs.mkdir(omcRuntime, { recursive: true });
  await fs.writeFile(
    path.join(omcRuntime, ".omc-launch-profile.json"),
    JSON.stringify({
      sourceConfigDir: base,
      sourceClaudeMd: path.join(base, "CLAUDE-omc.md"),
    }),
    "utf8",
  );

  try {
    const ambient = await buildClaudeDaemonDiscoveryCandidates({
      env: { HOME: home, CODEX_THREAD_ID: "thread", OMX_SESSION_ID: "omx" },
      uid: 501,
      tmpRoot: "/tmp",
    });
    assert.deepEqual(
      ambient.map((candidate) => ({
        source: candidate.configDirSource,
        mode: candidate.selectionMode,
        launcher: candidate.claudeLauncher,
        dir: candidate.configDir,
        codex: candidate.callerProvenance.codexLauncher,
        sourceConfigDir: candidate.sourceConfigDir ?? null,
      })),
      [
        {
          source: "omc-runtime",
          mode: "ambient",
          launcher: "omc",
          dir: omcRuntime,
          codex: "omx",
          sourceConfigDir: base,
        },
        {
          source: "default",
          mode: "ambient",
          launcher: "claude",
          dir: base,
          codex: "omx",
          sourceConfigDir: null,
        },
      ],
    );

    const exact = await buildClaudeDaemonDiscoveryCandidates({
      configDir: explicit,
      env: { HOME: home, CLAUDE_CONFIG_DIR: omcRuntime },
      uid: 501,
      tmpRoot: "/tmp",
    });
    assert.deepEqual(
      exact.map((candidate) => ({
        source: candidate.configDirSource,
        mode: candidate.selectionMode,
        launcher: candidate.claudeLauncher,
        dir: candidate.configDir,
      })),
      [
        {
          source: "explicit",
          mode: "exact",
          launcher: "unknown",
          dir: path.resolve(explicit),
        },
      ],
    );

    const envStrict = await buildClaudeDaemonDiscoveryCandidates({
      env: { HOME: home, CLAUDE_CONFIG_DIR: omcRuntime },
      uid: 501,
      tmpRoot: "/tmp",
    });
    assert.deepEqual(
      envStrict.map((candidate) => ({
        source: candidate.configDirSource,
        mode: candidate.selectionMode,
        launcher: candidate.claudeLauncher,
        dir: candidate.configDir,
        sourceConfigDir: candidate.sourceConfigDir ?? null,
      })),
      [
        {
          source: "env",
          mode: "env-strict",
          launcher: "omc",
          dir: omcRuntime,
          sourceConfigDir: base,
        },
      ],
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("findDaemonJobBySessionId preserves all supported Claude daemon id shapes", () => {
  const jobs = [
    { short: "a", session_id: "legacy-session" },
    { short: "b", dispatch: { sessionId: "dispatch-session" } },
    { short: "c", d: { sessionId: "compact-session" } },
    { short: "d", sessionId: "camel-session" },
  ];

  assert.equal(
    findDaemonJobBySessionId({ jobs }, "legacy-session")?.short,
    "a",
  );
  assert.equal(
    findDaemonJobBySessionId({ jobs }, "dispatch-session")?.short,
    "b",
  );
  assert.equal(
    findDaemonJobBySessionId({ jobs }, "compact-session")?.short,
    "c",
  );
  assert.equal(findDaemonJobBySessionId({ jobs }, "camel-session")?.short, "d");
});
