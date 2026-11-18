import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runAgyLeadHook } from "../../adapters/agy/plugins/triflux/hooks/agy-lead-hook.mjs";
import {
  agyCli,
  ensureAgyPlugin,
  inspectAgyPlugin,
} from "../../scripts/setup.mjs";

const HOOK_PATH = resolve(
  import.meta.dirname,
  "../../adapters/agy/plugins/triflux/hooks/agy-lead-hook.mjs",
);

const tempDirs = [];

function makeStateRoot() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-agy-lead-hook-"));
  tempDirs.push(dir);
  return join(dir, "triflux");
}

function writeMarker(stateRoot, name, record) {
  const dir = join(stateRoot, "lead-roles");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.json`);
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

function writeContext(stateRoot, conversationId, record) {
  const dir = join(stateRoot, "agy-context");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${conversationId}.json`);
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agy-lead-hook: 표지 매칭과 SessionStart", () => {
  it("paneId, conversationId, workspacePaths 순서로 활성 표지를 찾고 인계 파일을 1회 주입한다", async () => {
    const stateRoot = makeStateRoot();
    const workspaceDir = join(stateRoot, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    writeMarker(stateRoot, "worker-ignored", {
      session: "worker-1",
      paneId: "%1",
      cli: "agy",
      sessionRole: "worker",
      cwd: workspaceDir,
      pendingHandoff: { path: "/tmp/ignored.md" },
    });

    const markerPath = writeMarker(stateRoot, "lead-main", {
      session: "lead-main",
      paneId: "%9",
      cli: "agy",
      sessionRole: "lead",
      cwd: workspaceDir,
      conversationId: null,
      pendingHandoff: { path: "/tmp/handoff-lead.md" },
    });

    const first = await runAgyLeadHook(
      {
        hookEventName: "SessionStart",
        conversationId: "conv-100",
        workspacePaths: [workspaceDir],
      },
      {
        mode: "start",
        stateRoot,
        env: { TMUX_PANE: "" },
      },
    );

    assert.deepEqual(first, {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              "[tfx-lead] 인계 파일 /tmp/handoff-lead.md 를 읽고 역할을 이어간다.",
          },
        },
      ],
    });

    const saved = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(saved.conversationId, "conv-100");
    assert.equal(saved.pendingHandoff, null);

    const second = await runAgyLeadHook(
      {
        hookEventName: "SessionStart",
        conversationId: "conv-100",
      },
      {
        mode: "start",
        stateRoot,
        env: { TMUX_PANE: "%99" },
      },
    );
    assert.deepEqual(second, {});
  });
});

describe("agy-lead-hook: PreInvocation 메모리 압박 감시", () => {
  it("macOS에서 압박 단계가 warn(2) 또는 critical(4)로 바뀔 때만 주입한다", async () => {
    const stateRoot = makeStateRoot();
    writeMarker(stateRoot, "comm-main", {
      session: "comm-main",
      paneId: "%3",
      cli: "agy",
      sessionRole: "communication",
      cwd: "/tmp",
    });

    const env = { TMUX_PANE: "%3" };
    let currentLevel = 1;
    const opts = {
      mode: "pre",
      stateRoot,
      env,
      platform: "darwin",
      readPressureLevel: () => String(currentLevel),
    };

    assert.deepEqual(await runAgyLeadHook({}, opts), {});

    currentLevel = 2;
    assert.deepEqual(await runAgyLeadHook({}, opts), {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              "[tfx-pressure] macOS 메모리 압박 단계가 warn(2)로 바뀌었다. 새 워커 생성을 줄이고 끝난 워커를 닫아라.",
          },
        },
      ],
      terminationBehavior: "",
    });

    assert.deepEqual(await runAgyLeadHook({}, opts), {});

    currentLevel = 4;
    assert.deepEqual(await runAgyLeadHook({}, opts), {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              "[tfx-pressure] macOS 메모리 압박 단계가 critical(4)로 바뀌었다. 새 워커 생성을 줄이고 끝난 워커를 닫아라.",
          },
        },
      ],
      terminationBehavior: "",
    });

    assert.deepEqual(
      await runAgyLeadHook({}, { ...opts, platform: "linux" }),
      {},
    );
  });
});

