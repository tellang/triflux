// tests/unit/tfx-route-config-swap.test.mjs
// BUG-H (#132): _codex_config_swap fail-safe 동작 검증.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "tfx-route.sh");

// tfx-route.sh 에서 _codex_config_swap 함수 정의만 추출해서 subshell 에 주입.
function extractSwapFunction() {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const start = source.indexOf("_codex_config_swap() {");
  assert.ok(start >= 0, "_codex_config_swap 정의를 찾을 수 없음");
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

function runSwap({ action, configContent, flags = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), "tfx-swap-"));
  const config = path.join(dir, "config.toml");
  writeFileSync(config, configContent);
  const backup = `${config}.pre-exec`;
  const flagsLiteral = flags.map((f) => `'${f}'`).join(" ");
  const funcDef = extractSwapFunction();

  const script = `
set -u
_CODEX_CONFIG='${config}'
CODEX_CONFIG_FLAGS=(${flagsLiteral})
${funcDef}
_codex_config_swap ${action}
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  const output = {
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    config: existsSync(config) ? readFileSync(config, "utf8") : null,
    backup: existsSync(backup) ? readFileSync(backup, "utf8") : null,
    backupExists: existsSync(backup),
    dir,
  };
  return output;
}

describe("BUG-H _codex_config_swap fail-safe", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // 500 bytes 미만은 'config.toml 손상 의심' 가드에 걸리므로 padding 섹션을 채운 fixture.
  // (v10.13.0 에서 size guard 가 추가되면서 기존 165 bytes fixture 가 정상 경로를 타지 못함.)
  const baseToml = [
    'model = "gpt-5.3"',
    'approval_mode = "auto"',
    'sandbox = "workspace-write"',
    "",
    "[mcp_servers.tfx-hub]",
    'url = "http://127.0.0.1:27888/mcp"',
    'description = "triflux hub MCP server for cross-CLI messaging"',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp@latest"]',
    "",
    "[mcp_servers.exa]",
    'command = "npx"',
    'args = ["-y", "exa-mcp-server"]',
    'env = { EXA_API_KEY = "placeholder-key-for-test-fixture-padding" }',
    "",
    "[mcp_servers.tavily]",
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-tavily"]',
    "",
    "[profiles.codex53_high]",
    'model = "gpt-5.3-codex"',
    'model_reasoning_effort = "high"',
    "",
    "[profiles.codex53_low]",
    'model = "gpt-5.3-codex"',
    'model_reasoning_effort = "low"',
    "",
    "[profiles.gpt54_xhigh]",
    'model = "gpt-5.4"',
    'model_reasoning_effort = "high"',
    "",
  ].join("\n");

  it("filter: allowed_pat 이 비면 config.toml 을 건드리지 않는다 (주요 버그 회귀 방지)", () => {
    const r = runSwap({
      action: "filter",
      configContent: baseToml,
      flags: [],
    });
    cleanupDirs.push(r.dir);
    assert.equal(r.exitCode, 0);
    assert.equal(r.config, baseToml, "config.toml 이 원본 그대로여야 함");
    assert.equal(r.backupExists, false, "swap 스킵 시 backup 도 생성하지 않음");
    assert.match(r.stderr, /fail-safe/);
  });

  it("filter: 허용 서버 패턴이 있으면 해당 서버만 남기고 나머지 제거", () => {
    const r = runSwap({
      action: "filter",
      configContent: baseToml,
      flags: ["mcp_servers.tfx-hub.enabled=true"],
    });
    cleanupDirs.push(r.dir);
    assert.equal(r.exitCode, 0);
    assert.match(r.config, /\[mcp_servers\.tfx-hub\]/);
    assert.doesNotMatch(
      r.config,
      /\[mcp_servers\.context7\]/,
      "비허용 서버는 제거되어야 함",
    );
    assert.match(r.config, /\[profiles\.codex53_high\]/, "프로필은 유지");
    assert.equal(r.backup, baseToml, "backup 은 원본 그대로");
  });

  it("restore: backup 이 있으면 config 를 원본으로 복원하고 backup 삭제", () => {
    // 먼저 filter 로 backup 생성
    const filter = runSwap({
      action: "filter",
      configContent: baseToml,
      flags: ["mcp_servers.tfx-hub.enabled=true"],
    });
    cleanupDirs.push(filter.dir);
    assert.equal(filter.exitCode, 0);
    // 그 다음 restore 를 동일 디렉토리에 적용
    const restoreScript = `
