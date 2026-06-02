import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  fetchClaudeUsageFromApi,
  readClaudeCredentials,
  writeBackClaudeCredentials,
} from "../../hud/providers/claude.mjs";

describe("readClaudeCredentials", () => {
  it("tries CLAUDE_CONFIG_DIR/.credentials.json before the default credentials file", () => {
    const calls = [];
    const configDir = "/tmp/isolated-claude";
    const creds = readClaudeCredentials({
      readCredentialFile: (filePath) => {
        calls.push(filePath);
        if (filePath === join(configDir, ".credentials.json")) {
          return {
            claudeAiOauth: {
              accessToken: "isolated-access",
              refreshToken: "isolated-refresh",
              expiresAt: 123,
            },
          };
        }
        throw new Error("default credentials should not be read");
      },
      platform: "linux",
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    assert.deepEqual(calls, [join(configDir, ".credentials.json")]);
    assert.deepEqual(creds, {
      accessToken: "isolated-access",
      refreshToken: "isolated-refresh",
      expiresAt: 123,
      source: "file",
      supportsUsageApi: true,
    });
  });

  it("falls back from an invalid CLAUDE_CONFIG_DIR file to the default credentials file", () => {
    const calls = [];
    const configDir = "/tmp/isolated-claude";
    const creds = readClaudeCredentials({
      readCredentialFile: (filePath) => {
        calls.push(filePath);
        if (filePath === join(configDir, ".credentials.json")) {
          return null;
        }
        return {
          claudeAiOauth: {
            accessToken: "default-access",
          },
        };
      },
      platform: "linux",
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0], join(configDir, ".credentials.json"));
    assert.deepEqual(creds, {
      accessToken: "default-access",
      refreshToken: undefined,
      expiresAt: undefined,
      source: "file",
      supportsUsageApi: true,
    });
  });

  it("keeps file credentials as the first priority", () => {
    const creds = readClaudeCredentials({
      readCredentialFile: () => ({
        claudeAiOauth: {
          accessToken: "file-access",
          refreshToken: "file-refresh",
          expiresAt: 123,
        },
      }),
      platform: "darwin",
      execFileSyncFn: () => {
        throw new Error(
          "keychain should not be read when file credentials exist",
        );
      },
      env: {},
    });

    assert.deepEqual(creds, {
      accessToken: "file-access",
      refreshToken: "file-refresh",
      expiresAt: 123,
      source: "file",
      supportsUsageApi: true,
    });
  });

  it("falls back to macOS Keychain OAuth credentials", () => {
    const calls = [];
    const keychainExpiresAt = Date.now() + 60_000;
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args, options) => {
        calls.push({ command, args, options });
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: "keychain-access",
            refreshToken: "keychain-refresh",
            expiresAt: keychainExpiresAt,
          },
        });
      },
      env: {},
    });

    const username = userInfo().username?.trim();
    const expectedArgs = username
      ? [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          username,
          "-w",
        ]
      : ["find-generic-password", "-s", "Claude Code-credentials", "-w"];
    assert.deepEqual(calls, [
      {
        command: "security",
        args: expectedArgs,
        options: { encoding: "utf8" },
      },
    ]);
    assert.deepEqual(creds, {
      accessToken: "keychain-access",
      refreshToken: "keychain-refresh",
      expiresAt: keychainExpiresAt,
      source: "keychain",
      supportsUsageApi: true,
    });
  });

  it("uses a raw CLAUDE_CONFIG_DIR sha256 suffix for the Keychain service name", () => {
    const calls = [];
    const configDir = "~/.claude/.omc-launch";
    const expectedService = `Claude Code-credentials-${createHash("sha256")
      .update(configDir)
      .digest("hex")
      .slice(0, 8)}`;
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args, options) => {
        calls.push({ command, args, options });
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: "isolated-keychain-access",
            expiresAt: Date.now() + 60_000,
          },
        });
      },
      env: { CLAUDE_CONFIG_DIR: configDir },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], expectedService);
    assert.equal(creds.accessToken, "isolated-keychain-access");
  });

  it("uses the plain Keychain service name when CLAUDE_CONFIG_DIR is unset", () => {
    const calls = [];
    readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args) => {
        calls.push({ command, args });
        throw new Error("not found");
      },
      env: {},
    });

    assert.equal(calls[0].args[2], "Claude Code-credentials");
  });

  it("prefers an unexpired Keychain credential over an expired account credential", () => {
    const calls = [];
    const username = userInfo().username?.trim();
    const expiredAt = Date.now() - 60_000;
    const futureAt = Date.now() + 60_000;
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args) => {
        calls.push({ command, args });
        if (args.includes("-a")) {
          return JSON.stringify({
            claudeAiOauth: {
              accessToken: "expired-account-access",
              expiresAt: expiredAt,
            },
          });
        }
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: username
              ? "unexpired-service-access"
              : "unexpired-account-access",
            expiresAt: futureAt,
          },
        });
      },
      env: {},
    });

    assert.equal(
      creds.accessToken,
      username ? "unexpired-service-access" : "unexpired-account-access",
    );
    if (username) {
      assert.equal(calls.length, 2);
      assert.equal(calls[0].args[4], username);
    }
  });

  it("falls back to the first expired Keychain credential when none are unexpired", () => {
    const username = userInfo().username?.trim();
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args) =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: args.includes("-a")
              ? "expired-account-access"
              : "expired-service-access",
            expiresAt: Date.now() - 60_000,
          },
        }),
      env: {},
    });

    assert.equal(
      creds.accessToken,
      username ? "expired-account-access" : "expired-service-access",
    );
  });

  it("returns null when neither file nor keychain credentials exist", () => {
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: () => {
        throw new Error("not found");
      },
      env: {},
    });

    assert.equal(creds, null);
  });
});

