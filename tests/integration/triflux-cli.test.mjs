import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "bin", "triflux.mjs");
const THROW_UNDEFINED_CODEX_CONFIG_FIXTURE = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "throw-undefined-codex-config.cjs",
).replace(/\\/g, "/");

function createHomeDir() {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-cli-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  return homeDir;
}

function runCli(args, { homeDir = createHomeDir(), env = {} } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...env,
    },
  });
}

function parseStdoutJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // stdout에 ANSI 코드가 섞일 수 있으므로 마지막 JSON 블록 추출
  const match = result.stdout.match(/\{[\s\S]*\}$/m);
  assert.ok(match, `JSON 블록을 찾을 수 없음: ${result.stdout.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

describe("triflux CLI JSON and schema surface", { timeout: 30000 }, () => {
  it("CLI startup should sweep stale triflux-cli temp dirs without deleting the active HOME dir", () => {
    const activeHomeDir = createHomeDir();
    const staleHomeDir = createHomeDir();
    const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    try {
      utimesSync(activeHomeDir, staleDate, staleDate);
      utimesSync(staleHomeDir, staleDate, staleDate);

      const result = runCli(["version", "--json"], { homeDir: activeHomeDir });
      const payload = parseStdoutJson(result);

      assert.ok(payload.triflux);
      assert.equal(
        existsSync(activeHomeDir),
        true,
        "active HOME dir should be preserved",
      );
      assert.equal(
        existsSync(staleHomeDir),
        false,
        "stale triflux-cli dir should be swept on startup",
      );
    } finally {
      rmSync(activeHomeDir, { recursive: true, force: true });
      rmSync(staleHomeDir, { recursive: true, force: true });
    }
  });

  it("version --json은 구조화된 버전 정보를 반환해야 한다", () => {
    const result = runCli(["version", "--json"]);
    const payload = parseStdoutJson(result);
    assert.ok(payload.triflux);
    assert.ok(payload.node);
    assert.equal(Object.hasOwn(payload, "tfx_route"), true);
    assert.equal(Object.hasOwn(payload, "hud"), true);
  });

  it("schema는 CLI 명세와 hub tool schema를 노출해야 한다", () => {
    const bundle = parseStdoutJson(runCli(["schema"]));
    assert.ok(bundle.commands.doctor);
    assert.ok(Array.isArray(bundle.hub_tools["x-triflux-mcp-tools"]));

    const delegate = parseStdoutJson(runCli(["schema", "delegate"]));
    assert.equal(delegate.tool, "delegate");
    assert.ok(delegate.inputSchema);
    assert.ok(delegate.outputSchema);
  });

  it("setup --dry-run은 JSON 액션 목록을 반환해야 한다", () => {
    const result = runCli(["setup", "--dry-run"]);
    const payload = parseStdoutJson(result);
    assert.equal(payload.dry_run, true);
    assert.ok(payload.actions.length > 0);
    assert.ok(payload.actions.some((action) => action.type === "sync"));
    assert.ok(
      payload.actions.some(
        (action) => action.label === "skill-alias:tfx-autopilot",
      ),
    );
    assert.ok(
      payload.actions.some(
        (action) => action.label === "headless-guard-fast.sh",
      ),
    );
    assert.ok(
      payload.actions.some(
        (action) => action.label === "hub/team/agent-map.json",
      ),
    );
  });

  it("setup --dry-run은 stale Codex 프로필도 update로 보고해야 한다", () => {
    const homeDir = createHomeDir();
    writeFileSync(
      join(homeDir, ".codex", "config.toml"),
      [
        "[profiles.gpt55_high]",
        'model = "legacy-model"',
        'model_reasoning_effort = "low"',
        "",
        "[profiles.gpt55_xhigh]",
        'model = "legacy-model"',
        'model_reasoning_effort = "medium"',
        "",
        "[profiles.gpt55_low]",
        'model = "legacy-model"',
        'model_reasoning_effort = "high"',
        "",
      ].join("\n"),
      "utf8",
    );

    const payload = parseStdoutJson(
      runCli(["setup", "--dry-run"], { homeDir }),
    );
    const codexProfiles = payload.actions.find(
      (action) => action.type === "codex-profiles",
    );

    assert.ok(codexProfiles, "codex-profiles action missing");
    assert.equal(codexProfiles.change, "update");
    assert.deepEqual(codexProfiles.profiles, [
      "gpt55_xhigh",
      "gpt55_high",
      "gpt55_med",
      "gpt55_low",
    ]);
    if (process.platform === "win32") {
      assert.equal(codexProfiles.windowsSandbox, true);
    }
  });

  it("doctor --json은 checks 배열을 포함해야 한다", () => {
    const result = runCli(["doctor", "--json"]);
    const payload = parseStdoutJson(result);
    assert.ok(Array.isArray(payload.checks));
    assert.equal(typeof payload.hook_coverage?.total, "number");
    assert.equal(typeof payload.hook_coverage?.registered, "number");
    assert.ok(Array.isArray(payload.hook_coverage?.missing));
    assert.ok(payload.checks.some((check) => check.name === "tfx-route.sh"));
    assert.ok(payload.checks.some((check) => check.name === "codex"));
    assert.ok(payload.checks.some((check) => check.name === "warmup-cache"));
  });

  it("doctor --json은 Serena MCP project binding / timeout 진단을 포함해야 한다", () => {
    const homeDir = createHomeDir();
    writeFileSync(
      join(homeDir, ".codex", "config.toml"),
      [
        "[mcp_servers.serena]",
        'command = "uvx"',
        'args = ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "--context", "codex"]',
        "startup_timeout_sec = 10",
        "",
      ].join("\n"),
      "utf8",
    );

    const payload = parseStdoutJson(runCli(["doctor", "--json"], { homeDir }));
    const serenaCheck = payload.checks.find(
      (check) => check.name === "serena-mcp",
    );
    assert.ok(serenaCheck, "serena-mcp check missing");
    assert.equal(serenaCheck.status, "issues");
    assert.equal(serenaCheck.project_binding, false);
    assert.equal(serenaCheck.startup_timeout_sec, 10);
  });

  it("multi status --json은 팀 상태가 없을 때 offline JSON을 반환해야 한다", () => {
    const result = runCli(["multi", "status", "--json"]);
    const payload = parseStdoutJson(result);
    assert.equal(payload.status, "offline");
    assert.equal(payload.alive, false);
  });

  it("setup은 tfx-auto의 별칭 스킬(autopilot, persist, fullcycle)을 동기화해야 한다", () => {
    const homeDir = createHomeDir();
    const setupResult = runCli(["setup"], { homeDir });
    assert.equal(
      setupResult.status,
      0,
      setupResult.stderr || setupResult.stdout,
    );

    const autopilotPath = join(
      homeDir,
      ".claude",
      "skills",
      "tfx-autopilot",
      "SKILL.md",
    );
    const sourcePath = join(
      homeDir,
      ".claude",
      "skills",
      "tfx-auto",
      "SKILL.md",
    );
    assert.equal(
      existsSync(autopilotPath),
      true,
      `alias missing: ${autopilotPath}`,
    );
    assert.equal(existsSync(sourcePath), true, `source missing: ${sourcePath}`);
    assert.match(
      readFileSync(autopilotPath, "utf8"),
      /^name:\s*tfx-autopilot$/m,
    );

    const listPayload = parseStdoutJson(
      runCli(["list", "--json"], { homeDir }),
    );
    assert.deepEqual(listPayload.skill_aliases, [
      { alias: "tfx-autopilot", source: "tfx-auto", installed: true },
      { alias: "tfx-persist", source: "tfx-auto", installed: true },
      { alias: "tfx-fullcycle", source: "tfx-auto", installed: true },
    ]);
    assert.equal(listPayload.user_skills.includes("tfx-autopilot"), false);
  });

  it("setup은 기존 inline Codex 프로필을 0.134 별도 파일로 마이그레이션해야 한다", () => {
    const homeDir = createHomeDir();
    const codexConfigPath = join(homeDir, ".codex", "config.toml");
    writeFileSync(
      codexConfigPath,
      [
        "[profiles.gpt55_high]",
        'model = "legacy-model"',
        "",
        "[profiles.gpt55_low]",
        'model = "legacy-model"',
        "",
        "[profiles.personal]",
        'model = "custom-model"',
        'model_reasoning_effort = "medium"',
        "",
        "# padding: realistic Codex config files are larger than setup's safety floor",
      ].join("\n"),
      "utf8",
    );

    const result = runCli(["setup"], {
      homeDir,
      env: { TFX_CODEX_CONFIG_SYNC: "1" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(
      result.stdout,
      /Codex profiles 설정 실패|Codex Profiles 자동 복구 실패/,
    );

    // Codex 0.134+: 프로필은 별도 파일로 이동하고 config.toml 의 inline [profiles.*] 는
    // 제거된다 (legacy gpt55_high/gpt55_low inline 테이블이 사라져야 한다).
    const updated = readFileSync(codexConfigPath, "utf8");
    assert.doesNotMatch(
      updated,
      /\[profiles\./,
      "inline [profiles.*] 는 config.toml 에서 제거되어야 한다 (codex 0.134+)",
    );
    const codexDir = join(homeDir, ".codex");
    assert.equal(
      readFileSync(join(codexDir, "gpt55_high.config.toml"), "utf8"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
    );
    assert.equal(
      readFileSync(join(codexDir, "gpt55_xhigh.config.toml"), "utf8"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
    );
    assert.equal(
      readFileSync(join(codexDir, "gpt55_low.config.toml"), "utf8"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "low"\n',
    );
    // 커스텀 inline 프로필도 별도 파일로 이관되어야 한다 (내용 보존, codex 0.134+).
    assert.equal(
      readFileSync(join(codexDir, "personal.config.toml"), "utf8"),
      'model = "custom-model"\nmodel_reasoning_effort = "medium"\n',
    );

    if (process.platform === "win32") {
      assert.match(updated, /\[windows\]\nsandbox = "elevated"/);
    }
  });

  it("setup은 non-Error 예외가 발생해도 undefined 경고를 노출하지 않아야 한다", () => {
    const homeDir = createHomeDir();
    const result = runCli(["setup"], {
      homeDir,
      env: {
        NODE_OPTIONS: `--require ${THROW_UNDEFINED_CODEX_CONFIG_FIXTURE}`,
        TFX_CODEX_CONFIG_SYNC: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /Codex profiles 설정 실패:\s*undefined/);
    assert.match(result.stdout, /Codex profiles 설정 실패:\s*unknown error/);
  });
});

describe("triflux CLI exit codes", { timeout: 30000 }, () => {
  it("알 수 없는 명령은 EXIT_ARG_ERROR(2)와 fix 필드를 반환해야 한다", () => {
    const result = runCli(["nope", "--json"]);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, 2);
    assert.equal(typeof payload.error.fix, "string");
  });

  it("손상된 settings.json은 setup에서 EXIT_CONFIG_ERROR(5)로 종료해야 한다", () => {
    const homeDir = createHomeDir();
    writeFileSync(
      join(homeDir, ".claude", "settings.json"),
      "{broken-json",
      "utf8",
    );
    const result = runCli(["setup"], { homeDir });
    assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /settings\.json 처리 실패|fix:/,
    );
  });
});
