import { readFileSync } from "node:fs";
import { AccountBroker } from "../../hub/account-broker.mjs";

const authBasePath = process.env.BROKER_AUTH_BASE_PATH;
const sourcePath = process.env.BROKER_SOURCE_PATH;
const accountId = process.env.BROKER_ACCOUNT_ID || "pte1024";
const authFile = process.env.BROKER_AUTH_FILE || `codex-auth-${accountId}.json`;
const syncDelayMs = Number(process.env.BROKER_SYNC_DELAY_MS || "0");

const broker = new AccountBroker(
  {
    codex: [{ id: accountId, mode: "auth", authFile }],
  },
  {
    _skipPersistence: true,
    _authBasePath: authBasePath,
    _codexAuthSourcePath: sourcePath,
    _syncCopyDelayMs: syncDelayMs,
    _authSyncLockRetryMs: 10,
    _authSyncLockTimeoutMs: 5000,
  },
);

const lease = broker.lease({ provider: "codex" });
const cachePath = lease?.authFile;
const cache = cachePath ? JSON.parse(readFileSync(cachePath, "utf8")) : null;
process.stdout.write(
  JSON.stringify({
    lease,
    cacheAccountId: cache?.tokens?.account_id ?? null,
    refreshToken: cache?.tokens?.refresh_token ?? null,
  }),
);
