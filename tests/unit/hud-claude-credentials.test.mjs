import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CLAUDE_CREDENTIALS_PATH,
  getClaudeCredentialPaths,
} from "../../hud/constants.mjs";
import {
  fetchClaudeUsageFromApi,
  getKeychainAccount,
  getKeychainServiceName,
  readClaudeCredentials,
  readClaudeKeychainEntry,
  writeBackClaudeCredentials,
} from "../../hud/providers/claude.mjs";
import {
  computeLoginFingerprint,
  run as runClaudeLoginDetect,
} from "../../scripts/claude-login-detect.mjs";

function parseKeychainWrite(calls) {
  const stdinCall = calls.find((c) => c.args?.[0] === "-i");
  if (stdinCall) {
    const m = String(stdinCall.options?.input ?? "").match(
      /^add-generic-password -U -a "([^"]*)" -s "([^"]*)" -X "([0-9a-f]+)"\n$/,
    );
    if (!m) return null;
    return {
      via: "stdin",
      account: m[1],
      service: m[2],
      payload: JSON.parse(Buffer.from(m[3], "hex").toString("utf8")),
      options: stdinCall.options,
    };
  }
  const argvCall = calls.find((c) => c.args?.[0] === "add-generic-password");
  if (!argvCall) return null;
  const args = argvCall.args;
  const hexIdx = args.indexOf("-X");
  return {
    via: "argv",
    account: args[args.indexOf("-a") + 1],
    service: args[args.indexOf("-s") + 1],
    payload:
      hexIdx === -1
        ? null
        : JSON.parse(Buffer.from(args[hexIdx + 1], "hex").toString("utf8")),
    hasPlainPassword: args.includes("-w"),
    options: argvCall.options,
  };
}

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
      filePath: join(configDir, ".credentials.json"),
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
      filePath: CLAUDE_CREDENTIALS_PATH,
    });
  });

  it("keeps file credentials as the first priority on non-darwin platforms", () => {
    let keychainCalled = false;
    const creds = readClaudeCredentials({
      readCredentialFile: () => ({
        claudeAiOauth: {
          accessToken: "file-access",
          refreshToken: "file-refresh",
          expiresAt: 123,
        },
      }),
      platform: "linux",
      execFileSyncFn: () => {
        keychainCalled = true;
        throw new Error(
          "keychain should not be read when file credentials exist on non-darwin",
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
      filePath: CLAUDE_CREDENTIALS_PATH,
    });
    assert.equal(keychainCalled, false);
  });

  it("darwin 에서 파일과 Keychain 이 서로 다른 계정일 때 Keychain 이 이긴다", () => {
    const creds = readClaudeCredentials({
      readCredentialFile: () => ({
        claudeAiOauth: {
          accessToken: "file-account-access",
          refreshToken: "file-account-refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
      platform: "darwin",
      execFileSyncFn: (command, args) => {
        if (args[0] === "find-generic-password") {
          return JSON.stringify({
            claudeAiOauth: {
              accessToken: "keychain-account-access",
              refreshToken: "keychain-account-refresh",
              expiresAt: Date.now() + 60_000,
            },
          });
        }
        throw new Error("unexpected command");
      },
      env: {},
    });

    assert.equal(creds.accessToken, "keychain-account-access");
    assert.equal(creds.source, "keychain");
  });

  it("비 darwin 플랫폼에서는 파일 우선이 유지된다", () => {
    let keychainCalled = false;
    const creds = readClaudeCredentials({
      readCredentialFile: () => ({
        claudeAiOauth: {
          accessToken: "linux-file-access",
          refreshToken: "linux-file-refresh",
          expiresAt: 456,
        },
      }),
      platform: "linux",
      execFileSyncFn: () => {
        keychainCalled = true;
        throw new Error("keychain should not be called on linux");
      },
      env: {},
    });

    assert.equal(creds.accessToken, "linux-file-access");
    assert.equal(creds.source, "file");
    assert.equal(keychainCalled, false);
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

    const account = getKeychainAccount({});
    assert.deepEqual(calls, [
      {
        command: "security",
        args: [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          account,
          "-w",
        ],
        options: { encoding: "utf8" },
      },
    ]);
    assert.deepEqual(creds, {
      accessToken: "keychain-access",
      refreshToken: "keychain-refresh",
      expiresAt: keychainExpiresAt,
      source: "keychain",
      supportsUsageApi: true,
      keychainAccount: account,
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

  it("계정 항목이 만료됐어도 다른 계정 항목으로 내려가지 않고 만료 항목을 돌려준다", () => {
    const calls = [];
    const creds = readClaudeCredentials({
      readCredentialFile: () => null,
      platform: "darwin",
      execFileSyncFn: (command, args) => {
        calls.push({ command, args });
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-account-access",
            refreshToken: "expired-account-refresh",
            expiresAt: Date.now() - 60_000,
          },
        });
      },
      env: { USER: "alice" },
    });

    assert.equal(creds.accessToken, "expired-account-access");
    assert.equal(creds.keychainAccount, "alice");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(3, 5), ["-a", "alice"]);
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
  it("Keychain 출처 자격증명은 Keychain 에만 되쓰고 파일은 건드리지 않는다", () => {
    const keychainCalls = [];
    let writtenFile = null;
    writeBackClaudeCredentials(
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 789,
        source: "keychain",
        keychainAccount: getKeychainAccount({}),
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
          if (args[0] === "find-generic-password") {
            return JSON.stringify({
              claudeAiOauth: {
                accessToken: "old-access",
                refreshToken: "old-refresh",
                expiresAt: 123,
              },
            });
          }
        },
        env: {},
      },
    );

    assert.equal(writtenFile, null);
    const write = parseKeychainWrite(keychainCalls);
    assert.ok(write, "keychain write should have happened");
    assert.equal(write.via, "stdin");
    assert.equal(write.service, "Claude Code-credentials");
    assert.equal(write.account, getKeychainAccount({}));
    assert.deepEqual(write.payload, {
      claudeAiOauth: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 789,
      },
    });
  });

  it("source 가 file 인 자격증명은 Keychain 에 써지지 않는다", () => {
    const keychainCalls = [];
    let writtenFile = null;
    writeBackClaudeCredentials(
      {
        accessToken: "new-file-access",
        refreshToken: "new-file-refresh",
        expiresAt: 999,
        source: "file",
        supportsUsageApi: true,
      },
      {
        readCredentialFile: () => ({
          claudeAiOauth: {
            accessToken: "old-access",
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

    assert.equal(writtenFile?.claudeAiOauth?.accessToken, "new-file-access");
    assert.equal(keychainCalls.length, 0);
  });

  it("Keychain 쓰기가 기존 항목의 scopes 와 subscriptionType 을 보존한다", () => {
    const calls = [];
    writeBackClaudeCredentials(
      {
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 12345,
        source: "keychain",
        keychainAccount: "alice",
        supportsUsageApi: true,
      },
      {
        readCredentialFile: () => null,
        writeCredentialFile: () => {},
        platform: "darwin",
        execFileSyncFn: (command, args, options) => {
          calls.push({ command, args, options });
          if (args[0] === "find-generic-password") {
            return JSON.stringify({
              claudeAiOauth: {
                accessToken: "initial-access",
                refreshToken: "initial-refresh",
                expiresAt: 100,
                scopes: ["user:read", "org:admin"],
                subscriptionType: "team",
                rateLimitTier: "tier-4",
                refreshTokenExpiresAt: 99999,
              },
            });
          }
          return "";
        },
        env: {},
      },
    );

    const write = parseKeychainWrite(calls);
    assert.ok(write);
    assert.deepEqual(write.payload.claudeAiOauth, {
      accessToken: "refreshed-access",
      refreshToken: "refreshed-refresh",
      expiresAt: 12345,
      scopes: ["user:read", "org:admin"],
      subscriptionType: "team",
      rateLimitTier: "tier-4",
      refreshTokenExpiresAt: 99999,
    });
  });
});

describe("claude-login-detect", () => {
  it("darwin 에서 Keychain 자격증명 변경 시 HUD_CACHES 를 지우고 토큰 원문 대신 해시 지문을 저장한다", () => {
    const testDir = mkdtempSync(join(tmpdir(), "claude-login-test-"));
    try {
      const statePath = join(testDir, "claude-login-mtime.json");
      const cachePath = join(testDir, "test-cache.json");
      writeFileSync(cachePath, JSON.stringify({ cached: true }));

      const secretToken = "sk-ant-secret-token-123456789";
      const keychainContent = JSON.stringify({
        claudeAiOauth: {
          accessToken: secretToken,
        },
      });

      const result = runClaudeLoginDetect({
        platform: "darwin",
        env: {},
        credsPath: join(testDir, "non-existent-creds.json"),
        statePath,
        hudCaches: [cachePath],
        execFileSyncFn: (command, args) => {
          if (command === "security") {
            return keychainContent;
          }
          throw new Error("unexpected command");
        },
      });

      assert.equal(result.changed, true);
      assert.equal(result.cleared, 1);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const fingerprint =
        state.keychainFingerprints?.["Claude Code-credentials"];
      assert.equal(typeof fingerprint, "string");
      assert.equal(fingerprint.length, 64);
      const stateRaw = readFileSync(statePath, "utf8");
      assert.equal(stateRaw.includes(secretToken), false);
      assert.equal(
        fingerprint,
        createHash("sha256").update(secretToken).digest("hex"),
      );

      const secondResult = runClaudeLoginDetect({
        platform: "darwin",
        env: {},
        credsPath: join(testDir, "non-existent-creds.json"),
        statePath,
        hudCaches: [cachePath],
        execFileSyncFn: () => keychainContent,
      });
      assert.equal(secondResult.changed, false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("파일 mtime 변경 감지 동작을 유지한다", () => {
    const testDir = mkdtempSync(join(tmpdir(), "claude-login-file-test-"));
    try {
      const statePath = join(testDir, "claude-login-mtime.json");
      const credsPath = join(testDir, ".credentials.json");
      const cachePath = join(testDir, "test-cache.json");
      writeFileSync(credsPath, JSON.stringify({ accessToken: "abc" }));
      writeFileSync(cachePath, JSON.stringify({ cached: true }));

      const result = runClaudeLoginDetect({
        platform: "linux",
        credsPath,
        statePath,
        hudCaches: [cachePath],
      });

      assert.equal(result.changed, true);
      assert.equal(result.cleared, 1);

      const secondResult = runClaudeLoginDetect({
        platform: "linux",
        credsPath,
        statePath,
        hudCaches: [cachePath],
      });
      assert.equal(secondResult.changed, false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("Keychain 서비스명·계정 규칙 (Claude Code 2.1.x 정합)", () => {
  it("CLAUDE_SECURESTORAGE_CONFIG_DIR 가 빈 문자열이면 CLAUDE_CONFIG_DIR 이 있어도 기본 서비스명이다", () => {
    assert.equal(
      getKeychainServiceName({
        CLAUDE_CONFIG_DIR: "/tmp/other",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      }),
      "Claude Code-credentials",
    );
  });

  it("CLAUDE_SECURESTORAGE_CONFIG_DIR 가 있으면 NFC 정규화한 값의 sha256 앞 8자리를 붙인다", () => {
    const dir = "/tmp/한글-스코프".normalize("NFD");
    const expected = `Claude Code-credentials-${createHash("sha256")
      .update(dir.normalize("NFC"))
      .digest("hex")
      .slice(0, 8)}`;
    assert.equal(
      getKeychainServiceName({
        CLAUDE_CONFIG_DIR: "/tmp/other",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
      }),
      expected,
    );
  });

  it("평문 폴백 파일 경로도 CLAUDE_SECURESTORAGE_CONFIG_DIR 를 같은 규칙으로 따른다", () => {
    assert.deepEqual(
      getClaudeCredentialPaths({
        CLAUDE_CONFIG_DIR: "/tmp/other",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      }),
      [CLAUDE_CREDENTIALS_PATH],
    );
    assert.deepEqual(
      getClaudeCredentialPaths({
        CLAUDE_CONFIG_DIR: "/tmp/other",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/secure",
      }),
      [join("/tmp/secure", ".credentials.json"), CLAUDE_CREDENTIALS_PATH],
    );
    assert.deepEqual(
      getClaudeCredentialPaths({ CLAUDE_CONFIG_DIR: "/tmp/x" }),
      [join("/tmp/x", ".credentials.json"), CLAUDE_CREDENTIALS_PATH],
    );
  });

  it("계정은 USER 환경변수를 우선하고 허용 문자 밖이면 claude-code-user 로 대체한다", () => {
    assert.equal(getKeychainAccount({ USER: "alice.b-1_" }), "alice.b-1_");
    assert.equal(getKeychainAccount({ USER: "bad user!" }), "claude-code-user");
    const fromOs = getKeychainAccount({});
    assert.equal(typeof fromOs, "string");
    assert.match(fromOs, /^[a-zA-Z0-9._-]+$/);
  });

  it("readClaudeKeychainEntry 는 계정 항목을 먼저 읽고 원문·계정·서비스명을 돌려준다", () => {
    const calls = [];
    const entry = readClaudeKeychainEntry({
      env: { USER: "alice" },
      execFileSyncFn: (_command, args) => {
        calls.push(args);
        return JSON.stringify({
          claudeAiOauth: { accessToken: "a", refreshToken: "r" },
        });
      },
    });
    assert.deepEqual(calls, [
      [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        "alice",
        "-w",
      ],
    ]);
    assert.deepEqual(entry, {
      raw: { claudeAiOauth: { accessToken: "a", refreshToken: "r" } },
      account: "alice",
      serviceName: "Claude Code-credentials",
    });
  });

  it("readClaudeKeychainEntry 는 계정 항목이 없으면 null 이고 -a 없는 조회를 하지 않는다", () => {
    const calls = [];
    const entry = readClaudeKeychainEntry({
      env: { USER: "alice" },
      execFileSyncFn: (_command, args) => {
        calls.push(args);
        throw new Error("not found");
      },
    });
    assert.equal(entry, null);
    assert.equal(calls.length, 1);
    assert.ok(calls.every((args) => args.includes("-a")));
  });
});

describe("writeBackClaudeCredentials 출처 일치", () => {
  it("Keychain 되쓰기는 읽은 계정 항목(keychainAccount)에 쓰고 현재 USER 로 바꾸지 않는다", () => {
    const calls = [];
    writeBackClaudeCredentials(
      {
        accessToken: "n",
        refreshToken: "r",
        expiresAt: 1,
        source: "keychain",
        keychainAccount: "alice",
        supportsUsageApi: true,
      },
      {
        readCredentialFile: () => {
          throw new Error("file must not be read for keychain source");
        },
        writeCredentialFile: () => {
          throw new Error("file must not be written for keychain source");
        },
        platform: "darwin",
        execFileSyncFn: (command, args, options) => {
          calls.push({ command, args, options });
          if (args[0] === "find-generic-password") {
            return JSON.stringify({
              claudeAiOauth: { accessToken: "o", scopes: ["s"] },
            });
          }
          return "";
        },
        env: { USER: "bob" },
      },
    );
    const findCalls = calls.filter(
      (c) => c.args[0] === "find-generic-password",
    );
    assert.deepEqual(
      findCalls.map((c) => c.args),
      [
        [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          "alice",
          "-w",
        ],
      ],
    );
    const write = parseKeychainWrite(calls);
    assert.equal(write.via, "stdin");
    assert.equal(write.account, "alice");
    assert.equal(write.service, "Claude Code-credentials");
    assert.deepEqual(write.payload, {
      claudeAiOauth: {
        accessToken: "n",
        scopes: ["s"],
        expiresAt: 1,
        refreshToken: "r",
      },
    });
  });

  it("Keychain 쓰기는 비밀값을 argv 에 두지 않고 security -i 표준입력으로 넘긴다", () => {
    const calls = [];
    writeBackClaudeCredentials(
      {
        accessToken: "secret-access",
        refreshToken: "secret-refresh",
        expiresAt: 1,
        source: "keychain",
        keychainAccount: "alice",
        supportsUsageApi: true,
      },
      {
        platform: "darwin",
        execFileSyncFn: (command, args, options) => {
          calls.push({ command, args, options });
          if (args[0] === "find-generic-password") throw new Error("absent");
          return "";
        },
        env: {},
      },
    );
    const writeCall = calls.find((c) => c.args[0] !== "find-generic-password");
    assert.deepEqual(writeCall.args, ["-i"]);
    assert.equal(JSON.stringify(writeCall.args).includes("secret-"), false);
    assert.deepEqual(writeCall.options.stdio, ["pipe", "ignore", "ignore"]);
    assert.match(writeCall.options.input, /-X "[0-9a-f]+"\n$/);
    assert.equal(writeCall.options.input.includes("secret-"), false);
    const write = parseKeychainWrite(calls);
    assert.deepEqual(write.payload, {
      claudeAiOauth: {
        accessToken: "secret-access",
        expiresAt: 1,
        refreshToken: "secret-refresh",
      },
    });
  });

  it("한 줄 상한(4032B)을 넘는 큰 항목은 -X 16진수 argv 로 내려간다", () => {
    const calls = [];
    const big = "x".repeat(3000);
    writeBackClaudeCredentials(
      {
        accessToken: "n",
        source: "keychain",
        keychainAccount: "alice",
        supportsUsageApi: true,
      },
      {
        platform: "darwin",
        execFileSyncFn: (command, args, options) => {
          calls.push({ command, args, options });
          if (args[0] === "find-generic-password") {
            return JSON.stringify({
              claudeAiOauth: { accessToken: "o", mcpOAuth: { blob: big } },
            });
          }
          return "";
        },
        env: {},
      },
    );
    const write = parseKeychainWrite(calls);
    assert.equal(write.via, "argv");
    assert.equal(write.hasPlainPassword, false);
    assert.equal(write.account, "alice");
    assert.equal(write.payload.claudeAiOauth.mcpOAuth.blob, big);
    assert.equal(write.payload.claudeAiOauth.accessToken, "n");
  });

  it("file 출처 자격증명은 읽은 파일 경로에 되쓴다", () => {
    const written = [];
    writeBackClaudeCredentials(
      {
        accessToken: "n",
        refreshToken: "r",
        expiresAt: 5,
        source: "file",
        filePath: "/tmp/scoped/.credentials.json",
        supportsUsageApi: true,
      },
      {
        readCredentialFile: (filePath) => ({
          readFrom: filePath,
          claudeAiOauth: { accessToken: "o", subscriptionType: "pro" },
        }),
        writeCredentialFile: (data, filePath) => {
          written.push({ data, filePath });
        },
        platform: "darwin",
        execFileSyncFn: () => {
          throw new Error("keychain must not be touched for file source");
        },
        env: {},
      },
    );
    assert.equal(written.length, 1);
    assert.equal(written[0].filePath, "/tmp/scoped/.credentials.json");
    assert.equal(written[0].data.readFrom, "/tmp/scoped/.credentials.json");
    assert.deepEqual(written[0].data.claudeAiOauth, {
      accessToken: "n",
      subscriptionType: "pro",
      expiresAt: 5,
      refreshToken: "r",
    });
  });

  it("비 darwin 에서 keychain 출처는 아무것도 쓰지 않는다", () => {
    let touched = false;
    writeBackClaudeCredentials(
      {
        accessToken: "n",
        source: "keychain",
        keychainAccount: "x",
        supportsUsageApi: true,
      },
      {
        readCredentialFile: () => {
          touched = true;
          return null;
        },
        writeCredentialFile: () => {
          touched = true;
        },
        platform: "linux",
        execFileSyncFn: () => {
          touched = true;
          return "";
        },
        env: {},
      },
    );
    assert.equal(touched, false);
  });
});

describe("claude-login-detect 로그인 지문", () => {
  function withTempDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), "claude-login-fp-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("지문은 refreshToken 기준이라 accessToken 만 갱신되면 바뀌지 않는다", () => {
    const a = computeLoginFingerprint({
      claudeAiOauth: { accessToken: "t1", refreshToken: "R" },
    });
    const b = computeLoginFingerprint({
      claudeAiOauth: { accessToken: "t2", refreshToken: "R" },
    });
    const c = computeLoginFingerprint({
      claudeAiOauth: { accessToken: "t2", refreshToken: "R2" },
    });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a, createHash("sha256").update("R").digest("hex"));
    assert.equal(
      computeLoginFingerprint({ claudeAiOauth: { accessToken: "only" } }),
      createHash("sha256").update("only").digest("hex"),
    );
  });

  it("8시간 토큰 갱신만으로는 HUD 캐시를 지우지 않고, 재로그인(refreshToken 변경)에는 지운다", () => {
    withTempDir((dir) => {
      const statePath = join(dir, "state.json");
      const cachePath = join(dir, "cache.json");
      const credsPath = join(dir, "missing.json");
      const payload = (accessToken, refreshToken) =>
        JSON.stringify({ claudeAiOauth: { accessToken, refreshToken } });
      const runWith = (content) =>
        runClaudeLoginDetect({
          platform: "darwin",
          env: {},
          credsPath,
          statePath,
          hudCaches: [cachePath],
          execFileSyncFn: () => content,
        });

      writeFileSync(cachePath, "{}");
      assert.equal(runWith(payload("t1", "R")).changed, true);

      writeFileSync(cachePath, "{}");
      const refreshedOnly = runWith(payload("t2", "R"));
      assert.equal(refreshedOnly.changed, false);
      assert.equal(existsSync(cachePath), true);

      const relogin = runWith(payload("t3", "R2"));
      assert.equal(relogin.changed, true);
      assert.equal(existsSync(cachePath), false);
    });
  });

  it("CLAUDE_CONFIG_DIR 스코프별로 지문을 따로 기억해 세션이 번갈아 떠도 캐시를 반복 삭제하지 않는다", () => {
    withTempDir((dir) => {
      const statePath = join(dir, "state.json");
      const cachePath = join(dir, "cache.json");
      const credsPath = join(dir, "missing.json");
      const plainEnv = {};
      const scopedEnv = { CLAUDE_CONFIG_DIR: "/tmp/omc-launch" };
      const runWith = (env, refreshToken) =>
        runClaudeLoginDetect({
          platform: "darwin",
          env,
          credsPath,
          statePath,
          hudCaches: [cachePath],
          execFileSyncFn: () =>
            JSON.stringify({
              claudeAiOauth: { accessToken: "a", refreshToken },
            }),
        });

      assert.equal(runWith(plainEnv, "plain").changed, true);
      assert.equal(runWith(scopedEnv, "scoped").changed, true);
      assert.equal(runWith(plainEnv, "plain").changed, false);
      assert.equal(runWith(scopedEnv, "scoped").changed, false);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.deepEqual(Object.keys(state.keychainFingerprints).sort(), [
        "Claude Code-credentials",
        getKeychainServiceName(scopedEnv),
      ]);
    });
  });

  it("credsPath 를 넘기지 않으면 CLAUDE_CONFIG_DIR 스코프의 .credentials.json 을 본다", () => {
    withTempDir((dir) => {
      const env = { CLAUDE_CONFIG_DIR: dir };
      const scopedCreds = getClaudeCredentialPaths(env)[0];
      assert.equal(scopedCreds, join(dir, ".credentials.json"));
      writeFileSync(scopedCreds, JSON.stringify({ accessToken: "abc" }));
      const statePath = join(dir, "state.json");
      const cachePath = join(dir, "cache.json");
      writeFileSync(cachePath, "{}");

      const result = runClaudeLoginDetect({
        platform: "linux",
        env,
        statePath,
        hudCaches: [cachePath],
      });
      assert.equal(result.changed, true);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(
        state.fileMtimes[scopedCreds],
        statSync(scopedCreds).mtimeMs,
      );
    });
  });

  it("파일 mtime 도 경로별로 기억해 파일이 있는 두 스코프가 번갈아 떠도 반복 삭제하지 않는다", () => {
    withTempDir((dir) => {
      const plainCreds = join(dir, "plain.json");
      const scopedCreds = join(dir, "scoped.json");
      writeFileSync(plainCreds, JSON.stringify({ accessToken: "p" }));
      writeFileSync(scopedCreds, JSON.stringify({ accessToken: "s" }));
      const statePath = join(dir, "state.json");
      const cachePath = join(dir, "cache.json");
      const runWith = (credsPath) => {
        writeFileSync(cachePath, "{}");
        return runClaudeLoginDetect({
          platform: "linux",
          env: {},
          credsPath,
          statePath,
          hudCaches: [cachePath],
        });
      };
      assert.equal(runWith(plainCreds).changed, true);
      assert.equal(runWith(scopedCreds).changed, true);
      assert.equal(runWith(plainCreds).changed, false);
      assert.equal(runWith(scopedCreds).changed, false);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.deepEqual(
        Object.keys(state.fileMtimes).sort(),
        [plainCreds, scopedCreds].sort(),
      );
    });
  });

  it("스코프 경로에 파일이 없으면 기본 경로 파일의 변경도 감지한다 (readClaudeCredentials 폴백과 같은 후보)", () => {
    withTempDir((dir) => {
      const scopeDir = join(dir, "scope");
      const defaultCreds = join(dir, "default.json");
      writeFileSync(defaultCreds, JSON.stringify({ accessToken: "d" }));
      const statePath = join(dir, "state.json");
      const cachePath = join(dir, "cache.json");
      const candidates = [join(scopeDir, ".credentials.json"), defaultCreds];
      const runOnce = () => {
        writeFileSync(cachePath, "{}");
        return runClaudeLoginDetect({
          platform: "linux",
          env: {},
          credsPaths: candidates,
          statePath,
          hudCaches: [cachePath],
        });
      };
      assert.equal(runOnce().changed, true);
      assert.equal(runOnce().changed, false);
      const bumped = new Date(Date.now() + 5_000);
      utimesSync(defaultCreds, bumped, bumped);
      assert.equal(runOnce().changed, true);
    });
  });
});
