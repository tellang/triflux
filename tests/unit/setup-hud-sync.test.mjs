import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("설치된 hud 가 상대 import 로 닿는 파일은 전부 SYNC_MAP 으로 복사된다", () => {
    // 상태줄은 ~/.claude/hud 사본으로 돈다. 저장소 경로로 도는 단위 테스트는
    // hud 밖으로 나가는 import 가 설치본에서 풀리지 않는 회귀를 잡지 못한다.
    const normalize = (value) => value.replace(/\\/g, "/");
    const srcByDst = new Map(
      SYNC_MAP.map((entry) => [normalize(entry.dst), entry.src]),
    );
    const hudRoot = `${normalize(PLUGIN_ROOT)}/hud/`;
    const queue = SYNC_MAP.filter((entry) =>
      normalize(entry.src).startsWith(hudRoot),
    ).map((entry) => normalize(entry.dst));
    const seen = new Set();
    const missing = [];
    const importPattern =
      /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

    while (queue.length > 0) {
      const dst = queue.shift();
      if (seen.has(dst)) continue;
      seen.add(dst);
      const source = readFileSync(srcByDst.get(dst), "utf8");
      for (const match of source.matchAll(importPattern)) {
        const target = normalize(join(dirname(dst), match[1]));
        if (srcByDst.has(target)) {
          queue.push(target);
        } else {
          missing.push(`${dst} -> ${match[1]}`);
        }
      }
    }

    assert.deepEqual(missing, []);
    assert.ok(seen.size >= 8, `expected to walk hud files, got ${seen.size}`);
  });
});
