// tests/unit/hub-loopback-gate.test.mjs
// 원격(non-loopback) 주소 차단 로직의 단위 검증.
//
// 이전에는 tests/integration/hub-server.test.mjs 가 머신의 실제 외부 IP로
// self-connect 해서 "원격" 요청을 흉내냈는데, 그 fetch 에 timeout 이 없어
// 병렬 부하(--test-concurrency=8)에서 self-connect 가 무한 hang → npm test
// 전체가 timeout 으로 죽었다. 동일한 차단 로직을 fake req 로 단위 검증한다
// (네트워크 0 의존 → 부하/방화벽/OS 무관, 크로스플랫폼).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAuthorizedRequest,
  isLoopbackRemoteAddress,
} from "../../hub/server.mjs";

function fakeReq(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

describe("isLoopbackRemoteAddress", () => {
  it("loopback 주소는 true", () => {
    assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("::1"), true);
    assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
  });

  it("non-loopback 주소는 false (원격으로 간주)", () => {
    assert.equal(isLoopbackRemoteAddress("192.168.1.99"), false);
    assert.equal(isLoopbackRemoteAddress("10.0.0.5"), false);
    assert.equal(isLoopbackRemoteAddress("100.104.61.126"), false); // tailscale
    assert.equal(isLoopbackRemoteAddress("172.17.0.2"), false); // docker bridge
  });

  it("문자열이 아니거나 빈 값은 false", () => {
    assert.equal(isLoopbackRemoteAddress(undefined), false);
    assert.equal(isLoopbackRemoteAddress(null), false);
    assert.equal(isLoopbackRemoteAddress(""), false);
  });
});

describe("isAuthorizedRequest — localhost-only 모드 (hubToken 없음)", () => {
  it("loopback 요청은 허용한다", () => {
    assert.equal(isAuthorizedRequest(fakeReq("127.0.0.1"), "/status", null), true);
    assert.equal(isAuthorizedRequest(fakeReq("::1"), "/status", null), true);
  });

  it("원격(non-loopback) 요청은 차단한다 → 핸들러가 403 'Forbidden: localhost only'", () => {
    assert.equal(
      isAuthorizedRequest(fakeReq("192.168.1.99"), "/status", null),
      false,
    );
    assert.equal(
      isAuthorizedRequest(fakeReq("100.104.61.126"), "/synapse/sessions", null),
      false,
    );
  });

  it("remoteAddress 누락 시에도 차단한다", () => {
    assert.equal(isAuthorizedRequest(fakeReq(undefined), "/status", null), false);
  });
});

describe("isAuthorizedRequest — token 모드 (hubToken 있음)", () => {
  const TOKEN = "unit-secret-token";

  it("유효한 Bearer 토큰은 원격 주소여도 허용한다", () => {
    assert.equal(
      isAuthorizedRequest(
        fakeReq("192.168.1.99", { authorization: `Bearer ${TOKEN}` }),
        "/bridge/register",
        TOKEN,
      ),
      true,
    );
  });

  it("토큰 누락 또는 불일치는 차단한다", () => {
    assert.equal(
      isAuthorizedRequest(fakeReq("192.168.1.99", {}), "/bridge/register", TOKEN),
      false,
    );
    assert.equal(
      isAuthorizedRequest(
        fakeReq("192.168.1.99", { authorization: "Bearer wrong-token" }),
        "/bridge/register",
        TOKEN,
      ),
      false,
    );
  });
});
