import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(__dirname, "..", ".tmp-setup-hud-sync");

const { scanHudFiles, SYNC_MAP, PLUGIN_ROOT } = await import(
  "../../scripts/setup.mjs"
);

function cleanTmpRoot() {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
}

function writeFixture(root, relativePath, content = "export default null;\n") {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

afterEach(cleanTmpRoot);

describe("setup-hud-sync: scanHudFiles", () => {
  it("hud 디렉토리를 재귀 스캔해 .mjs 파일만 sync 엔트리로 변환한다", () => {
    const pluginRoot = join(TMP_ROOT, "plugin");
    const claudeDir = join(TMP_ROOT, "claude");

    writeFixture(pluginRoot, "hud/colors.mjs");
    writeFixture(pluginRoot, "hud/providers/custom.mjs");
    writeFixture(pluginRoot, "hud/readme.txt", "ignore me\n");
    writeFixture(pluginRoot, "hud/omc-hud.mjs");
    writeFixture(pluginRoot, "hud/omc-hud.mjs.bak", "legacy backup\n");

    const entries = scanHudFiles(pluginRoot, claudeDir);
    const normalized = entries.map((entry) => ({
      ...entry,
      src: entry.src.replace(/\\/g, "/"),
      dst: entry.dst.replace(/\\/g, "/"),
    }));

    assert.deepEqual(normalized, [
      {
        src: `${pluginRoot.replace(/\\/g, "/")}/hud/colors.mjs`,
        dst: `${claudeDir.replace(/\\/g, "/")}/hud/colors.mjs`,
        label: "hud/colors.mjs",
      },
      {
        src: `${pluginRoot.replace(/\\/g, "/")}/hud/providers/custom.mjs`,
        dst: `${claudeDir.replace(/\\/g, "/")}/hud/providers/custom.mjs`,
        label: "hud/providers/custom.mjs",
      },
    ]);
  });

  it("hud 디렉토리가 없으면 빈 배열을 반환한다", () => {
    const pluginRoot = join(TMP_ROOT, "missing-plugin");
    const claudeDir = join(TMP_ROOT, "claude");

    mkdirSync(pluginRoot, { recursive: true });

    assert.deepEqual(scanHudFiles(pluginRoot, claudeDir), []);
  });
});

describe("setup-hud-sync: SYNC_MAP", () => {
  it("현재 hud 파일 목록을 동적으로 포함하고 레거시 omc-hud 파일은 제외한다", () => {
    const hudEntries = SYNC_MAP.filter((entry) =>
      entry.src
        .replace(/\\/g, "/")
        .startsWith(`${PLUGIN_ROOT.replace(/\\/g, "/")}/hud/`),
    );

    const labels = hudEntries.map((entry) => entry.label);

    assert.ok(
      labels.includes("hud/context-monitor.mjs"),
      "context-monitor.mjs must be auto-discovered",
    );
    assert.ok(
      labels.includes("hud/providers/claude.mjs"),
      "provider files must be discovered recursively",
    );
    assert.ok(
      labels.includes("hud-qos-status.mjs"),
      "hud-qos-status.mjs must remain synced",
    );
    assert.ok(
      !labels.includes("hud/omc-hud.mjs"),
      "legacy omc-hud.mjs must be excluded",
    );
    assert.ok(
      hudEntries.length >= 8,
      `expected at least 8 hud .mjs files to be synced, got ${hudEntries.length}`,
    );
  });
});
