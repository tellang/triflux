// tests/unit/tfx-route-preflight-all-dead.test.mjs
// #148: _mcp_preflight_filter_dead — profile-allowed 전부 dead 엣지케이스.
// 빈 allowed_pat 이 _codex_config_swap fail-safe (#132) 를 통해 원본 config
// 전체를 유지시키는 역효과를 early-fail (rc=78) 로 차단한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "tfx-route.sh");

function extractPreflightFunction() {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const start = source.indexOf("_mcp_preflight_filter_dead() {");
  assert.ok(start >= 0, "_mcp_preflight_filter_dead 정의를 찾을 수 없음");
  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

function runPreflight({
  flags = [],
  deadList = "",
  envVars = {},
  probeFails = false,
}) {
  const dir = mkdtempSync(path.join(tmpdir(), "tfx-preflight-"));
  const fakeHealth = path.join(dir, "fake-health.sh");
  const body = probeFails
    ? `#!/usr/bin/env bash\nexit 1\n`
    : `#!/usr/bin/env bash\necho 'MCP_DEAD="${deadList}"'\n`;
  writeFileSync(fakeHealth, body, { mode: 0o755 });

  const funcDef = extractPreflightFunction();
  const flagsLiteral = flags.map((f) => `'${f}'`).join(" ");
  const envExport = Object.entries(envVars)
    .map(([k, v]) => `export ${k}='${v}'`)
    .join("\n");

  const script = `
set -u
${envExport}
NODE_BIN=bash
TFX_MCP_HEALTH_SCRIPT='${fakeHealth}'
_get_script_dir() { echo '${dir}'; }
_resolve_script() { for arg in "$@"; do [[ -n "$arg" ]] && { echo "$arg"; return 0; }; done; return 1; }
CODEX_CONFIG_FLAGS=(${flagsLiteral})
${funcDef}
_preflight_rc=0
_mcp_preflight_filter_dead || _preflight_rc=$?
echo "PREFLIGHT_RC=$_preflight_rc"
echo "REMAINING_COUNT=\${#CODEX_CONFIG_FLAGS[@]}"
for f in "\${CODEX_CONFIG_FLAGS[@]}"; do
  echo "FLAG=$f"
done
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  const stdout = result.stdout || "";
  const rcMatch = stdout.match(/PREFLIGHT_RC=(\d+)/);
  const countMatch = stdout.match(/REMAINING_COUNT=(\d+)/);
  const flagLines = stdout
    .split("\n")
    .filter((l) => l.startsWith("FLAG="))
    .map((l) => l.slice(5));
  return {
    exitCode: result.status,
    preflightRc: rcMatch ? Number(rcMatch[1]) : null,
    remainingCount: countMatch ? Number(countMatch[1]) : null,
    remainingFlags: flagLines,
    stderr: result.stderr || "",
    stdout,
    dir,
  };
}

describe("#148 _mcp_preflight_filter_dead — all-dead early fail", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("baseline: some dead + some alive → filters dead, returns 0", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.alive1.enabled=true",
        "-c",
        "mcp_servers.dead1.enabled=true",
        "-c",
        "mcp_servers.alive2.enabled=true",
      ],
      deadList: "dead1",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.equal(result.remainingCount, 4);
    assert.deepEqual(result.remainingFlags, [
      "-c",
      "mcp_servers.alive1.enabled=true",
      "-c",
      "mcp_servers.alive2.enabled=true",
    ]);
    assert.match(result.stderr, /1개 dead MCP 제외 \(dead1\)/);
  });

  it("all-dead: profile 전부 dead → rc=78 조기 실패", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.dead1.enabled=true",
        "-c",
        "mcp_servers.dead2.enabled=true",
      ],
      deadList: "dead1,dead2",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 78, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /조기 실패.*MCP 전부 dead/);
    assert.match(result.stderr, /TFX_MCP_ALLOW_ALL_DEAD=1/);
  });

  it("all-dead + TFX_MCP_ALLOW_ALL_DEAD=1 → rc=0 degraded 진행", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.dead1.enabled=true",
        "-c",
        "mcp_servers.dead2.enabled=true",
      ],
      deadList: "dead1,dead2",
      envVars: { TFX_MCP_ALLOW_ALL_DEAD: "1" },
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /TFX_MCP_ALLOW_ALL_DEAD=1/);
    assert.match(result.stderr, /degraded/);
    assert.equal(result.remainingCount, 0);
  });

  it("none-dead: no dead servers → rc=0, no filter changes", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.alive1.enabled=true",
        "-c",
        "mcp_servers.alive2.enabled=true",
      ],
      deadList: "",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.equal(result.remainingCount, 4);
    assert.deepEqual(result.remainingFlags, [
      "-c",
      "mcp_servers.alive1.enabled=true",
      "-c",
      "mcp_servers.alive2.enabled=true",
    ]);
  });

  it("TFX_MCP_HEALTH_CHECK=0: opt-out → rc=0, no probe", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.dead1.enabled=true",
        "-c",
        "mcp_servers.dead2.enabled=true",
      ],
      deadList: "dead1,dead2",
      envVars: { TFX_MCP_HEALTH_CHECK: "0" },
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.equal(result.remainingCount, 4);
    assert.doesNotMatch(result.stderr, /조기 실패/);
    assert.doesNotMatch(result.stderr, /dead MCP 제외/);
  });

  it("probe failure: health script exit!=0 → rc=0, skip silently", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.alive1.enabled=true",
        "-c",
        "mcp_servers.dead1.enabled=true",
      ],
      probeFails: true,
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /preflight probe 실패/);
    assert.equal(result.remainingCount, 4);
  });

  it("empty CODEX_CONFIG_FLAGS → rc=0 early return", () => {
    const result = runPreflight({
      flags: [],
      deadList: "",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.equal(result.remainingCount, 0);
    assert.doesNotMatch(result.stderr, /조기 실패/);
  });

  it("non-enabled-true flags only: names 비어있으면 probe 스킵 → rc=0", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.foo.enabled=false",
        "-c",
        "approval_mode=auto",
      ],
      deadList: "",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.equal(result.remainingCount, 4);
    assert.doesNotMatch(result.stderr, /조기 실패/);
    assert.doesNotMatch(result.stderr, /preflight/);
  });
});

// Issue #153 — parseMcpServersFromToml 은 section 이름에 dot 을 허용
// (`[a-zA-Z0-9_.-]+`) 하지만 과거 preflight 정규식 `[^.]+` 는 첫 dot 에서
// 끊어 `mcp_servers.foo.bar.enabled=true` 같은 dotted 서버를 candidate 에서
// 누락시켰다. `(.+)\.enabled=true$` 로 suffix anchor 를 고정해 dotted 이름도
// 정확히 캡처되도록 수정.
describe("#153 dotted server names — preflight regex 는 dot 포함", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("dotted dead 서버 (`foo.bar`) 가 candidate 로 추출되고 flag 가 제거된다", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.alive1.enabled=true",
        "-c",
        "mcp_servers.foo.bar.enabled=true",
        "-c",
        "mcp_servers.foo.bar.args=[]",
      ],
      deadList: "foo.bar",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    // dotted 서버의 모든 override (enabled=true + args=[]) 가 drop 된다.
    assert.deepEqual(result.remainingFlags, [
      "-c",
      "mcp_servers.alive1.enabled=true",
    ]);
    assert.match(result.stderr, /1개 dead MCP 제외 \(foo\.bar\)/);
  });

  it("dotted alive 서버는 flags 보존 (dead 아님 → 제외 안 됨)", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.foo.bar.enabled=true",
        "-c",
        "mcp_servers.baz.qux.enabled=true",
      ],
      deadList: "", // nothing dead
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    // 전부 alive 니까 flags 원본 유지.
    assert.deepEqual(result.remainingFlags, [
      "-c",
      "mcp_servers.foo.bar.enabled=true",
      "-c",
      "mcp_servers.baz.qux.enabled=true",
    ]);
  });

  it("dotted 서버 + all-dead → rc=78 조기 실패 (#148 과 동일 경로)", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.foo.bar.enabled=true",
        "-c",
        "mcp_servers.baz.qux.enabled=true",
      ],
      deadList: "foo.bar,baz.qux",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 78, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /조기 실패.*MCP 전부 dead/);
  });

  it("non-dotted 서버도 기존과 동일하게 동작 (회귀 없음)", () => {
    const result = runPreflight({
      flags: ["-c", "mcp_servers.simple.enabled=true"],
      deadList: "simple",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 78, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /전부 dead/);
  });
});