set -u
_CODEX_CONFIG='${path.join(filter.dir, "config.toml")}'
${extractSwapFunction()}
_codex_config_swap restore
`;
    const restored = spawnSync("bash", ["-c", restoreScript], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    assert.equal(restored.status, 0);
    const after = readFileSync(path.join(filter.dir, "config.toml"), "utf8");
    assert.equal(after, baseToml, "restore 후 원본과 동일");
    assert.equal(
      existsSync(path.join(filter.dir, "config.toml.pre-exec")),
      false,
      "restore 후 backup 은 삭제되어야 함",
    );
    assert.match(restored.stderr, /복원 완료/);
  });

  it("filter: backup + owner alive → swap 을 스킵한다 (double-swap 방지)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-swap-"));
    cleanupDirs.push(dir);
    const config = path.join(dir, "config.toml");
    const backup = `${config}.pre-exec`;
    const ownerFile = `${backup}.owner`;
    writeFileSync(config, baseToml);
    writeFileSync(backup, "existing-backup");
    // 살아있는 owner: 현재 bash 가 shell 에서 kill -0 성공할 수 있는 PID 를 script 내부에서 확보
    const bashConfig = config.replace(/\\/g, "/");
    const bashOwner = ownerFile.replace(/\\/g, "/");
    const script = `
set -u
# 살아있는 helper process 를 fork → owner 파일에 그 PID 기록
sleep 10 &
OWNER_PID=$!
echo "$OWNER_PID" > '${bashOwner}'
_CODEX_CONFIG='${bashConfig}'
CODEX_CONFIG_FLAGS=('mcp_servers.tfx-hub.enabled=true')
${extractSwapFunction()}
_codex_config_swap filter
kill "$OWNER_PID" 2>/dev/null || true
wait "$OWNER_PID" 2>/dev/null || true
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(config, "utf8"),
      baseToml,
      "owner alive 시 config 건드리지 않음",
    );
    assert.equal(
      readFileSync(backup, "utf8"),
      "existing-backup",
      "기존 backup 보존",
    );
    assert.match(result.stderr, /소유 워커 살아있음/);
  });
});

