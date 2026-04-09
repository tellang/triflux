// tests/unit/ssh-retry.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientSshError } from "../../hub/lib/ssh-retry.mjs";

describe("ssh-retry", () => {
  describe("isTransientSshError", () => {
    it("connection reset 감지", () => {
      const err = new Error(
        "ssh: connect to host 100.110.136.64: Connection reset by peer",
      );
      assert.ok(isTransientSshError(err));
    });

    it("connection refused 감지", () => {
      const err = new Error(
        "ssh: connect to host 192.168.1.1: Connection refused",
      );
      assert.ok(isTransientSshError(err));
    });

    it("connection timed out 감지", () => {
      const err = new Error(
        "ssh: connect to host example.com: Connection timed out",
      );
      assert.ok(isTransientSshError(err));
    });

    it("broken pipe 감지", () => {
      const err = new Error("Write failed: Broken pipe");
      assert.ok(isTransientSshError(err));
    });

    it("network unreachable 감지", () => {
      const err = new Error(
        "ssh: connect to host 10.0.0.1: Network is unreachable",
      );
      assert.ok(isTransientSshError(err));
    });

    it("stderr 필드에서도 감지", () => {
      const err = new Error("command failed");
      err.stderr = "ssh: connect to host ultra4: Connection reset by peer";
      assert.ok(isTransientSshError(err));
    });

    it("비-transient 에러는 false", () => {
      const err = new Error("Permission denied (publickey)");
      assert.ok(!isTransientSshError(err));
    });

    it("인증 실패는 false", () => {
      const err = new Error("Host key verification failed.");
      assert.ok(!isTransientSshError(err));
    });
  });
});
