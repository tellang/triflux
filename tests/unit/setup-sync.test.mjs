import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

// dynamic import to pick up fresh module state
const {
  detectDevMode,
  SYNC_MAP,
  BREADCRUMB_PATH,
  isSetupUserStateFile,
  SETUP_USER_STATE_FILES,
  getWorkerPackageSyncEntries,
  syncCodexHarnessAdapter,
  syncWorkerPackages,
  syncSkills,
} = await import("../../scripts/setup.mjs");

// ── helpers ──

const TMP_DIR = mkdtempSync(join(tmpdir(), "tfx-setup-sync-tmp-"));
const SETUP_TEST_HOME = mkdtempSync(join(tmpdir(), "tfx-setup-sync-"));
const SETUP_TEST_ENV = {
  ...process.env,
  TRIFLUX_TEST_HOME: SETUP_TEST_HOME,
  HOME: SETUP_TEST_HOME,
  USERPROFILE: SETUP_TEST_HOME,
};

mkdirSync(join(SETUP_TEST_HOME, ".codex"), { recursive: true });

after(() => {
  rmSync(SETUP_TEST_HOME, { recursive: true, force: true });
});

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

// ── tests ──

describe("setup-sync: detectDevMode", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  it(".git 디렉토리가 존재하면 true를 반환한다", () => {
    const fakeRoot = join(TMP_DIR, "with-git");
    mkdirSync(join(fakeRoot, ".git"), { recursive: true });
    assert.equal(detectDevMode(fakeRoot), true);
  });

  it(".git 디렉토리가 없으면 false를 반환한다", () => {
    const fakeRoot = join(TMP_DIR, "without-git");
    mkdirSync(fakeRoot, { recursive: true });
    assert.equal(detectDevMode(fakeRoot), false);
  });
});

describe("setup-sync: BREADCRUMB_PATH", () => {
  it("breadcrumb 경로는 ~/.claude/scripts/.tfx-pkg-root 형식이다", () => {
    // BREADCRUMB_PATH는 절대 경로
    assert.ok(BREADCRUMB_PATH.length > 0, "BREADCRUMB_PATH must not be empty");
    // .claude/scripts/.tfx-pkg-root 패턴 확인 (OS 구분자 무관)
    const normalized = BREADCRUMB_PATH.replace(/\\/g, "/");
    assert.ok(
      normalized.endsWith(".claude/scripts/.tfx-pkg-root"),
      `Expected path ending with .claude/scripts/.tfx-pkg-root, got: ${normalized}`,
    );
  });
});

