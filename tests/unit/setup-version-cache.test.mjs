import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const PROJECT_ROOT = join(__dirname, "..", "..");
const SETUP_SCRIPT = join(PROJECT_ROOT, "scripts", "setup.mjs");
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
).version;
const TMP_ROOT = join(PROJECT_ROOT, "tests", ".tmp-setup-version-cache");

function createTempHome(testName) {
  const tempHome = join(TMP_ROOT, testName);
  rmSync(tempHome, { recursive: true, force: true });
  mkdirSync(tempHome, { recursive: true });
  return tempHome;
}

function markerPathForHome(tempHome) {
  return join(tempHome, ".claude", "cache", "tfx-setup-marker.json");
}

function cleanupTmpRoot() {
  try {
    rmSync(TMP_ROOT, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {}
}

function runSetup(tempHome, args = []) {
  return execFileSync(process.execPath, [SETUP_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  });
}

afterEach(() => {
  cleanupTmpRoot();
});

describe("setup version cache", () => {
  it("writes the setup marker with the current package version after sync", () => {
    const tempHome = createTempHome("writes-marker");

    runSetup(tempHome);

    const markerPath = markerPathForHome(tempHome);
    assert.equal(
      existsSync(markerPath),
      true,
      "expected setup marker to be created",
    );

    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.version, PACKAGE_VERSION);
    assert.equal(typeof marker.timestamp, "number");
    assert.ok(
      marker.timestamp > 0,
      "expected timestamp to be a positive number",
    );
  });

  it("skips sync when the marker version already matches package.json", () => {
    const tempHome = createTempHome("skip-on-match");
    const markerPath = markerPathForHome(tempHome);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ version: PACKAGE_VERSION, timestamp: 1234 }),
      "utf8",
    );

    const output = runSetup(tempHome);

    assert.match(
      output,
      new RegExp(`setup: skip \\(v${PACKAGE_VERSION} already synced\\)`),
    );
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(
      marker.timestamp,
      1234,
      "skip path should not rewrite the marker",
    );
  });

  it("--force ignores the marker and rewrites it after sync", () => {
    const tempHome = createTempHome("force-bypass");
    const markerPath = markerPathForHome(tempHome);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ version: PACKAGE_VERSION, timestamp: 1 }),
      "utf8",
    );

    const output = runSetup(tempHome, ["--force"]);

    assert.doesNotMatch(output, /already synced/);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.version, PACKAGE_VERSION);
    assert.ok(
      marker.timestamp > 1,
      "force path should rewrite the marker timestamp",
    );
  });
});
