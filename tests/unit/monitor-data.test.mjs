import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, it } from "node:test";

import { fetchHubStatus, pollAgents } from "../../tui/monitor-data.mjs";

// fs mock 의존성을 쉽게 만들기 위한 헬퍼다.
function makeFsDeps(overrides = {}) {
  return {
    readdirSync: () => [],
    readFileSync: () => "",
    unlinkSync: () => {},
    kill: () => {},
    env: { TMPDIR: "/tmp/mock" },
    now: () => 10_000_000,
    ...overrides,
  };
}

// http.get mock 요청 객체를 만든다.
function makeRequest() {
  const req = new EventEmitter();
  req.setTimeout = (ms, handler) => {
    req.timeoutMs = ms;
    req.timeoutHandler = handler;
    return req;
  };
  req.destroy = (error) => req.emit("error", error);
  return req;
}

// 성공 응답을 흉내내는 http.get mock이다.
function makeOnlineGet(payload, statusCode = 200) {
  const calls = [];
  const get = (url, onResponse) => {
    calls.push(url);
    const req = makeRequest();
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.setEncoding = () => {};
    queueMicrotask(() => {
      onResponse(res);
      res.emit("data", JSON.stringify(payload));
      res.emit("end");
    });
    return req;
  };
  get.calls = calls;
  return get;
}

// 연결 실패를 흉내내는 http.get mock이다.
function makeOfflineGet() {
  return () => {
    const req = makeRequest();
    queueMicrotask(() => req.emit("error", new Error("offline")));
    return req;
  };
}

describe("pollAgents", () => {
  it("파일이 있으면 살아있는 에이전트 목록과 elapsed를 반환한다", () => {
    const env = { TMPDIR: "C:/temp" };
    const filePath = join(env.TMPDIR, "tfx-agent-101.json");
    const agents = pollAgents(
      makeFsDeps({
        env,
        now: () => 25_000_000,
        readdirSync: (dir) => {
          assert.equal(dir, env.TMPDIR);
          return ["tfx-agent-101.json", "ignore.txt"];
        },
        readFileSync: (target) => {
          assert.equal(target, filePath);
          return JSON.stringify({
            pid: 101,
            cli: "codex",
            agent: "worker-a",
            started: 5_000,
          });
        },
      }),
    );

    assert.deepEqual(agents, [
      {
        pid: 101,
        cli: "codex",
        agent: "worker-a",
        started: 5_000,
        elapsed: 20_000,
        alive: true,
      },
    ]);
  });

  it("파일이 없으면 빈 배열을 반환한다", () => {
    const agents = pollAgents(makeFsDeps({ readdirSync: () => [] }));
    assert.deepEqual(agents, []);
  });

  it("JSON이 깨진 파일은 무시한다", () => {
    let killCalled = false;
    const agents = pollAgents(
      makeFsDeps({
        readdirSync: () => ["tfx-agent-bad.json"],
        readFileSync: () => "{broken-json",
        kill: () => {
          killCalled = true;
        },
      }),
    );

    assert.deepEqual(agents, []);
    assert.equal(killCalled, false);
  });

  it("좀비 PID는 파일을 삭제하고 결과에서 제외한다", () => {
    const removed = [];
    const deps = makeFsDeps({
      env: { TMPDIR: "/tmp/test" },
      readdirSync: () => ["tfx-agent-dead.json"],
      readFileSync: () =>
        JSON.stringify({ pid: 404, cli: "claude", agent: "ghost", started: 1 }),
      kill: () => {
        throw new Error("ESRCH");
      },
      unlinkSync: (target) => removed.push(target),
    });

    const agents = pollAgents(deps);
    assert.deepEqual(agents, []);
    assert.deepEqual(removed, [join("/tmp/test", "tfx-agent-dead.json")]);
  });
});

describe("fetchHubStatus", () => {
  it("online 허브면 상태 필드를 반환한다", async () => {
    const get = makeOnlineGet({ uptime: 12, queueDepth: 3, agents: 7 });
    const status = await fetchHubStatus("http://127.0.0.1:27888", { get });

    assert.deepEqual(status, {
      online: true,
      uptime: 12,
      queueDepth: 3,
      agents: 7,
    });
    assert.deepEqual(get.calls, ["http://127.0.0.1:27888/status"]);
  });

  it("offline 또는 요청 실패면 online=false를 반환한다", async () => {
    const status = await fetchHubStatus("http://127.0.0.1:27888", {
      get: makeOfflineGet(),
    });
    assert.deepEqual(status, { online: false });
  });
});