describe("setup-sync: --sync 플래그 파싱", () => {
  it("--sync 플래그 전달 시 [sync] 메시지를 출력한다", () => {
    const result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs"), "--sync"],
      {
        timeout: 15000,
        encoding: "utf8",
        env: SETUP_TEST_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(
      result.includes("[sync]"),
      `Expected [sync] in output, got: ${result}`,
    );
  });

  it("--sync 플래그 없이 실행 시 [sync] 메시지가 출력되지 않는다", () => {
    const result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs")],
      {
        timeout: 15000,
        encoding: "utf8",
        env: SETUP_TEST_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(
      !result.includes("[sync]"),
      `Expected no [sync] in output, got: ${result}`,
    );
  });
});

describe("setup-sync: Codex tfx-harness adapter", () => {
  it("temp HOME에 Codex 관리 스킬 두 개를 동기화하고 재실행해도 idempotent하다", () => {
    execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs"), "--sync"],
      {
        timeout: 15000,
        encoding: "utf8",
        env: SETUP_TEST_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const source = join(
      PROJECT_ROOT,
      "adapters",
      "codex",
      "skills",
      "tfx-harness",
      "SKILL.md",
    );
    const installed = join(
      SETUP_TEST_HOME,
      ".codex",
      "skills",
      "tfx-harness",
      "SKILL.md",
    );
    assert.equal(readFileSync(installed, "utf8"), readFileSync(source, "utf8"));
    const adapterLiveSource = join(
      PROJECT_ROOT,
      "adapters",
      "codex",
      "skills",
      "tfx-live",
      "SKILL.md",
    );
    const liveSource = existsSync(adapterLiveSource)
      ? adapterLiveSource
      : join(PROJECT_ROOT, "skills", "tfx-live", "SKILL.md");
    const liveInstalled = join(
      SETUP_TEST_HOME,
      ".codex",
      "skills",
      "tfx-live",
      "SKILL.md",
    );
    assert.equal(
      readFileSync(liveInstalled, "utf8"),
      readFileSync(liveSource, "utf8"),
    );
    assert.equal(
      existsSync(join(dirname(liveInstalled), ".triflux-managed-skill")),
      true,
    );

    const result = syncCodexHarnessAdapter({
      destinationDir: join(SETUP_TEST_HOME, ".codex", "skills", "tfx-harness"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "noop");
  });

  it("user-owned Codex skill은 discovery root에 backup을 만들지 않고 보존한다", () => {
    cleanTmpDir();
    ensureTmpDir();
    const sourceDir = join(TMP_DIR, "codex-adapter-source");
    const destinationDir = join(TMP_DIR, "codex-adapter-destination");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), "tracked adapter\n");
    writeFileSync(join(destinationDir, "SKILL.md"), "user adapter\n");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = syncCodexHarnessAdapter({ sourceDir, destinationDir });
      assert.equal(result.ok, true);
      assert.equal(result.action, "skipped");
      assert.equal(result.reason, "user_owned_codex_skill");
      assert.equal("backupDir" in result, false);
    }
    assert.equal(
      readFileSync(join(destinationDir, "SKILL.md"), "utf8"),
      "user adapter\n",
    );
    assert.deepEqual(
      readdirSync(TMP_DIR).filter((name) => name.includes(".triflux-backup-")),
      [],
    );
  });

  it("managed Codex skill 갱신 뒤 discovery root에 previous/tmp 사본을 남기지 않는다", () => {
    cleanTmpDir();
    ensureTmpDir();
    const sourceDir = join(TMP_DIR, "managed-source");
    const destinationDir = join(TMP_DIR, "managed-destination");
    // staging 은 discovery root(TMP_DIR) 밖이어야 한다.
    const stagingRoot = mkdtempSync(join(tmpdir(), "tfx-setup-sync-staging-"));
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), "tracked adapter v2\n");
    writeFileSync(join(destinationDir, "SKILL.md"), "tracked adapter v1\n");
    writeFileSync(
      join(destinationDir, ".triflux-managed-skill"),
      "managed by triflux\n",
    );

    const result = syncCodexHarnessAdapter({
      sourceDir,
      destinationDir,
      stagingRoot,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "synced");
    assert.equal(
      readFileSync(join(destinationDir, "SKILL.md"), "utf8"),
      "tracked adapter v2\n",
    );
    assert.deepEqual(
      readdirSync(TMP_DIR).filter(
        (name) =>
          name.includes(".triflux-previous-") || name.includes(".triflux-tmp-"),
      ),
      [],
    );
    assert.deepEqual(readdirSync(stagingRoot), []);
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  it("CLI user-owned skip 메시지는 존재하지 않는 backupDir를 참조하지 않는다", () => {
    for (const relative of [
      "bin/triflux.mjs",
      "packages/triflux/bin/triflux.mjs",
    ]) {
      const text = readFileSync(join(PROJECT_ROOT, relative), "utf8");
      assert.equal(
        text.includes("codexHarnessSync.backupDir"),
        false,
        relative,
      );
    }
  });

  it("platform 비대상 adapter는 설치하지 않고 managed 사본만 지운다", () => {
    cleanTmpDir();
    ensureTmpDir();
    const sourceDir = join(TMP_DIR, "platform-source");
    const destinationDir = join(TMP_DIR, "platform-destination");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "SKILL.md"),
      "---\nname: tfx-harness\nplatform:\n  - win32\n---\nbody\n",
    );

    const fresh = syncCodexHarnessAdapter({
      sourceDir,
      destinationDir,
      platform: "darwin",
    });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.action, "unsupported");
    assert.equal(existsSync(destinationDir), false);

    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(destinationDir, "SKILL.md"), "old managed\n");
    writeFileSync(
      join(destinationDir, ".triflux-managed-skill"),
      "managed by triflux\n",
    );
    const removed = syncCodexHarnessAdapter({
      sourceDir,
      destinationDir,
      platform: "darwin",
    });
    assert.equal(removed.action, "removed");
    assert.equal(existsSync(destinationDir), false);

    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(destinationDir, "SKILL.md"), "user skill\n");
    const userOwned = syncCodexHarnessAdapter({
      sourceDir,
      destinationDir,
      platform: "darwin",
    });
    assert.equal(userOwned.action, "unsupported");
    assert.equal(
      readFileSync(join(destinationDir, "SKILL.md"), "utf8"),
      "user skill\n",
    );
    cleanTmpDir();
  });

  it("tracked adapter source가 없으면 fail-closed한다", () => {
    const result = syncCodexHarnessAdapter({
      sourceDir: join(TMP_DIR, "missing-codex-adapter"),
      destinationDir: join(TMP_DIR, "unused-codex-adapter"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, "blocked");
    assert.equal(result.reason, "codex_harness_adapter_source_missing");
  });
});

