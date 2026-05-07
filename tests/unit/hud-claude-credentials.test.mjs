import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readClaudeCredentials,
  writeBackClaudeCredentials,
} from "../../hud/providers/claude.mjs";

describe("readClaudeCredentials", () => {
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
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args, options) => {
        calls.push({ command, args, options });
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: "keychain-access",
            refreshToken: "keychain-refresh",
            expiresAt: 456,
          },
        });
      },
      env: {},
    });

    assert.deepEqual(calls, [
      {
        command: "security",
        args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        options: { encoding: "utf8" },
      },
    ]);
    assert.deepEqual(creds, {
      accessToken: "keychain-access",
      refreshToken: "keychain-refresh",
      expiresAt: 456,
      source: "keychain",
      supportsUsageApi: true,
    });
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
    assert.deepEqual(keychainCalls[0].args.slice(0, 4), [
      "add-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    assert.deepEqual(JSON.parse(keychainCalls[0].args[4]), writtenFile);
    assert.equal(keychainCalls[0].args[5], "-U");
    assert.deepEqual(keychainCalls[0].options, { stdio: "ignore" });
  });
});
