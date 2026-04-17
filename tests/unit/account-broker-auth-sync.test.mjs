import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AccountBroker } from "../../hub/account-broker.mjs";

function writeAuth(filePath, accountId, refreshToken) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          account_id: accountId,
          refresh_token: refreshToken,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function readRefreshToken(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8")).tokens.refresh_token;
}

function setMtime(filePath, ms) {
  const when = new Date(ms);
  utimesSync(filePath, when, when);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "tfx-account-broker-auth-sync-"));
  const authBasePath = join(root, ".claude", "cache", "tfx-hub");
  const sourcePath = join(root, ".codex", "auth.json");
  const accountId = "pte1024";
  const authFile = `codex-auth-${accountId}.json`;
  const cachePath = join(authBasePath, authFile);
  const broker = new AccountBroker(
    {
      codex: [{ id: accountId, mode: "auth", authFile }],
    },
    {
      _skipPersistence: true,
      _authBasePath: authBasePath,
      _codexAuthSourcePath: sourcePath,
      _authSyncLockRetryMs: 10,
      _authSyncLockTimeoutMs: 5000,
    },
  );

  return {
    root,
    authBasePath,
    sourcePath,
    cachePath,
    accountId,
    authFile,
    broker,
  };
}

const cleanup = [];
afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    rmSync(path, { recursive: true, force: true });
  }
});

function waitFor(condition, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timeout"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function spawnLeaseHelper(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(
          process.cwd(),
          "tests",
          "fixtures",
          "account-broker-lease-helper.mjs",
        ),
      ],
      {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("AccountBroker auth sync", () => {
  it("mtime 기반으로 source가 더 새로우면 cache를 갱신하고 아니면 건너뛴다", () => {
    const fixture = createFixture();
    cleanup.push(fixture.root);

    writeAuth(fixture.sourcePath, fixture.accountId, "source-new");
    writeAuth(fixture.cachePath, fixture.accountId, "cache-old");
    setMtime(fixture.cachePath, 1_000);
    setMtime(fixture.sourcePath, 2_000);

    const copied = fixture.broker.syncAuthFromSource(fixture.accountId);
    assert.equal(copied.copied, true);
    assert.equal(readRefreshToken(fixture.cachePath), "source-new");

    writeAuth(fixture.cachePath, fixture.accountId, "cache-newer");
    setMtime(fixture.sourcePath, 3_000);
    setMtime(fixture.cachePath, 4_000);

    const skipped = fixture.broker.syncAuthFromSource(fixture.accountId);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "up_to_date");
    assert.equal(readRefreshToken(fixture.cachePath), "cache-newer");
  });

  it("from-source / to-source 양방향 복사를 지원한다", () => {
    const fixture = createFixture();
    cleanup.push(fixture.root);

    writeAuth(fixture.sourcePath, fixture.accountId, "source-v1");
    writeAuth(fixture.cachePath, fixture.accountId, "cache-v1");
    setMtime(fixture.sourcePath, 1_000);
    setMtime(fixture.cachePath, 2_000);

    const toSource = fixture.broker.syncAuthToSource(fixture.accountId);
    assert.equal(toSource.copied, true);
    assert.equal(readRefreshToken(fixture.sourcePath), "cache-v1");

    writeAuth(fixture.sourcePath, fixture.accountId, "source-v2");
    setMtime(fixture.sourcePath, 3_000);
    setMtime(fixture.cachePath, 2_500);

    const fromSource = fixture.broker.syncAuthFromSource(fixture.accountId);
    assert.equal(fromSource.copied, true);
    assert.equal(readRefreshToken(fixture.cachePath), "source-v2");
  });

  it("동시 lease 시 lock으로 stale overwrite를 막는다", async () => {
    const fixture = createFixture();
    cleanup.push(fixture.root);

    writeAuth(fixture.sourcePath, fixture.accountId, "source-A");
    writeAuth(fixture.cachePath, fixture.accountId, "cache-old");
    setMtime(fixture.cachePath, 1_000);
    setMtime(fixture.sourcePath, 2_000);

    const lockPath = join(
      fixture.authBasePath,
      `codex-auth-sync-${fixture.accountId}.lock`,
    );
    const env = {
      BROKER_AUTH_BASE_PATH: fixture.authBasePath,
      BROKER_SOURCE_PATH: fixture.sourcePath,
      BROKER_ACCOUNT_ID: fixture.accountId,
      BROKER_AUTH_FILE: fixture.authFile,
    };

    const firstLease = spawnLeaseHelper({
      ...env,
      BROKER_SYNC_DELAY_MS: "200",
    });
    await waitFor(() => existsSync(lockPath));
    await new Promise((resolve) => setTimeout(resolve, 25));

    writeAuth(fixture.sourcePath, fixture.accountId, "source-B");
    setMtime(fixture.sourcePath, Date.now() + 60_000);

    const secondLease = spawnLeaseHelper(env);
    const [first, second] = await Promise.all([firstLease, secondLease]);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);

    const firstPayload = JSON.parse(first.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(firstPayload.lease?.id, fixture.accountId);
    assert.equal(secondPayload.lease?.id, fixture.accountId);
    assert.equal(readRefreshToken(fixture.cachePath), "source-B");
  });
});
