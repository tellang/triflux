import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it } from "node:test";

import {
  buildSpawnSpec,
  quoteWindowsCmdArg,
} from "../../hub/workers/gemini-worker.mjs";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalExistsSync = fs.existsSync;

function setPlatform(value) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

function mockExistsSync(implementation) {
  fs.existsSync = implementation;
  syncBuiltinESMExports();
}

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  fs.existsSync = originalExistsSync;
  syncBuiltinESMExports();
});

describe("quoteWindowsCmdArg", () => {
  it("빈 문자열은 큰따옴표 쌍으로 감싼다", () => {
    assert.equal(quoteWindowsCmdArg(""), '""');
  });

  it("특수문자가 없으면 그대로 반환한다", () => {
    assert.equal(quoteWindowsCmdArg("gemini-cli"), "gemini-cli");
  });

  it("퍼센트 문자를 이스케이프한다", () => {
    assert.equal(quoteWindowsCmdArg("%PATH%"), '"%%PATH%%"');
  });

  it("공백이 있으면 큰따옴표로 감싼다", () => {
    assert.equal(quoteWindowsCmdArg("hello world"), '"hello world"');
  });

  it("줄바꿈은 공백으로 치환한다", () => {
    assert.equal(quoteWindowsCmdArg("hello\nworld"), '"hello world"');
  });

  it("큰따옴표를 이스케이프한다", () => {
    assert.equal(quoteWindowsCmdArg('say"hi'), '"say\\"hi"');
  });
});

describe("buildSpawnSpec", () => {
  it("non-Windows에서는 command/args를 그대로 유지한다", () => {
    setPlatform("linux");

    assert.deepEqual(buildSpawnSpec("gemini", ["--version"]), {
      command: "gemini",
      args: ["--version"],
      shell: false,
    });
  });

  it("Windows에서 .exe는 직접 실행한다", () => {
    setPlatform("win32");

    assert.deepEqual(buildSpawnSpec("C:/tools/gemini.exe", ["--version"]), {
      command: "C:/tools/gemini.exe",
      args: ["--version"],
      shell: false,
    });
  });

  it("Windows에서 .cmd는 cmd.exe를 경유한다", () => {
    setPlatform("win32");

    assert.deepEqual(
      buildSpawnSpec("C:/tools/gemini.cmd", ["--prompt", "hello world"]),
      {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/v:off",
          "/c",
          'C:/tools/gemini.cmd --prompt "hello world"',
        ],
        shell: false,
      },
    );
  });

  it("Windows에서 .bat도 cmd.exe를 경유한다", () => {
    setPlatform("win32");

    assert.deepEqual(buildSpawnSpec("C:/tools/gemini.bat", ["--flag"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", "C:/tools/gemini.bat --flag"],
      shell: false,
    });
  });

  it("Windows에서 확장자가 없으면 .exe/.cmd/.bat 순서로 탐색한다", () => {
    setPlatform("win32");
    const calls = [];

    mockExistsSync((candidate) => {
      calls.push(candidate);
      return candidate === "C:/tools/gemini.cmd";
    });

    assert.deepEqual(buildSpawnSpec("C:/tools/gemini", ["--help"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", "C:/tools/gemini.cmd --help"],
      shell: false,
    });
    assert.deepEqual(calls, ["C:/tools/gemini.exe", "C:/tools/gemini.cmd"]);
  });

  it("Windows에서 확장자 탐색이 전부 실패하면 원래 command를 그대로 반환한다", () => {
    setPlatform("win32");
    mockExistsSync(() => false);

    assert.deepEqual(buildSpawnSpec("C:/tools/gemini", ["--help"]), {
      command: "C:/tools/gemini",
      args: ["--help"],
      shell: false,
    });
  });
});
