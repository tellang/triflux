// tests/unit/gemini-worker-windows.test.mjs
// Windows `.cmd` shim spawn 버그 회귀 테스트 (issue #68)
//
// - escapeCmdArg: cmd.exe용 인자 quoting
// - resolveWindowsCommand: npm shim(`.cmd`)을 cmd.exe /d /s /c 경유로 변환

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  escapeCmdArg,
  resolveWindowsCommand,
} from "../../hub/workers/gemini-worker.mjs";

describe("escapeCmdArg", () => {
  it("특수문자가 없는 평범한 토큰은 그대로 반환", () => {
    assert.equal(escapeCmdArg("gemini-3.1-pro-preview"), "gemini-3.1-pro-preview");
    assert.equal(escapeCmdArg("--model"), "--model");
    assert.equal(escapeCmdArg("yolo"), "yolo");
  });

  it("빈 문자열은 `\"\"`로 보존되어 cmd.exe에서 빈 인자로 전달된다", () => {
    assert.equal(escapeCmdArg(""), '""');
  });

  it("공백이 포함되면 큰따옴표로 감싼다", () => {
    assert.equal(escapeCmdArg("hello world"), '"hello world"');
  });

  it("내부 큰따옴표는 `\\\"`로 이스케이프된다", () => {
    assert.equal(escapeCmdArg('say "hi"'), '"say \\"hi\\""');
  });

  it("cmd.exe 메타문자를 포함하면 quote된다", () => {
    assert.equal(escapeCmdArg("a&b"), '"a&b"');
    assert.equal(escapeCmdArg("a|b"), '"a|b"');
    assert.equal(escapeCmdArg("a^b"), '"a^b"');
    assert.equal(escapeCmdArg("a>b"), '"a>b"');
  });
});

describe("resolveWindowsCommand", () => {
  const isWin = process.platform === "win32";

  it("non-Windows 플랫폼에서는 변경 없이 통과", { skip: isWin }, () => {
    const result = resolveWindowsCommand("/usr/local/bin/gemini", ["--v"]);
    assert.equal(result.command, "/usr/local/bin/gemini");
    assert.deepEqual(result.args, ["--v"]);
    assert.equal(result.shell, false);
  });

  it("Windows + `.cmd` 경로는 cmd.exe /d /s /c 로 래핑된다", { skip: !isWin }, () => {
    const result = resolveWindowsCommand(
      "C:\\fake\\npm\\gemini.cmd",
      ["--model", "gemini-3.1-pro-preview", "--prompt", ""],
    );
    assert.equal(result.command, "cmd.exe");
    assert.equal(result.args[0], "/d");
    assert.equal(result.args[1], "/s");
    assert.equal(result.args[2], "/c");
    // 빈 문자열 인자가 `""`로 보존되어 gemini CLI가 `--prompt`를 옵션값으로 인식하게 한다
    assert.match(result.args[3], /--prompt ""/);
    assert.ok(result.args[3].includes("gemini.cmd"));
    assert.equal(result.shell, false);
  });

  it("Windows + `.exe` 경로는 shell 없이 직접 실행", { skip: !isWin }, () => {
    const result = resolveWindowsCommand("C:\\fake\\bin\\tool.exe", ["--v"]);
    assert.equal(result.command, "C:\\fake\\bin\\tool.exe");
    assert.deepEqual(result.args, ["--v"]);
    assert.equal(result.shell, false);
  });
});