describe("setup-sync: SYNC_MAP", () => {
  it("SYNC_MAP은 최소 3개 항목을 포함한다", () => {
    assert.ok(Array.isArray(SYNC_MAP), "SYNC_MAP must be an array");
    assert.ok(
      SYNC_MAP.length >= 3,
      `Expected >= 3 entries, got ${SYNC_MAP.length}`,
    );
  });

  it("각 항목은 src, dst, label 필드를 가진다", () => {
    for (const entry of SYNC_MAP) {
      assert.ok(
        typeof entry.src === "string",
        `src must be string: ${JSON.stringify(entry)}`,
      );
      assert.ok(
        typeof entry.dst === "string",
        `dst must be string: ${JSON.stringify(entry)}`,
      );
      assert.ok(
        typeof entry.label === "string",
        `label must be string: ${JSON.stringify(entry)}`,
      );
    }
  });

  it("제거된 headless-guard 는 SYNC_MAP 에 다시 들어오지 않는다", () => {
    const stale = SYNC_MAP.filter((e) => /headless-guard/.test(e.label));
    assert.deepEqual(stale, []);
  });

  it("scripts/lib/*.sh도 SYNC_MAP에 포함한다 (#227)", () => {
    const entry = SYNC_MAP.find(
      (e) => e.label === "scripts/lib/codex-recovery.sh",
    );
    assert.ok(entry, "SYNC_MAP must include lib/codex-recovery.sh");
    assert.ok(
      entry.src.replace(/\\/g, "/").endsWith("/scripts/lib/codex-recovery.sh"),
      "src path must reference scripts/lib/codex-recovery.sh",
    );
    assert.ok(
      entry.dst
        .replace(/\\/g, "/")
        .endsWith("/.claude/scripts/lib/codex-recovery.sh"),
      "dst path must sync codex-recovery.sh into ~/.claude/scripts/lib",
    );
  });

  it("agent-map.json이 SYNC_MAP에 포함되어 있다", () => {
    const entry = SYNC_MAP.find((e) => e.label === "hub/team/agent-map.json");
    assert.ok(entry, "SYNC_MAP must include hub/team/agent-map.json");
    assert.ok(
      entry.src.replace(/\\/g, "/").includes("hub/team/agent-map.json"),
      "src path must reference agent-map.json",
    );
  });

  it("worker-utils.mjs가 SYNC_MAP에 포함되어 있다", () => {
    const entry = SYNC_MAP.find(
      (e) => e.label === "hub/workers/worker-utils.mjs",
    );
    assert.ok(entry, "SYNC_MAP must include hub/workers/worker-utils.mjs");
    assert.ok(
      entry.src.replace(/\\/g, "/").includes("hub/workers/worker-utils.mjs"),
      "src path must reference worker-utils.mjs",
    );
    assert.ok(
      entry.dst
        .replace(/\\/g, "/")
        .endsWith("/.claude/hub/workers/worker-utils.mjs"),
      "dst path must sync worker-utils.mjs into ~/.claude/hub",
    );
  });

  it("agent-map.json의 synced 경로가 tfx-route.sh 상대경로와 일치한다", () => {
    const routeEntry = SYNC_MAP.find((e) => e.label === "scripts/tfx-route.sh");
    const mapEntry = SYNC_MAP.find(
      (e) => e.label === "hub/team/agent-map.json",
    );
    assert.ok(routeEntry && mapEntry, "both entries must exist");
    // tfx-route.sh: ../hub/team/agent-map.json relative to its synced dir
    const expected = join(
      dirname(routeEntry.dst),
      "..",
      "hub",
      "team",
      "agent-map.json",
    );
    const normalized = (p) => p.replace(/\\/g, "/");
    assert.equal(
      normalized(mapEntry.dst),
      normalized(expected),
      `agent-map.json dst must resolve from tfx-route.sh relative path`,
    );
  });
});