describe("agy-lead-hook: Stop 승계 가드", () => {
  it("조기 허용 조건을 지키고 85% 이상일 때 대화당 1회만 continue를 반환한다", async () => {
    const stateRoot = makeStateRoot();
    const markerPath = writeMarker(stateRoot, "lead-stop", {
      session: "lead-stop",
      paneId: "%5",
      cli: "agy",
      sessionRole: "lead",
      cwd: "/tmp",
      conversationId: "conv-stop-1",
      notifiedConversationId: null,
      notifiedThreshold: 0,
    });
    writeContext(stateRoot, "conv-stop-1", {
      conversationId: "conv-stop-1",
      usedPercentage: 86.4,
      windowSize: 200000,
      usedTokens: 172800,
    });

    const env = { TMUX_PANE: "%5" };

    for (const payload of [
      {
        conversationId: "conv-stop-1",
        continuationActive: true,
        fullyIdle: true,
      },
      {
        conversationId: "conv-stop-1",
        continuationActive: false,
        fullyIdle: false,
      },
      {
        conversationId: "conv-stop-1",
        continuationActive: false,
        fullyIdle: true,
        terminationReason: "USER_CANCELLED",
      },
    ]) {
      assert.deepEqual(
        await runAgyLeadHook(payload, { mode: "stop", stateRoot, env }),
        { decision: "allow" },
      );
    }

    const triggered = await runAgyLeadHook(
      {
        conversationId: "conv-stop-1",
        continuationActive: false,
        fullyIdle: true,
        terminationReason: "NO_TOOL_CALL",
      },
      { mode: "stop", stateRoot, env },
    );
    assert.deepEqual(triggered, {
      decision: "continue",
      reason:
        "[tfx-lead] 컨텍스트 사용량이 86%에 도달했다. 인계 파일을 저장하고 tfx-live clear 로 세션을 승계하라.",
    });

    const updatedMarker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(updatedMarker.notifiedConversationId, "conv-stop-1");
    assert.equal(updatedMarker.notifiedThreshold, 85);

    const repeated = await runAgyLeadHook(
      {
        conversationId: "conv-stop-1",
        continuationActive: false,
        fullyIdle: true,
        terminationReason: "NO_TOOL_CALL",
      },
      { mode: "stop", stateRoot, env },
    );
    assert.deepEqual(repeated, { decision: "allow" });
  });

  it("CLI 직접 실행 시 stdout에 한 줄 JSON을 출력한다", () => {
    const stateRoot = makeStateRoot();
    const res = spawnSync(process.execPath, [HOOK_PATH, "stop"], {
      input: JSON.stringify({
        conversationId: "conv-cli",
        fullyIdle: true,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_STATE_HOME: resolve(stateRoot, ".."),
        TMUX_PANE: "",
      },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '{"decision":"allow"}\n');
  });
});

describe("setup: inspectAgyPlugin 및 ensureAgyPlugin", () => {
  it("보호 환경과 agy 미설치 환경을 구분하고 설치, 갱신, 활성화를 수행한다", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "tfx-agy-plugin-setup-"));
    tempDirs.push(fakeHome);

    for (const env of [
      { CI: "true", HOME: fakeHome },
      { TRIFLUX_TEST_HOME: fakeHome, HOME: fakeHome },
      { npm_lifecycle_event: "postinstall", HOME: fakeHome },
    ]) {
      const inspected = inspectAgyPlugin({
        env,
        pkgVersion: "10.99.0",
        run: () => "[]",
      });
      assert.deepEqual(inspected, {
        status: "skipped",
        reason: "protected-env",
      });
      assert.equal(
        ensureAgyPlugin({ env, pkgVersion: "10.99.0", run: () => "[]" }),
        "not-needed",
      );
    }

    const cleanEnv = { HOME: fakeHome };
    assert.deepEqual(
      inspectAgyPlugin({
        env: cleanEnv,
        pkgVersion: "10.99.0",
        run: () => {
          throw new Error("ENOENT");
        },
      }),
      { status: "skipped", reason: "agy-unavailable" },
    );

    const localBin = join(fakeHome, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const localAgy = join(localBin, "agy");
    writeFileSync(localAgy, "#!/bin/sh\n", { mode: 0o755 });
    const seenCmds = [];
    const cliRunner = agyCli(cleanEnv, (cmd, args) => {
      seenCmds.push([cmd, args]);
      return "[]";
    });
    cliRunner(["plugin", "list", "--json"]);
    assert.equal(seenCmds[0][0], localAgy);

    const calls = [];
    let listPayload = [];
    const run = (args) => {
      calls.push(args.join(" "));
      if (args[1] === "list") return JSON.stringify(listPayload);
      return "{}";
    };

    assert.equal(
      ensureAgyPlugin({
        env: cleanEnv,
        pkgVersion: "10.99.0",
        pluginSrcDir: "/src/triflux",
        run,
        log: () => {},
        warn: () => {},
      }),
      "installed",
    );
    assert.deepEqual(calls.splice(0), [
      "plugin list --json",
      "plugin validate /src/triflux --json",
      "plugin install /src/triflux",
    ]);

    listPayload = [{ name: "triflux", enabled: false, version: "10.99.0" }];
    assert.equal(
      ensureAgyPlugin({
        env: cleanEnv,
        pkgVersion: "10.99.0",
        pluginSrcDir: "/src/triflux",
        run,
        log: () => {},
        warn: () => {},
      }),
      "updated",
    );
    assert.deepEqual(calls.splice(0), [
      "plugin list --json",
      "plugin validate /src/triflux --json",
      "plugin install /src/triflux",
      "plugin enable triflux",
    ]);

    listPayload = [{ name: "triflux", enabled: true, version: "10.98.0" }];
    assert.equal(
      ensureAgyPlugin({
        env: cleanEnv,
        pkgVersion: "10.99.0",
        pluginSrcDir: "/src/triflux",
        run,
        log: () => {},
        warn: () => {},
      }),
      "updated",
    );
    assert.deepEqual(calls.splice(0), [
      "plugin list --json",
      "plugin validate /src/triflux --json",
      "plugin install /src/triflux",
    ]);

    listPayload = [{ name: "triflux", enabled: true, version: "10.99.0" }];
    assert.equal(
      ensureAgyPlugin({
        env: cleanEnv,
        pkgVersion: "10.99.0",
        pluginSrcDir: "/src/triflux",
        run,
        log: () => {},
        warn: () => {},
      }),
      "present",
    );
    assert.deepEqual(calls.splice(0), ["plugin list --json"]);
  });
});
