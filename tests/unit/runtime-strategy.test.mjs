import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPsmuxRuntime,
  createRuntime,
} from "../../hub/team/runtime-strategy.mjs";

describe("hub/team/runtime-strategy.mjs", () => {
  it("PsmuxRuntime는 name을 유지하고 psmux lifecycle 호출에 위임한다", () => {
    const calls = [];
    const runtime = createPsmuxRuntime({
      createSession(sessionName, opts = {}) {
        calls.push(["createSession", sessionName, opts]);
        return { sessionName, panes: ["demo:0.0"] };
      },
      killSession(sessionName) {
        calls.push(["killSession", sessionName]);
      },
      hasSession(sessionName) {
        calls.push(["hasSession", sessionName]);
        return sessionName === "demo";
      },
    });

    assert.equal(runtime.name, "psmux");
    assert.deepEqual(runtime.start("demo", { paneCount: 2 }), {
      sessionName: "demo",
      panes: ["demo:0.0"],
    });
    assert.equal(runtime.isAlive("demo"), true);
    assert.deepEqual(runtime.getStatus("demo"), {
      name: "psmux",
      sessionName: "demo",
      alive: true,
    });
    runtime.stop("demo");

    assert.deepEqual(calls, [
      ["createSession", "demo", { paneCount: 2 }],
      ["hasSession", "demo"],
      ["hasSession", "demo"],
      ["killSession", "demo"],
    ]);
  });

  it("createRuntime('psmux')는 psmux runtime을 생성한다", () => {
    const runtime = createRuntime("psmux");

    assert.equal(runtime.name, "psmux");
    assert.equal(typeof runtime.start, "function");
    assert.equal(typeof runtime.stop, "function");
    assert.equal(typeof runtime.isAlive, "function");
    assert.equal(typeof runtime.getStatus, "function");
  });

  it("native/wt placeholder는 미구현 에러를 던진다", () => {
    assert.throws(() => createRuntime("native"), /not implemented yet/i);
    assert.throws(() => createRuntime("wt"), /not implemented yet/i);
  });

  it("지원하지 않는 런타임 모드는 에러를 던진다", () => {
    assert.throws(() => createRuntime("bogus"), /unsupported runtime mode/i);
  });
});
