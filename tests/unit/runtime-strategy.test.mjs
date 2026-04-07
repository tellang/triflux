import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRuntime,
  NativeRuntime,
  PsmuxRuntime,
  TeamRuntime,
  WtRuntime,
} from "../../hub/team/runtime-strategy.mjs";

const RUNTIME_METHODS = ['start', 'stop', 'isAlive', 'focus', 'sendKeys', 'interrupt', 'getStatus'];

describe("createRuntime factory", () => {
  it("'psmux' → PsmuxRuntime 인스턴스 반환", () => {
    const rt = createRuntime('psmux');
    assert.ok(rt instanceof PsmuxRuntime);
    assert.ok(rt instanceof TeamRuntime);
    assert.equal(rt.name, 'psmux');
  });

  it("'native' → NativeRuntime 인스턴스 반환", () => {
    const rt = createRuntime('native');
    assert.ok(rt instanceof NativeRuntime);
    assert.ok(rt instanceof TeamRuntime);
    assert.equal(rt.name, 'native');
  });

  it("'wt' → WtRuntime 인스턴스 반환", () => {
    const rt = createRuntime('wt');
    assert.ok(rt instanceof WtRuntime);
    assert.ok(rt instanceof TeamRuntime);
    assert.equal(rt.name, 'wt');
  });

  it("미지원 mode → Error throw", () => {
    assert.throws(
      () => createRuntime('invalid'),
      { message: 'Unknown runtime mode: invalid' }
    );
  });
});

describe("TeamRuntime 추상 메서드", () => {
  it("name getter 호출 시 에러", () => {
    const base = new TeamRuntime();
    assert.throws(() => base.name, { message: 'not implemented' });
  });

  for (const method of RUNTIME_METHODS) {
    it(`${method}() 호출 시 에러`, async () => {
      const base = new TeamRuntime();
      await assert.rejects(async () => base[method](), { message: 'not implemented' });
    });
  }
});

describe("PsmuxRuntime duck-typing 검증", () => {
  it("모든 메서드가 구현되어 있고 호출 가능", async () => {
    const rt = createRuntime('psmux');
    for (const method of RUNTIME_METHODS) {
      assert.equal(typeof rt[method], 'function', `${method} 미구현`);
      await assert.doesNotReject(async () => rt[method]());
    }
  });
});

describe("NativeRuntime duck-typing 검증", () => {
  it("모든 메서드가 구현되어 있고 호출 가능", async () => {
    const rt = createRuntime('native');
    for (const method of RUNTIME_METHODS) {
      assert.equal(typeof rt[method], 'function', `${method} 미구현`);
      await assert.doesNotReject(async () => rt[method]());
    }
  });
});

describe("WtRuntime duck-typing 검증", () => {
  it("모든 메서드가 구현되어 있고 호출 가능", async () => {
    const rt = createRuntime('wt');
    for (const method of RUNTIME_METHODS) {
      assert.equal(typeof rt[method], 'function', `${method} 미구현`);
      await assert.doesNotReject(async () => rt[method]());
    }
  });
});
