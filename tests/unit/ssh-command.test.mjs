// tests/unit/ssh-command.test.mjs

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  buildSshArgs,
  commandJoin,
  getHostConfig,
  nullDevice,
  resetHostsCache,
  resolveHostAlias,
  selectHostByResources,
  selectHostForCapability,
  shellQuoteForHost,
  suppressStderr,
  validateCommandForOs,
} from "../../hub/lib/ssh-command.mjs";

describe("ssh-command", () => {
  beforeEach(() => resetHostsCache());

  describe("shellQuoteForHost", () => {
    it("posix: 싱글쿼트 래핑 + 내부 이스케이프", () => {
      assert.equal(shellQuoteForHost("hello", "posix"), "'hello'");
      assert.equal(shellQuoteForHost("it's", "posix"), "'it'\\''s'");
    });

    it("windows: 싱글쿼트 래핑 + 내부 더블링", () => {
      assert.equal(shellQuoteForHost("hello", "windows"), "'hello'");
      assert.equal(shellQuoteForHost("it's", "windows"), "'it''s'");
    });
  });

  describe("suppressStderr", () => {
    it("posix → 2>/dev/null", () => {
      assert.equal(suppressStderr("posix"), "2>/dev/null");
    });

    it("windows → 2>$null", () => {
      assert.equal(suppressStderr("windows"), "2>$null");
    });
  });

  describe("commandJoin", () => {
    it("posix → &&", () => {
      assert.equal(commandJoin("posix"), " && ");
    });

    it("windows → ;", () => {
      assert.equal(commandJoin("windows"), "; ");
    });
  });

  describe("nullDevice", () => {
    it("posix → /dev/null", () => {
      assert.equal(nullDevice("posix"), "/dev/null");
    });

    it("windows → $null", () => {
      assert.equal(nullDevice("windows"), "$null");
    });
  });

  describe("buildSshArgs", () => {
    it("기본 psmux 명령 SSH 인자 생성 (keepalive 포함)", () => {
      const args = buildSshArgs(
        "user@host",
        ["psmux", "has-session", "-t", "my-session"],
        {
          os: "posix",
        },
      );
      assert.deepEqual(args, [
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "user@host",
        "psmux 'has-session' '-t' 'my-session'",
      ]);
    });

    it("Windows 호스트에 맞는 쿼팅 적용", () => {
      const args = buildSshArgs(
        "SSAFY@ultra4",
        ["psmux", "has-session", "-t", "it's"],
        {
          os: "windows",
        },
      );
      const remoteCmdStr = args[args.length - 1];
      assert.ok(remoteCmdStr.includes("'it''s'"), "PowerShell 쿼팅 적용");
    });

    it("connectTimeout 커스텀", () => {
      const args = buildSshArgs("host", ["psmux", "ls"], {
        os: "posix",
        connectTimeout: 10,
      });
      assert.equal(args[1], "ConnectTimeout=10");
    });

    it("기본 keepalive 활성화", () => {
      const args = buildSshArgs("host", ["echo", "hi"], { os: "posix" });
      assert.ok(
        args.includes("ServerAliveInterval=30"),
        "ServerAliveInterval 포함",
      );
      assert.ok(
        args.includes("ServerAliveCountMax=3"),
        "ServerAliveCountMax 포함",
      );
    });

    it("keepalive=false로 비활성화", () => {
      const args = buildSshArgs("host", ["echo", "hi"], {
        os: "posix",
        keepalive: false,
      });
      assert.ok(
        !args.includes("ServerAliveInterval=30"),
        "ServerAliveInterval 미포함",
      );
    });
  });

  describe("validateCommandForOs", () => {
    it("Windows에서 bash 문법 감지", () => {
      const result = validateCommandForOs(
        "git status 2>/dev/null && echo done",
        "windows",
      );
      assert.equal(result.safe, false);
      assert.ok(result.violations.length >= 2);
    });

    it("posix에서는 bash 문법 허용", () => {
      const result = validateCommandForOs(
        "git status 2>/dev/null && echo done",
        "posix",
      );
      assert.equal(result.safe, true);
      assert.equal(result.violations.length, 0);
    });

    it("Windows에서 안전한 명령은 통과", () => {
      const result = validateCommandForOs(
        "psmux has-session -t my-session",
        "windows",
      );
      assert.equal(result.safe, true);
    });
  });

  describe("getHostConfig", () => {
    it("존재하는 호스트 설정 반환", () => {
      const cfg = getHostConfig("ultra4");
      assert.ok(cfg, "ultra4 설정 존재");
      assert.equal(cfg.os, "windows");
    });

    it("없는 호스트는 null 반환", () => {
      assert.equal(getHostConfig("nonexistent"), null);
    });
  });

  describe("resolveHostAlias", () => {
    it("정확한 키로 해결", () => {
      assert.equal(resolveHostAlias("ultra4"), "ultra4");
    });

    it("aliases 배열 내 값으로 해결", () => {
      const key = resolveHostAlias("울트라");
      assert.equal(key, "ultra4");
    });

    it("없는 별칭은 null", () => {
      assert.equal(resolveHostAlias("unknown-alias"), null);
    });
  });

  describe("selectHostForCapability", () => {
    it("codex capability 매칭", () => {
      const hosts = selectHostForCapability("codex");
      assert.ok(hosts.length > 0, "codex capable 호스트 존재");
      assert.equal(hosts[0].name, "ultra4");
      assert.deepEqual(hosts[0].specs, { cores: 22, ram_gb: 64 });
    });

    it("없는 capability는 빈 배열", () => {
      const hosts = selectHostForCapability("quantum-computing");
      assert.equal(hosts.length, 0);
    });
  });

  describe("selectHostByResources", () => {
    it("cores 기준 정렬된 명시적 선택 목록 반환", () => {
      const hosts = selectHostByResources("codex", "cores");
      assert.ok(hosts.length > 0, "codex capable 호스트 존재");
      assert.equal(hosts[0].name, "ultra4");
      assert.deepEqual(hosts[0].specs, { cores: 22, ram_gb: 64 });
    });

    it("ram_gb 기준 정렬된 명시적 선택 목록 반환", () => {
      const hosts = selectHostByResources("codex", "ram_gb");
      assert.ok(hosts.length > 0, "codex capable 호스트 존재");
      assert.equal(hosts[0].specs.ram_gb, 64);
    });

    it("지원하지 않는 sortBy는 예외", () => {
      assert.throws(
        () => selectHostByResources("codex", "disk_tb"),
        /sortBy must be "cores" or "ram_gb"/,
      );
    });
  });
});
