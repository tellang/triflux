// Batch 2: 공개 경로 + 상태 + 토큰 lifecycle E2E 테스트

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHubHarness,
  existsSync,
  join,
  rmSync,
} from "./helpers/hub-auth-harness.mjs";

describe("hub auth 공개 경로 + 상태 E2E", () => {
  it("토큰이 설정되어도 공개 경로는 인증 없이 접근 가능해야 한다", async () => {
    const h = await createHubHarness({ token: "public-path-token" });
    try {
      for (const path of ["/", "/status", "/health", "/healthz"]) {
        const res = await fetch(`${h.baseUrl}${path}`);
        // /health는 hub 상태에 따라 503일 수 있지만, 401/403이 아니어야 한다
        assert.ok(
          res.status !== 401 && res.status !== 403,
          `${path}: 공개 경로인데 ${res.status} 반환`,
        );
      }
    } finally {
      await h.cleanupAll();
    }
  });

  it('/status 응답에 auth_mode가 "token-required"로 표시되어야 한다', async () => {
    const h = await createHubHarness({ token: "mode-check-token" });
    try {
      const res = await fetch(`${h.baseUrl}/status`);
      const body = await res.json();
      assert.equal(body.auth_mode, "token-required");
      assert.ok(body.pid > 0);
      assert.equal(body.port, h.port);
    } finally {
      await h.cleanupAll();
    }
  });

  it('토큰 없는 hub의 /status에 auth_mode가 "localhost-only"로 표시되어야 한다', async () => {
    const h = await createHubHarness();
    try {
      const res = await fetch(`${h.baseUrl}/status`);
      const body = await res.json();
      assert.equal(body.auth_mode, "localhost-only");
    } finally {
      await h.cleanupAll();
    }
  });

  it("hub 종료 후 토큰 파일이 삭제되어야 한다", async () => {
    const h = await createHubHarness({ token: "cleanup-test-token" });
    const tokenFile = join(h.homeDir, ".claude", ".tfx-hub-token");

    try {
      assert.equal(existsSync(tokenFile), true, "토큰 파일이 존재해야 한다");

      await h.cleanup();

      assert.equal(
        existsSync(tokenFile),
        false,
        "종료 후 토큰 파일이 삭제되어야 한다",
      );
    } finally {
      try {
        rmSync(h.homeDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("토큰 없는 hub는 토큰 파일을 생성하지 않아야 한다", async () => {
    const h = await createHubHarness();
    const tokenFile = join(h.homeDir, ".claude", ".tfx-hub-token");

    try {
      assert.equal(
        existsSync(tokenFile),
        false,
        "토큰 없는 hub는 토큰 파일을 만들지 않아야 한다",
      );
    } finally {
      await h.cleanupAll();
    }
  });
});
