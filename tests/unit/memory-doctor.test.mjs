import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  computeHealthScore,
  createMemoryDoctor,
  parseFrontmatter,
} from "../../hub/memory-doctor.mjs";

const TMP = join(tmpdir(), "tfx-memory-doctor-test");

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  const dirs = {
    memory: join(TMP, "memory"),
    rules: join(TMP, "rules"),
    project: join(TMP, "project"),
    claude: join(TMP, "claude"),
    backup: join(TMP, "backups"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true });
}

function writeMemory(dir, filename, content) {
  writeFileSync(join(dir, filename), content, "utf8");
}

function writeMemoryWithFrontmatter(dir, filename, fields, body = "") {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n\n${body}`, "utf8");
}

// ── parseFrontmatter ──

describe("parseFrontmatter", () => {
  it("파싱 성공 — name, type 추출", () => {
    const result = parseFrontmatter("---\nname: test\ntype: user\n---\nbody");
    assert.equal(result.found, true);
    assert.equal(result.fields.name, "test");
    assert.equal(result.fields.type, "user");
    assert.equal(result.body, "body");
  });

  it("frontmatter 없으면 found=false", () => {
    const result = parseFrontmatter("no frontmatter here");
    assert.equal(result.found, false);
  });

  it("null/undefined 입력 처리", () => {
    assert.equal(parseFrontmatter(null).found, false);
    assert.equal(parseFrontmatter(undefined).found, false);
  });
});

// ── computeHealthScore ──

describe("computeHealthScore", () => {
  it("이슈 없으면 10점", () => {
    const checks = [
      { severity: "P0", issues: [], error: null },
      { severity: "P1", issues: [], error: null },
    ];
    assert.equal(computeHealthScore(checks), 10);
  });

  it("P0*2.0 + P1*0.5 + P2*0.2 공식 적용 (AC2)", () => {
    const checks = [
      { severity: "P0", issues: [{ file: "a" }], error: null },
      { severity: "P1", issues: [{ file: "b" }, { file: "c" }], error: null },
      { severity: "P2", issues: [{ file: "d" }], error: null },
    ];
    // 10 - (1*2.0 + 2*0.5 + 1*0.2) = 10 - 3.2 = 6.8
    assert.equal(computeHealthScore(checks), 6.8);
  });

  it("0 미만은 0으로 클램프", () => {
    const checks = [
      {
        severity: "P0",
        issues: new Array(10).fill({ file: "x" }),
        error: null,
      },
    ];
    assert.equal(computeHealthScore(checks), 0);
  });

  it("error 있는 체크는 무시", () => {
    const checks = [
      { severity: "P0", issues: [{ file: "a" }], error: "failed" },
    ];
    assert.equal(computeHealthScore(checks), 10);
  });
});

// ── createMemoryDoctor — scan ──

describe("createMemoryDoctor", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("scan()이 8개 체크 결과를 모두 반환한다 (AC1)", () => {
    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks, healthScore, summary } = doctor.scan();
    assert.equal(checks.length, 8);
    assert.equal(typeof healthScore, "number");
    assert.ok(summary.p0 >= 0);
    assert.ok(summary.p1 >= 0);
    assert.ok(summary.p2 >= 0);
  });

  it("빈 memoryDir에서도 에러 없이 동작한다", () => {
    const doctor = createMemoryDoctor({
      memoryDir: join(TMP, "nonexistent"),
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    assert.equal(checks.length, 8);
    for (const c of checks) assert.equal(c.error, null);
  });
});

// ── checkOrphanFiles ──

describe("checkOrphanFiles", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("MEMORY.md에 없는 디스크 파일을 감지한다", () => {
    writeMemory(
      dirs.memory,
      "MEMORY.md",
      "# Memory\n- [known](known.md) — desc\n",
    );
    writeMemory(dirs.memory, "known.md", "content");
    writeMemory(dirs.memory, "orphan.md", "orphan content");

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const orphanCheck = checks.find((c) => c.id === "orphan-files");
    assert.equal(orphanCheck.passed, false);
    assert.equal(orphanCheck.issues.length, 1);
    assert.equal(orphanCheck.issues[0].file, "orphan.md");
  });

  it("MEMORY.md가 없으면 빈 결과를 반환한다", () => {
    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const orphanCheck = checks.find((c) => c.id === "orphan-files");
    assert.equal(orphanCheck.passed, true);
  });

  it("fixOrphanFiles가 MEMORY.md에 링크를 추가한다 (AC3)", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# Memory\n");
    writeMemoryWithFrontmatter(dirs.memory, "orphan.md", {
      name: "Orphan",
      description: "desc",
      type: "feedback",
    });

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    doctor.fix("orphan-files");

    const updated = readFileSync(join(dirs.memory, "MEMORY.md"), "utf8");
    assert.ok(
      updated.includes("orphan.md"),
      "MEMORY.md should contain orphan.md link",
    );
  });
});

// ── checkPathsYamlBug ──

describe("checkPathsYamlBug", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("paths: YAML 배열 패턴을 감지한다", () => {
    writeMemory(
      dirs.rules,
      "bad.md",
      '---\npaths:\n  - "src/**/*.ts"\n  - "lib/**/*.ts"\n---\ncontent',
    );

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const pathsCheck = checks.find((c) => c.id === "paths-yaml-bug");
    assert.equal(pathsCheck.passed, false);
    assert.equal(pathsCheck.issues.length, 1);
  });

  it("globs: CSV 패턴은 통과시킨다", () => {
    writeMemory(
      dirs.rules,
      "good.md",
      "---\nglobs: src/**/*.ts, lib/**/*.ts\n---\ncontent",
    );

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const pathsCheck = checks.find((c) => c.id === "paths-yaml-bug");
    assert.equal(pathsCheck.passed, true);
  });

  it("fixPathsYamlBug가 paths → globs 변환한다 (AC4)", () => {
    writeMemory(
      dirs.rules,
      "bad.md",
      '---\npaths:\n  - "src/**/*.ts"\n  - "lib/**/*.ts"\n---\ncontent',
    );

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    doctor.fix("paths-yaml-bug");

    const updated = readFileSync(join(dirs.rules, "bad.md"), "utf8");
    assert.ok(updated.includes("globs:"), "should contain globs:");
    assert.ok(!updated.includes("paths:"), "should not contain paths:");
    assert.ok(updated.includes("src/**/*.ts"), "should preserve glob values");
  });
});

// ── checkTrifluxResidue ──

describe("checkTrifluxResidue", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("stale .omc/state 파일을 감지한다", () => {
    const stateDir = join(dirs.project, ".omc", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, "old.json");
    writeFileSync(filePath, "{}", "utf8");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    utimesSync(filePath, eightDaysAgo / 1000, eightDaysAgo / 1000);

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const residueCheck = checks.find((c) => c.id === "triflux-residue");
    assert.equal(residueCheck.issues.length >= 1, true);
  });
});

// ── backup ──

describe("backup", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("fix() 전 .tfx/backups/에 원본이 저장된다 (AC6)", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# Memory\n");
    writeMemoryWithFrontmatter(dirs.memory, "orphan.md", {
      name: "O",
      description: "d",
      type: "feedback",
    });

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const result = doctor.fix("orphan-files");
    assert.ok(result.backup != null, "backup dir should exist");
    assert.ok(existsSync(result.backup), "backup dir should be on disk");
    assert.ok(
      existsSync(join(result.backup, "manifest.json")),
      "manifest should exist",
    );
  });
});

// ── CI guard ──

describe("CI guard", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
    delete process.env.CI;
    delete process.env.DOCKER;
  });

  it("CI=true일 때 fix()가 스킵된다 (AC8)", () => {
    process.env.CI = "true";
    writeMemory(dirs.memory, "MEMORY.md", "# Memory\n");
    writeMemory(dirs.memory, "orphan.md", "content");

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const result = doctor.fix("orphan-files");
    assert.equal(result.action, "skipped_ci");
  });

  it("DOCKER=true일 때도 fix()가 스킵된다", () => {
    process.env.DOCKER = "true";
    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const result = doctor.fix("orphan-files");
    assert.equal(result.action, "skipped_ci");
  });
});

// ── error isolation ──

describe("error isolation", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("하나의 체크 실패가 다른 체크에 영향 없다 (AC9)", () => {
    // memory dir을 파일로 만들어서 readdir가 실패하도록
    const badDir = join(TMP, "badmem");
    writeFileSync(badDir, "not a dir", "utf8");

    const doctor = createMemoryDoctor({
      memoryDir: badDir,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    // should still return 8 checks, some may have empty results
    assert.equal(checks.length, 8);
  });
});

// ── P1/P2 checks ──

describe("P1/P2 checks", () => {
  let dirs;

  beforeEach(() => {
    dirs = setup();
  });
  afterEach(() => {
    cleanup();
  });

  it("rule-violation: 스킬 목록 패턴 감지", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# Memory\n- [cat](catalog.md)\n");
    writeMemory(
      dirs.memory,
      "catalog.md",
      "| 스킬 | CLI | 용도 |\n|------|-----|------|\n| tfx-auto | 자동 | 통합 |",
    );

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const rv = checks.find((c) => c.id === "rule-violation");
    assert.equal(rv.passed, false);
  });

  it("stale-references: 존재하지 않는 파일 참조 감지", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# Memory\n- [ref](ref.md)\n");
    writeMemory(
      dirs.memory,
      "ref.md",
      "see hub/nonexistent-file.mjs for details",
    );

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const sr = checks.find((c) => c.id === "stale-references");
    assert.equal(sr.passed, false);
  });

  it("language-inconsistency: 혼합 언어 감지", () => {
    writeMemory(
      dirs.memory,
      "MEMORY.md",
      "# M\n- [a](a.md)\n- [b](b.md)\n- [c](c.md)\n",
    );
    writeMemoryWithFrontmatter(dirs.memory, "a.md", {
      name: "한국어 메모리",
      description: "설명",
    });
    writeMemoryWithFrontmatter(dirs.memory, "b.md", {
      name: "또 다른 메모리",
      description: "설명",
    });
    writeMemoryWithFrontmatter(dirs.memory, "c.md", {
      name: "English only memory",
      description: "desc",
    });

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const lc = checks.find((c) => c.id === "language-inconsistency");
    assert.equal(lc.passed, false);
    assert.equal(lc.issues.length, 1);
    assert.ok(lc.issues[0].file === "c.md");
  });

  it("oversized-files: 50줄 초과 감지", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# M\n- [big](big.md)\n");
    writeMemory(
      dirs.memory,
      "big.md",
      Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
    );

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const os = checks.find((c) => c.id === "oversized-files");
    assert.equal(os.passed, false);
  });

  it("missing-user-memory: type:user 부재 감지", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# M\n- [f](f.md)\n");
    writeMemoryWithFrontmatter(dirs.memory, "f.md", {
      name: "feedback",
      type: "feedback",
    });

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const um = checks.find((c) => c.id === "missing-user-memory");
    assert.equal(um.passed, false);
  });

  it("missing-user-memory: type:user 있으면 통과", () => {
    writeMemory(dirs.memory, "MEMORY.md", "# M\n- [u](user.md)\n");
    writeMemoryWithFrontmatter(dirs.memory, "user.md", {
      name: "profile",
      type: "user",
    });

    const doctor = createMemoryDoctor({
      memoryDir: dirs.memory,
      rulesDir: dirs.rules,
      projectDir: dirs.project,
      claudeDir: dirs.claude,
      backupDir: dirs.backup,
    });
    const { checks } = doctor.scan();
    const um = checks.find((c) => c.id === "missing-user-memory");
    assert.equal(um.passed, true);
  });
});
