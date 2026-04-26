import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getOrCreateServer } from "../../hub/server.mjs";
import {
  acquireLock,
  getVersionHash,
  isServerHealthy,
  readState,
  releaseLock,
  writeState,
} from "../../hub/state.mjs";

const TEMP_DIRS = [];

function makeTempStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-state-test-"));
  TEMP_DIRS.push(dir);
  process.env.TFX_HUB_STATE_DIR = dir;
  return dir;
}

afterEach(() => {
  releaseLock();
  delete process.env.TFX_HUB_STATE_DIR;
  while (TEMP_DIRS.length > 0) {
    try {
      rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe("hub/state.mjs", () => {
  it("writeState/readState는 state를 round-trip 한다", () => {
    const stateDir = makeTempStateDir();
    const expected = {
      pid: 12345,
      port: 27888,
      version: "9.8.2-deadbee",
      sessionId: "session-1",
      startedAt: "2026-04-03T00:00:00.000Z",
    };

    writeState(expected);
    const actual = readState();

    assert.deepEqual(actual, expected);
    assert.deepEqual(
      readdirSync(stateDir).filter((name) => name.includes(".tmp")),
      [],
    );
  });

  it("writeState는 기존 파일을 덮어쓰고 유효한 JSON만 남긴다", () => {
    makeTempStateDir();

    writeState({
      pid: 1,
      port: 27888,
      version: "first",
      sessionId: "a",
      startedAt: "2026-04-03T00:00:00.000Z",
    });
    writeState({
      pid: 2,
      port: 27889,
      version: "second",
      sessionId: "b",
      startedAt: "2026-04-03T01:00:00.000Z",
    });

    const raw = readFileSync(
      join(process.env.TFX_HUB_STATE_DIR, "hub.pid"),
      "utf8",
    );
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal(readState()?.version, "second");
  });

  it("readState는 legacy hub-state.json 파일도 fallback으로 읽는다", () => {
    const stateDir = makeTempStateDir();
    const expected = {
      pid: process.pid,
      port: 27888,
      version: "legacy",
      sessionId: "legacy-session",
      startedAt: "2026-04-03T00:00:00.000Z",
    };

    writeFileSync(
      join(stateDir, "hub-state.json"),
      JSON.stringify(expected),
      "utf8",
    );
    assert.deepEqual(readState(), expected);
  });

  it("acquireLock는 경합 시 timeout 후 실패하고 release 후 재획득 가능하다", async () => {
    const stateDir = makeTempStateDir();
    const lockPath = join(stateDir, "hub-start.lock");

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );

    await assert.rejects(
      acquireLock({ timeoutMs: 120, pollMs: 10, lockPath }),
      /lock busy/i,
    );

    rmSync(lockPath, { force: true });
    await assert.doesNotReject(
      acquireLock({ timeoutMs: 120, pollMs: 10, lockPath }),
    );
  });

  it("getVersionHash는 package version 기반 문자열을 반환한다", () => {
    const version = getVersionHash({ force: true });
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9a-f]+)?$/i);
  });

  it("isServerHealthy는 /health ok 응답을 감지한다", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      assert.equal(await isServerHealthy(port, { timeoutMs: 500 }), true);
      assert.equal(await isServerHealthy(port + 1, { timeoutMs: 100 }), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("getOrCreateServer — 싱글톤 팩토리", () => {
  it("기존 서버가 없으면 새로 시작한다", async () => {
    const fakeBoot = async () => ({
      port: 30000,
      pid: 99999,
      url: "http://127.0.0.1:30000/mcp",
    });

    const result = await getOrCreateServer({
      _deps: {
        readState: () => null,
        startHub: fakeBoot,
        isHealthy: () => true,
        getInfo: () => null,
      },
    });

    assert.equal(result.reused, false);
    assert.equal(result.port, 30000);
    assert.equal(result.pid, 99999);
  });

  it("기존 서버가 healthy하면 재사용한다 (reused: true)", async () => {
    const result = await getOrCreateServer({
      _deps: {
        readState: () => ({ pid: process.pid, port: 27888 }),
        startHub: () => {
          throw new Error("startHub이 호출되면 안 됨");
        },
        isHealthy: () => true,
        getInfo: () => ({ url: "http://127.0.0.1:27888/mcp" }),
      },
    });

    assert.equal(result.reused, true);
    assert.equal(result.port, 27888);
    assert.equal(result.pid, process.pid);
    assert.equal(result.url, "http://127.0.0.1:27888/mcp");
  });

  it("PID는 살아있지만 health 체크 실패 시 새로 시작한다", async () => {
    const fakeBoot = async () => ({
      port: 32000,
      pid: 88888,
      url: "http://127.0.0.1:32000/mcp",
    });

    const result = await getOrCreateServer({
      _deps: {
        readState: () => ({ pid: process.pid, port: 31000 }),
        startHub: fakeBoot,
        isHealthy: () => false,
        getInfo: () => null,
      },
    });

    assert.equal(result.reused, false);
    assert.equal(result.port, 32000);
    assert.equal(result.pid, 88888);
  });

  it("state에 pid/port가 불완전하면 새로 시작한다", async () => {
    const fakeBoot = async () => ({
      port: 33000,
      pid: 77777,
      url: "http://127.0.0.1:33000/mcp",
    });

    const result = await getOrCreateServer({
      _deps: {
        readState: () => ({ pid: null, port: 27888 }),
        startHub: fakeBoot,
        isHealthy: () => true,
        getInfo: () => null,
      },
    });

    assert.equal(result.reused, false);
    assert.equal(result.port, 33000);
  });

  it("getInfo가 url을 반환하지 않으면 기본 url로 폴백한다", async () => {
    const result = await getOrCreateServer({
      _deps: {
        readState: () => ({ pid: process.pid, port: 27888 }),
        startHub: () => {
          throw new Error("startHub이 호출되면 안 됨");
        },
        isHealthy: () => true,
        getInfo: () => null,
      },
    });

    assert.equal(result.reused, true);
    assert.equal(result.url, "http://127.0.0.1:27888/mcp");
  });
});