describe("setup-sync: worker package mirrors", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  it("syncs @triflux package code into Claude worker node_modules", () => {
    const pluginRoot = join(TMP_DIR, "worker-package-root");
    const workerNodeModules = join(TMP_DIR, "claude-worker-node-modules");

    const coreSrc = join(pluginRoot, "packages", "core");
    const remoteSrc = join(pluginRoot, "packages", "remote");
    mkdirSync(join(coreSrc, "scripts", "lib"), { recursive: true });
    mkdirSync(join(remoteSrc, "hub", "team", "cli", "services"), {
      recursive: true,
    });
    mkdirSync(join(remoteSrc, "node_modules", "transitive"), {
      recursive: true,
    });

    writeFileSync(join(coreSrc, "package.json"), '{"name":"@triflux/core"}\n');
    writeFileSync(join(coreSrc, "scripts", "lib", "psmux-info.mjs"), "core\n");
    writeFileSync(
      join(remoteSrc, "package.json"),
      '{"name":"@triflux/remote"}\n',
    );
    writeFileSync(
      join(remoteSrc, "hub", "team", "cli", "services", "runtime-mode.mjs"),
      "remote\n",
    );
    writeFileSync(
      join(remoteSrc, "node_modules", "transitive", "stale.txt"),
      "skip\n",
    );

    const staleRemoteFile = join(
      workerNodeModules,
      "@triflux",
      "remote",
      "stale.txt",
    );
    mkdirSync(dirname(staleRemoteFile), { recursive: true });
    writeFileSync(staleRemoteFile, "old\n");

    const entries = getWorkerPackageSyncEntries({
      pluginRoot,
      workerNodeModules,
    });
    assert.deepEqual(entries.map((entry) => entry.label).sort(), [
      "@triflux/core worker package",
      "@triflux/remote worker package",
    ]);

    assert.equal(
      syncWorkerPackages({ pluginRoot, workerNodeModules }),
      2,
      "both worker packages should be refreshed",
    );
    assert.equal(
      readFileSync(
        join(
          workerNodeModules,
          "@triflux",
          "remote",
          "hub",
          "team",
          "cli",
          "services",
          "runtime-mode.mjs",
        ),
        "utf8",
      ),
      "remote\n",
    );
    assert.equal(existsSync(staleRemoteFile), false);
    assert.equal(
      existsSync(
        join(
          workerNodeModules,
          "@triflux",
          "remote",
          "node_modules",
          "transitive",
          "stale.txt",
        ),
      ),
      false,
      "nested package node_modules must not be copied",
    );
  });
});

