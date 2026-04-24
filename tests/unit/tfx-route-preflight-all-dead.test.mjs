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

  it("#170 all-dead default: graceful degradation (rc=0)", () => {
    // PR #170 회귀 fix: default 동작이 early-fail (rc=78) 에서 graceful (rc=0+marker) 로 변경.
    // 호출자 (run_codex_mcp 분기) 가 _TFX_MCP_DEGRADED 마커 보고 transport=exec 강제.
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
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /graceful degradation/);
    assert.match(result.stderr, /MCP 전부 dead/);
    assert.equal(result.remainingCount, 0);
  });

  it("#170 all-dead + TFX_MCP_FAIL_ON_ALL_DEAD=1 → rc=78 (opt-in early fail)", () => {
    // 옛 #148 동작은 TFX_MCP_FAIL_ON_ALL_DEAD=1 명시 opt-in 으로만 활성.
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.dead1.enabled=true",
        "-c",
        "mcp_servers.dead2.enabled=true",
      ],
      deadList: "dead1,dead2",
      envVars: { TFX_MCP_FAIL_ON_ALL_DEAD: "1" },
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 78, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /조기 실패.*MCP 전부 dead/);
    assert.match(result.stderr, /TFX_MCP_FAIL_ON_ALL_DEAD/);
  });

  it("all-dead + TFX_MCP_ALLOW_ALL_DEAD=1 (legacy alias) → rc=0 degraded 진행", () => {
    // TFX_MCP_ALLOW_ALL_DEAD=1 은 호환성 유지 — graceful degradation 의 explicit alias.
    // FAIL_ON_ALL_DEAD 기본 0 이므로 동작상 차이 없음 (테스트는 명시 opt-in 호환성 회귀 가드).
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
    assert.match(result.stderr, /graceful degradation/);
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

  it("dotted 서버 + all-dead → rc=0 graceful degradation (#170 default)", () => {
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
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /graceful degradation/);
  });

  it("dotted 서버 + all-dead + TFX_MCP_FAIL_ON_ALL_DEAD=1 → rc=78 (opt-in)", () => {
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.foo.bar.enabled=true",
        "-c",
        "mcp_servers.baz.qux.enabled=true",
      ],
      deadList: "foo.bar,baz.qux",
      envVars: { TFX_MCP_FAIL_ON_ALL_DEAD: "1" },
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 78, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /조기 실패.*MCP 전부 dead/);
  });

  it("non-dotted 서버 단독 dead → rc=0 graceful (#170 default 동작)", () => {
    const result = runPreflight({
      flags: ["-c", "mcp_servers.simple.enabled=true"],
      deadList: "simple",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /graceful degradation/);
  });
});

// PR #170 — graceful degradation marker 가 호출자 (run_codex_mcp 분기) 에서
// transport=exec 강제 + FULL_PROMPT 리셋 (MCP_HINT 제거) 을 trigger 한다.
// 이 분기가 회귀하면 dead MCP 환경에서 codex-mcp.mjs 가 spawn 되어 stall 재발.
describe("#170 transport degradation marker — source 분기 회귀 가드", () => {
  it("source 에 _TFX_MCP_DEGRADED 마커 + transport=exec 강제 분기", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    assert.match(
      source,
      /_TFX_MCP_DEGRADED:-0/,
      "_TFX_MCP_DEGRADED 마커 분기가 사라짐",
    );
    assert.match(
      source,
      /TFX_CODEX_TRANSPORT="exec"/,
      "transport=exec 강제 분기가 사라짐",
    );
    assert.match(
      source,
      /FULL_PROMPT="\$PROMPT"/,
      "FULL_PROMPT 리셋 (MCP_HINT 제거) 분기가 사라짐",
    );
  });

  it("source 에 TFX_MCP_FAIL_ON_ALL_DEAD opt-in 분기 포함", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    assert.match(
      source,
      /TFX_MCP_FAIL_ON_ALL_DEAD:-0/,
      "TFX_MCP_FAIL_ON_ALL_DEAD opt-in 이 사라지면 #148 동작 복원 불가",
    );
  });

  it("packages/triflux/scripts/tfx-route.sh mirror 가 main 과 byte-identical", () => {
    const main = readFileSync(SCRIPT_PATH, "utf8");
    const mirrorPath = path.join(
      REPO_ROOT,
      "packages",
      "triflux",
      "scripts",
      "tfx-route.sh",
    );
    const mirror = readFileSync(mirrorPath, "utf8");
    assert.equal(main, mirror, "mirror drift — patch 가 한쪽에만 적용됨");
  });
});

// PR #171 review P1-1: dotted MCP alive 카운트 회귀 가드.
// remaining_alive 정규식이 [^.]+ 면 dotted alive 만 남은 경우 false all-dead 판정.
describe("#170 P1-1 dotted alive survivor — false degraded 방지", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("dead 1개 + dotted alive 1개 → rc=0 정상 통과 (degraded 아님)", () => {
    // dotted alive 가 카운트 안 되면 remaining_alive=0 → degraded 로 빠짐.
    // 정상 동작: dotted alive 도 +1 → remaining_alive>=1 → degraded marker 미설정.
    const result = runPreflight({
      flags: [
        "-c",
        "mcp_servers.dead1.enabled=true",
        "-c",
        "mcp_servers.foo.bar.enabled=true",
      ],
      deadList: "dead1",
    });
    cleanupDirs.push(result.dir);
    assert.equal(result.preflightRc, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(
      result.stderr,
      /graceful degradation/,
      "dotted alive 1개 있는데도 degraded 로 빠짐 — 정규식 회귀",
    );
    // dotted alive flag 보존 + dead flag 제거 검증
    assert.deepEqual(result.remainingFlags, [
      "-c",
      "mcp_servers.foo.bar.enabled=true",
    ]);
  });

  it("source 의 remaining_alive 정규식이 dotted 허용 (`.+` 사용)", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    // [^.]+ 패턴이 remaining_alive 분기에 다시 나타나면 회귀
    const remainingAliveBlock = source.match(
      /remaining_alive=0[\s\S]{0,400}?for rflag/,
    );
    assert.ok(remainingAliveBlock, "remaining_alive 블록을 찾을 수 없음");
    // 같은 분기 내 정규식 추출
    const regexMatch = source.match(
      /remaining_alive=\$\(\(remaining_alive[\s\S]{0,200}?fi\s+done/,
    );
    assert.ok(
      !/\[\^\.\]\+/.test(regexMatch?.[0] || ""),
      "remaining_alive 정규식이 [^.]+ 로 회귀 (dotted alive 카운트 누락 위험)",
    );
  });
});

// PR #171 review P1-2: degraded 시 user 명시 transport=mcp 도 exec 강제.
describe("#170 P1-2 degraded transport mcp 강제 회귀 가드", () => {
  it("source 분기가 transport=auto 외 mcp 도 exec 강제 (warning 포함)", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    // 옛 패턴: && "$TFX_CODEX_TRANSPORT" == "auto" — 회귀 시 P1-2 재발
    assert.doesNotMatch(
      source,
      /_TFX_MCP_DEGRADED:-0.*?== "1"\s*&&\s*"\$TFX_CODEX_TRANSPORT"\s*==\s*"auto"/s,
      "_TFX_MCP_DEGRADED 분기가 transport=auto 만 대상으로 회귀 — user 명시 mcp 시 stall 재발",
    );
    assert.match(
      source,
      /TFX_CODEX_TRANSPORT=mcp.*all-MCP-dead.*exec 강제/,
      "transport=mcp + degraded 경고 메시지가 사라짐",
    );
  });
});
