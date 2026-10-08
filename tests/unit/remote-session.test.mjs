// tests/unit/remote-session.test.mjs — remote-session 모듈 단위 테스트 (Lake 3)

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import {
  escapePwshDoubleQuoted,
  escapePwshSingleQuoted,
  isEnvCacheFresh,
  remoteEnvCacheDir,
  resolveRemoteDir,
  resolveRemoteStageDir,
  shellQuote,
  validateHost,
} from "../../hub/team/remote-session.mjs";

const WIN_ENV = Object.freeze({
  home: "C:\\Users\\test",
  os: "win32",
  shell: "pwsh",
  claudePath: "C:\\Users\\test\\.local\\bin\\claude.exe",
});
const LINUX_ENV = Object.freeze({
  home: "/home/test",
  os: "linux",
  shell: "bash",
  claudePath: "/home/test/.local/bin/claude",
});
const DARWIN_ENV = Object.freeze({
  home: "/Users/test",
  os: "darwin",
  shell: "zsh",
  claudePath: "/Users/test/.local/bin/claude",
});

describe("remote-session — validateHost", () => {
  it("R-01: 유효한 호스트명 통과", () => {
    assert.equal(validateHost("ultra4"), "ultra4");
    assert.equal(validateHost("my-server.local"), "my-server.local");
    assert.equal(validateHost("192.168.1.1"), "192.168.1.1");
  });

  it("R-02: 위험한 호스트명 거부", () => {
    assert.throws(() => validateHost("host;rm -rf"), /invalid host/);
    assert.throws(() => validateHost("host$(cmd)"), /invalid host/);
    assert.throws(() => validateHost(""), /invalid host/);
    assert.throws(() => validateHost(null), /invalid host/);
  });
});

describe("remote-session — shell quoting", () => {
  it("R-03: shellQuote — single quotes escaped", () => {
    assert.equal(shellQuote("hello"), "'hello'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  it("R-04: escapePwshSingleQuoted — doubles single quotes", () => {
    assert.equal(escapePwshSingleQuoted("it's"), "it''s");
    // PowerShell 은 U+2018~U+201B 도 작은따옴표로 읽는다
    assert.equal(
      escapePwshSingleQuoted("a\u2019b\u2018c"),
      "a\u2019\u2019b\u2018\u2018c",
    );
  });

  it("R-05: escapePwshDoubleQuoted — escapes backticks and double quotes", () => {
    assert.equal(escapePwshDoubleQuoted('say "hello"'), 'say `"hello`"');
    assert.equal(escapePwshDoubleQuoted("`tick`"), "``tick``");
    assert.equal(escapePwshDoubleQuoted("$(x)\u201D"), "`$(x)`\u201D");
  });
});

describe("remote-session — resolveRemoteDir", () => {
  it("R-06: Linux — ~ 확장, 절대경로, 상대경로", () => {
    assert.equal(resolveRemoteDir("~", LINUX_ENV), "/home/test");
    assert.equal(
      resolveRemoteDir("~/projects", LINUX_ENV),
      "/home/test/projects",
    );
    assert.equal(resolveRemoteDir("/opt/app", LINUX_ENV), "/opt/app");
    assert.equal(
      resolveRemoteDir("projects", LINUX_ENV),
      "/home/test/projects",
    );
    assert.equal(resolveRemoteDir("", LINUX_ENV), "/home/test");
  });

  it("R-07: macOS — 동일 posix 로직", () => {
    assert.equal(
      resolveRemoteDir("~/Desktop", DARWIN_ENV),
      "/Users/test/Desktop",
    );
    assert.equal(resolveRemoteDir("", DARWIN_ENV), "/Users/test");
  });

  it("R-08: Windows — backslash 정규화 + 절대경로", () => {
    assert.equal(resolveRemoteDir("~", WIN_ENV), "C:\\Users\\test");
    assert.equal(resolveRemoteDir("C:\\Projects", WIN_ENV), "C:\\Projects");
    assert.equal(
      resolveRemoteDir("Desktop", WIN_ENV),
      "C:\\Users\\test\\Desktop",
    );
  });
});

describe("remote-session — resolveRemoteStageDir", () => {
  it("R-09: Linux staging path 포맷", () => {
    const result = resolveRemoteStageDir(LINUX_ENV, "swarm-test-123");
    assert.equal(result, "/home/test/tfx-remote/swarm-test-123");
  });

  it("R-10: Windows staging path — forward slash 정규화", () => {
    const result = resolveRemoteStageDir(WIN_ENV, "swarm-test-456");
    assert.ok(result.includes("tfx-remote/swarm-test-456"));
    assert.ok(!result.includes("\\\\"));
  });
});

describe("remote-session: env cache", () => {
  it("R-11: 캐시는 cwd 가 아니라 사용자 상태 경로에 둔다", () => {
    const stateHome = join(tmpdir(), "state");
    assert.equal(
      remoteEnvCacheDir({ XDG_STATE_HOME: stateHome }),
      join(stateHome, "triflux", "remote-env"),
    );
    assert.equal(
      isAbsolute(remoteEnvCacheDir({ XDG_STATE_HOME: ".state" })),
      true,
    );
  });

  it("R-12: 미래 cachedAt 은 신선하지 않다", () => {
    const now = 1_000_000_000;
    assert.equal(isEnvCacheFresh({ cachedAt: now - 1000, env: {} }, now), true);
    assert.equal(
      isEnvCacheFresh({ cachedAt: now + 1000, env: {} }, now),
      false,
    );
  });
});