describe("#144/#66 stale lock owner-PID cleanup + backup-loss guard", () => {
  const cleanupDirs = [];
  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // 500 bytes 미만은 'config.toml 손상 의심' 가드에 걸리므로 padding 섹션을 채운 실제 크기의 fixture.
  const baseToml = [
    'model = "gpt-5.3"',
    'approval_mode = "auto"',
    'sandbox = "workspace-write"',
    "",
    "[mcp_servers.tfx-hub]",
    'url = "http://127.0.0.1:27888/mcp"',
    'description = "triflux hub MCP server for cross-CLI messaging"',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp@latest"]',
    "",
    "[mcp_servers.exa]",
    'command = "npx"',
    'args = ["-y", "exa-mcp-server"]',
    'env = { EXA_API_KEY = "placeholder-key-for-test-fixture-padding" }',
    "",
    "[mcp_servers.tavily]",
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-tavily"]',
    "",
    "[profiles.codex53_high]",
    'model = "gpt-5.3-codex"',
    'model_reasoning_effort = "high"',
    "",
    "[profiles.codex53_low]",
    'model = "gpt-5.3-codex"',
    'model_reasoning_effort = "low"',
    "",
    "[profiles.gpt54_xhigh]",
    'model = "gpt-5.4"',
    'model_reasoning_effort = "high"',
    "",
  ].join("\n");

  function setupBackup({ backupContent = baseToml, ownerPid = null }) {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-stale-"));
    const config = path.join(dir, "config.toml");
    const backup = `${config}.pre-exec`;
    const ownerFile = `${backup}.owner`;
    writeFileSync(config, baseToml);
    writeFileSync(backup, backupContent);
    if (ownerPid !== null) {
      writeFileSync(ownerFile, String(ownerPid));
    }
    return { dir, config, backup, ownerFile };
  }

  function runFilter({
    backupContent = baseToml,
    ownerPid = null,
    usePrescript = "",
  }) {
    const { dir, config, backup, ownerFile } = setupBackup({
      backupContent,
      ownerPid,
    });
    cleanupDirs.push(dir);
    const bashConfig = config.replace(/\\/g, "/");
    const script = `
set -u
${usePrescript}
_CODEX_CONFIG='${bashConfig}'
CODEX_CONFIG_FLAGS=('mcp_servers.tfx-hub.enabled=true')
${extractSwapFunction()}
_codex_config_swap filter
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    return {
      exitCode: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      config: existsSync(config) ? readFileSync(config, "utf8") : null,
      backup: existsSync(backup) ? readFileSync(backup, "utf8") : null,
      owner: existsSync(ownerFile)
        ? readFileSync(ownerFile, "utf8").trim()
        : null,
      backupExists: existsSync(backup),
      dir,
    };
  }

  // owner alive test 는 BUG-H "filter: backup + owner alive" 에서 커버됨 (중복 제거).

  it("owner PID dead + backup=원본 → 원본 복원 후 swap 재진행", () => {
    // PID 999999 는 대개 존재하지 않음 (ephemeral). 존재 여부와 무관하게 dead 로 가정하는 보호 로직은
    // kill -0 실패시 stale 분기. 만약 존재하면 skip (rare).
    const deadPid = 999999;
    const r = runFilter({ backupContent: baseToml, ownerPid: deadPid });
    if (/소유 워커 살아있음/.test(r.stderr)) {
      // very rare race: PID recycled to live process
      return;
    }
    assert.equal(r.exitCode, 0);
    assert.match(r.stderr, /stale backup 감지.*dead/);
    assert.match(r.stderr, /원본 복원 후 swap 재진행/);
    // 새 backup 은 원본이어야 함 (복원 경로를 탔으므로)
    assert.match(r.backup, /\[mcp_servers\.tfx-hub\]/);
    // config 는 필터링되어 context7 제거됨
    assert.doesNotMatch(r.config, /\[mcp_servers\.context7\]/);
  });

  it("owner file 없음 (legacy lock) + backup=원본 → 원본 복원 후 swap 진행", () => {
    const r = runFilter({ backupContent: baseToml, ownerPid: null });
    assert.equal(r.exitCode, 0);
    assert.match(r.stderr, /stale backup 감지.*pid=\?/);
    assert.match(r.stderr, /원본 복원 후 swap 재진행/);
    assert.match(r.backup, /\[mcp_servers\.tfx-hub\]/);
    assert.doesNotMatch(r.config, /\[mcp_servers\.context7\]/);
  });

  it("owner file 없음 + backup 작음(<500B) → 원본 소실 위험, 전체 swap 스킵", () => {
    const r = runFilter({ backupContent: "tiny", ownerPid: null });
    assert.equal(r.exitCode, 0);
    assert.match(r.stderr, /stale backup 작음/);
    assert.match(r.stderr, /swap 스킵/);
    // config 는 건드리지 않음 (안전), backup 도 수동 확인 유도
    assert.equal(r.config, baseToml);
    assert.equal(r.backup, "tiny", "작은 backup 은 수동 확인용으로 보존");
  });

  it("정상 swap 시 .owner 파일이 현재 PID 로 생성된다", () => {
    // backup 이 없는 초기 상태에서 filter → backup 과 .owner 모두 생성
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-owner-"));
    cleanupDirs.push(dir);
    const config = path.join(dir, "config.toml");
    writeFileSync(config, baseToml);
    const bashConfig = config.replace(/\\/g, "/");
    const script = `
set -u
_CODEX_CONFIG='${bashConfig}'
CODEX_CONFIG_FLAGS=('mcp_servers.tfx-hub.enabled=true')
${extractSwapFunction()}
_codex_config_swap filter
echo "OWNER=$(cat ${bashConfig}.pre-exec.owner 2>/dev/null || echo MISSING)"
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /OWNER=\d+/, "owner 파일에 PID 기록");
    assert.doesNotMatch(result.stdout, /OWNER=MISSING/);
  });

  it("restore 는 backup 과 .owner 를 같이 삭제한다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-restore-"));
    cleanupDirs.push(dir);
    const config = path.join(dir, "config.toml");
    const backup = `${config}.pre-exec`;
    const ownerFile = `${backup}.owner`;
    writeFileSync(config, baseToml);
    const script = `
set -u
_CODEX_CONFIG='${config}'
CODEX_CONFIG_FLAGS=('mcp_servers.tfx-hub.enabled=true')
${extractSwapFunction()}
_codex_config_swap filter
_codex_config_swap restore
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(backup), false, "backup 삭제");
    assert.equal(existsSync(ownerFile), false, ".owner 삭제");
    assert.equal(readFileSync(config, "utf8"), baseToml);
  });
});
