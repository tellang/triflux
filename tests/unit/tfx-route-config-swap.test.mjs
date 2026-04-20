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
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";

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

  const baseToml = [
    "model = \"gpt-5.3\"",
    "",
    "[mcp_servers.tfx-hub]",
    'url = "http://127.0.0.1:27888/mcp"',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    "",
    "[profiles.codex53_high]",
    'model = "gpt-5.3-codex"',
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

  it("filter: backup 이 이미 있으면 swap 을 스킵한다 (double-swap 방지)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-swap-"));
    cleanupDirs.push(dir);
    const config = path.join(dir, "config.toml");
    const backup = `${config}.pre-exec`;
    writeFileSync(config, baseToml);
    writeFileSync(backup, "existing-backup");

    const script = `
set -u
_CODEX_CONFIG='${config}'
CODEX_CONFIG_FLAGS=('mcp_servers.tfx-hub.enabled=true')
${extractSwapFunction()}
_codex_config_swap filter
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(config, "utf8"),
      baseToml,
      "backup 존재 시 config 건드리지 않음",
    );
    assert.equal(
      readFileSync(backup, "utf8"),
      "existing-backup",
      "기존 backup 보존",
    );
    assert.match(result.stderr, /다른 워커가 사용 중/);
  });
});
