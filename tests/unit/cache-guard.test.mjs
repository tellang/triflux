import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  checkNetworkAvailability,
  validateRuntimeCachePaths,
} from "../../hub/lib/cache-guard.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dirPath) {
  rmSync(dirPath, { recursive: true, force: true });
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("cache-guard", () => {
  it("누락된 캐시 디렉터리는 정상으로 간주한다", () => {
    const missingDir = join(tmpdir(), `tfx-cache-missing-${Date.now()}`);
    const result = validateRuntimeCachePaths(missingDir);

    assert.deepEqual(result, { ok: true, issues: [] });
  });

  it("유효한 JSON 캐시는 문제 없이 통과한다", () => {
    const cacheDir = makeTempDir("tfx-cache-guard-valid-");
    try {
      mkdirSync(join(cacheDir, "nested"), { recursive: true });
      writeFileSync(
        join(cacheDir, "runtime.json"),
        JSON.stringify({ ok: true }),
        "utf8",
      );
      writeFileSync(
        join(cacheDir, "nested", "meta.json"),
        JSON.stringify({ version: 1 }),
        "utf8",
      );

      const result = validateRuntimeCachePaths(cacheDir);

      assert.equal(result.ok, true);
      assert.deepEqual(result.issues, []);
    } finally {
      cleanup(cacheDir);
    }
  });

  it("손상된 JSON 캐시를 상대 경로와 함께 보고한다", () => {
    const cacheDir = makeTempDir("tfx-cache-guard-invalid-");
    try {
      mkdirSync(join(cacheDir, "nested"), { recursive: true });
      writeFileSync(join(cacheDir, "nested", "broken.json"), "{broken", "utf8");

      const result = validateRuntimeCachePaths(cacheDir);

      assert.equal(result.ok, false);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].file, "nested/broken.json");
      assert.match(result.issues[0].error, /json|position|expected|syntax/i);
    } finally {
      cleanup(cacheDir);
    }
  });

  it("도달 가능한 URL과 실패 URL을 함께 구분한다", async () => {
    await withServer(
      (request, response) => {
        response.writeHead(request.method === "HEAD" ? 204 : 200);
        response.end();
      },
      async (reachableUrl) => {
        const status = await checkNetworkAvailability([
          reachableUrl,
          "http://127.0.0.1:1",
        ]);

        assert.equal(status.online, false);
        assert.deepEqual(status.reachable, [reachableUrl]);
        assert.deepEqual(status.unreachable, ["http://127.0.0.1:1"]);
      },
    );
  });

  it("CLI update 경로가 async 캐시 가드를 사용하도록 연결돼 있다", () => {
    const source = readFileSync(
      join(process.cwd(), "bin", "triflux.mjs"),
      "utf8",
    );

    assert.match(source, /async function cmdUpdate\(\)/);
    assert.match(source, /await checkNetworkAvailability\(networkTargets\)/);
    assert.match(
      source,
      /validateRuntimeCachePaths\(join\(CLAUDE_DIR, "cache"\)\)/,
    );
    assert.match(source, /case "update":[\s\S]*await cmdUpdate\(\);/);
  });
});