describe("setup-sync: user-state file exclusions", () => {
  it("hosts.json is treated as user-state and excluded from setup asset sync", () => {
    assert.ok(
      SETUP_USER_STATE_FILES.has("hosts.json"),
      "hosts.json must be listed as user-state",
    );
    assert.equal(isSetupUserStateFile("hosts.json"), true);
    assert.equal(isSetupUserStateFile("SKILL.md"), false);
  });

  it("공용 스킬 동기화가 references를 갱신하고 사용자 파일을 보존한다", () => {
    const root = join(TMP_DIR, "shared-skills");
    const source = join(root, "package");
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    for (const relative of [
      "skills/tfx-live",
      "adapters/codex/skills/tfx-harness",
      "skills/tfx-example/references/nested",
    ]) {
      mkdirSync(join(source, relative), { recursive: true });
      if (!relative.includes("references"))
        writeFileSync(join(source, relative, "SKILL.md"), "skill");
    }
    writeFileSync(join(source, "skills/tfx-example/SKILL.md"), "example");
    writeFileSync(
      join(source, "skills/tfx-example/references/nested/guide.md"),
      "new guide",
    );
    writeFileSync(
      join(source, "skills/tfx-example/references/hosts.json"),
      "do not copy",
    );
    const installed = join(claudeDir, "skills/tfx-example/references");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "hosts.json"), "user hosts");
    const removed = join(claudeDir, "skills/tfx-plan");
    mkdirSync(removed, { recursive: true });
    writeFileSync(join(removed, ".triflux-managed-skill"), "managed");
    try {
      assert.equal(
        syncSkills({ pluginRoot: source, claudeDir, codexDir }).ok,
        true,
      );
      assert.equal(
        readFileSync(join(installed, "nested/guide.md"), "utf8"),
        "new guide",
      );
      assert.equal(
        readFileSync(join(installed, "hosts.json"), "utf8"),
        "user hosts",
      );
      assert.equal(existsSync(removed), false);
      assert.equal(
        syncSkills({ pluginRoot: source, claudeDir, codexDir }).changed,
        0,
      );
      const liveInstalled = join(codexDir, "skills/tfx-live/SKILL.md");
      assert.equal(readFileSync(liveInstalled, "utf8"), "skill");
      const liveAdapter = join(source, "adapters/codex/skills/tfx-live");
      mkdirSync(liveAdapter, { recursive: true });
      writeFileSync(join(liveAdapter, "SKILL.md"), "Codex live skill");
      assert.equal(
        syncSkills({ pluginRoot: source, claudeDir, codexDir }).ok,
        true,
      );
      assert.equal(readFileSync(liveInstalled, "utf8"), "Codex live skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("setup-sync: dry-run 실행", () => {
  // 훅 설치기(ensureCodexHooks/ensureAgyHooks)는 TEST_LOCK_PID 가 설정된 테스트
  // 실행 중에는 explicit seam 없이 실제 HOME 에 쓰지 않도록 자체 가드되어 있다
  // (scripts/ensure-*-hooks.mjs 참조). spawn 된 setup.mjs 도 TEST_LOCK_PID 를
  // 상속하므로 이 dry-run 은 실제 CLI config 를 오염시키지 않는다. setup.mjs 가
  // 백그라운드 프로세스(HUD pre-warm, MCP 점검)를 띄우기 때문에 HOME 자체를 tmp 로
  // 격리하면 정리 race(ENOTEMPTY)가 발생하므로 가드 방식을 쓴다.
  it("setup.mjs를 --help 없이 실행해도 에러 없이 종료된다", () => {
    // setup.mjs는 main()이 process.argv[1] 매칭 시에만 실행되므로
    // 직접 node로 실행하여 exit code 0 확인
    const _result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs")],
      {
        timeout: 15000,
        encoding: "utf8",
        env: SETUP_TEST_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // 정상 종료 — execFileSync는 non-zero exit 시 throw
    assert.ok(true, "setup.mjs exited successfully");
  });

  it("--sync 플래그로 실행해도 에러 없이 종료된다", () => {
    const _result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs"), "--sync"],
      {
        timeout: 15000,
        encoding: "utf8",
        env: SETUP_TEST_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(true, "setup.mjs --sync exited successfully");
  });
});