describe("fetchClaudeUsageFromApi", () => {
  it("sends a Claude Code User-Agent with usage API requests", async () => {
    const originalRequest = https.request;
    let capturedOptions = null;

    https.request = (options, callback) => {
      capturedOptions = options;
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit("data", "{}");
          res.emit("end");
        });
      };
      req.destroy = () => {};
      return req;
    };

    try {
      await fetchClaudeUsageFromApi("access-token");
    } finally {
      https.request = originalRequest;
    }

    assert.match(
      capturedOptions.headers["User-Agent"],
      /^claude-code\/[A-Za-z0-9._-]+$/,
    );
  });
});

describe("writeBackClaudeCredentials", () => {
  it("writes refreshed macOS OAuth credentials to both file and Keychain", () => {
    const keychainCalls = [];
    let writtenFile = null;
    writeBackClaudeCredentials(
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 789,
        source: "file",
        supportsUsageApi: true,
      },
      {
        readCredentialFile: () => ({
          claudeAiOauth: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: 123,
          },
        }),
        writeCredentialFile: (data) => {
          writtenFile = data;
        },
        platform: "darwin",
        execFileSyncFn: (command, args, options) => {
          keychainCalls.push({ command, args, options });
        },
        env: {},
      },
    );

    assert.deepEqual(writtenFile, {
      claudeAiOauth: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 789,
      },
    });
    assert.equal(keychainCalls.length, 1);
    assert.equal(keychainCalls[0].command, "security");
    assert.deepEqual(keychainCalls[0].args.slice(0, 3), [
      "add-generic-password",
      "-s",
      "Claude Code-credentials",
    ]);
    const username = userInfo().username?.trim();
    if (username) {
      assert.deepEqual(keychainCalls[0].args.slice(3, 5), ["-a", username]);
      assert.equal(keychainCalls[0].args[5], "-w");
      assert.deepEqual(JSON.parse(keychainCalls[0].args[6]), writtenFile);
      assert.equal(keychainCalls[0].args[7], "-U");
    } else {
      assert.equal(keychainCalls[0].args[4], "-w");
      assert.deepEqual(JSON.parse(keychainCalls[0].args[5]), writtenFile);
      assert.equal(keychainCalls[0].args[6], "-U");
    }
    assert.deepEqual(keychainCalls[0].options, { stdio: "ignore" });
  });
});
