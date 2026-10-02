import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  codexThreadNames,
  findCodexAncestorPid,
  readCodexSessionRecords,
  registryDir,
  resolveTmuxCoordinate,
  writeCodexSessionRecord,
} from "../../hub/lib/codex-session-registry.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-codex-registry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("codex-session-registry", () => {
  it("resolves registry directory from explicit override, XDG, or HOME", () => {
    assert.equal(
      registryDir({
        TFX_CODEX_SESSION_REGISTRY_DIR: "/override",
        HOME: "/home/test",
      }),
      "/override",
    );
    assert.equal(
      registryDir({ XDG_STATE_HOME: "/state", HOME: "/home/test" }),
      "/state/triflux/codex-sessions",
    );
    assert.equal(
      registryDir({ HOME: "/home/test" }),
      "/home/test/.local/state/triflux/codex-sessions",
    );
  });

  it("walks through a node wrapper to the native codex binary, honoring maxDepth", () => {
    const parents = new Map([
      [101, { ppid: 100, comm: "hook" }],
      [100, { ppid: 90, comm: "/usr/bin/node" }],
      [90, { ppid: 1, comm: "/opt/bin/codex" }],
    ]);
    const psFn = (pid) => parents.get(pid) ?? null;
    assert.equal(findCodexAncestorPid({ startPid: 101, psFn }), 90);
    assert.equal(
      findCodexAncestorPid({ startPid: 101, psFn, maxDepth: 2 }),
      null,
    );
    assert.equal(findCodexAncestorPid({ startPid: 90, psFn, maxDepth: 1 }), 90);
    assert.equal(
      findCodexAncestorPid({ startPid: 101, psFn: () => null }),
      null,
    );
    assert.equal(
      findCodexAncestorPid({
        startPid: 101,
        psFn: () => ({ ppid: 101, comm: "node" }),
      }),
      null,
    );
  });

  it("resolves tmux coordinates only for a pane and absorbs lookup errors", () => {
    const calls = [];
    assert.equal(resolveTmuxCoordinate({ paneId: "" }), null);
    assert.equal(
      resolveTmuxCoordinate({
        paneId: "%42",
        tmuxFn: (pane) => {
          calls.push(pane);
          return "session:with.dot:@12.%42\n";
        },
      }),
      "session:with.dot:@12.%42",
    );
    assert.deepEqual(calls, ["%42"]);
    assert.equal(
      resolveTmuxCoordinate({
        paneId: "%42",
        tmuxFn: () => {
          throw new Error("tmux unavailable");
        },
      }),
      null,
    );
  });

  it("writes a private atomic record and preserves startedAt only for the same thread", () =>
    withTempDir((root) => {
      const dir = join(root, "registry");
      const psFn = () => ({ ppid: 1, comm: "/bin/codex" });
      const env = { HOME: join(root, "fake-home"), TMUX_PANE: "%42" };
      const opts = {
        dir,
        env,
        psFn,
        tmuxFn: () => "room:@2.%42",
      };
      assert.equal(
        writeCodexSessionRecord(
          { session_id: "first", cwd: "/work", source: "startup" },
          { ...opts, now: 100 },
        ),
        true,
      );
      const file = join(dir, `${process.ppid}.json`);
      const first = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(first, {
        version: 1,
        writer: "triflux",
        pid: process.ppid,
        sessionId: "first",
        cwd: "/work",
        tmux: "room:@2.%42",
        tmuxPane: "%42",
        source: "startup",
        startedAt: 100,
        updatedAt: 100,
      });
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), [`${process.ppid}.json`]);

      writeCodexSessionRecord({ session_id: "first" }, { ...opts, now: 200 });
      const second = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(second.startedAt, 100);
      assert.equal(second.updatedAt, 200);
      writeCodexSessionRecord({ session_id: "second" }, { ...opts, now: 300 });
      const third = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(third.startedAt, 300);
      assert.equal(third.sessionId, "second");
      assert.deepEqual(readdirSync(dir), [`${process.ppid}.json`]);
    }));

  it("requires a session id and a codex ancestor before creating files", () =>
    withTempDir((root) => {
      const dir = join(root, "registry");
      assert.equal(
        writeCodexSessionRecord(
          {},
          { dir, psFn: () => ({ ppid: 1, comm: "codex" }) },
        ),
        false,
      );
      assert.equal(
        writeCodexSessionRecord({ session_id: "a" }, { dir, psFn: () => null }),
        false,
      );
      assert.equal(existsSync(dir), false);
    }));

  it("prunes only records whose filename pid is dead", () =>
    withTempDir((dir) => {
      const deadFile = join(dir, "99999999.json");
      const liveFile = join(dir, `${process.pid}.json`);
      writeFileSync(deadFile, "{}");
      writeFileSync(liveFile, "{}");
      writeCodexSessionRecord(
        { session_id: "live" },
        {
          dir,
          now: 100,
          psFn: () => ({ ppid: 1, comm: "codex" }),
          env: { HOME: dir },
        },
      );
      assert.equal(existsSync(deadFile), false);
      assert.equal(existsSync(liveFile), true);
    }));

  it("filters malformed and dead records on read", () =>
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "1.json"),
        JSON.stringify({ pid: 1, sessionId: "live" }),
      );
      writeFileSync(join(dir, "2.json"), "{bad json");
      writeFileSync(
        join(dir, "3.json"),
        JSON.stringify({ pid: 3, sessionId: "dead" }),
      );
      writeFileSync(
        join(dir, "4.json"),
        JSON.stringify({ pid: "4", sessionId: "bad" }),
      );
      writeFileSync(
        join(dir, "5.txt"),
        JSON.stringify({ pid: 5, sessionId: "ignored" }),
      );
      assert.deepEqual(
        readCodexSessionRecords({ dir, isAlive: (pid) => pid === 1 }),
        [{ pid: 1, sessionId: "live" }],
      );
    }));

  it("reads the latest thread name for each id and skips bad lines", () =>
    withTempDir((dir) => {
      const indexPath = join(dir, "session_index.jsonl");
      writeFileSync(
        indexPath,
        [
          JSON.stringify({ id: "a", thread_name: "first" }),
          "not-json",
          JSON.stringify({ id: "b", thread_name: "other" }),
          JSON.stringify({ id: "a", thread_name: "last" }),
          JSON.stringify({ id: "c" }),
        ].join("\n"),
      );
      assert.deepEqual(
        codexThreadNames({ indexPath }),
        new Map([
          ["a", "last"],
          ["b", "other"],
        ]),
      );
      assert.deepEqual(
        codexThreadNames({ indexPath: join(dir, "missing") }),
        new Map(),
      );
    }));
});
