import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWtManager } from "../../hub/team/wt-manager.mjs";

describe("wt-manager non-Windows stub", () => {
  it("createWtManager는 darwin에서 throw 하지 않고 stub manager 를 반환한다", () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    assert.ok(wt, "stub manager 반환되어야 함");
    assert.equal(typeof wt.createTab, "function");
    assert.equal(typeof wt.ensureWtProfile, "function");
    assert.equal(typeof wt.getEnvironmentInfo, "function");
  });

  it("createWtManager는 linux에서도 stub manager 반환한다", () => {
    const wt = createWtManager({ deps: { platform: () => "linux" } });
    assert.ok(wt);
  });

  it("stub getEnvironmentInfo는 hasWindowsTerminal=false 를 반환한다", () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    const env = wt.getEnvironmentInfo();
    assert.equal(env.hasWindowsTerminal, false);
    assert.equal(env.hasWt, false);
    assert.equal(env.isWindowsTerminalSession, false);
  });

  it("stub createTab 은 false 를 비동기 반환한다", async () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    const result = await wt.createTab({ title: "x", command: "echo" });
    assert.equal(result, false);
  });

  it("stub applySplitLayout 도 false 를 비동기 반환한다", async () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    const result = await wt.applySplitLayout([]);
    assert.equal(result, false);
  });

  it("stub ensureWtProfile 은 throw 하지 않는 noop 이다", () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    assert.doesNotThrow(() => wt.ensureWtProfile(2));
  });

  it("stub listTabs 는 빈 배열을 반환한다", async () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    const tabs = await wt.listTabs();
    assert.deepEqual(tabs, []);
  });

  it("stub closeStale 은 0 을 반환한다", async () => {
    const wt = createWtManager({ deps: { platform: () => "darwin" } });
    const count = await wt.closeStale({ olderThanMs: 1000 });
    assert.equal(count, 0);
  });
});
