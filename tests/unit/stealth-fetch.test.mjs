import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { exitCodeFor, stealthFetch } from "../../scripts/lib/stealth-fetch.mjs";
import { ensureCloakBrowser } from "../../scripts/setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, "..", "..", "bin", "triflux.mjs");

describe("stealthFetch", () => {
  it("returns not_installed when cloakbrowser cannot be imported", async () => {
    const error = new Error("Cannot find package 'cloakbrowser'");
    error.code = "ERR_MODULE_NOT_FOUND";

    const result = await stealthFetch("https://example.com", {
      _import: async () => {
        throw error;
      },
    });

    assert.deepEqual(result, { ok: false, reason: "not_installed" });
  });

  it("returns unsupported_platform before importing cloakbrowser", async () => {
    let imported = false;

    const result = await stealthFetch("https://example.com", {
      _platform: "freebsd",
      _arch: "x64",
      _import: async () => {
        imported = true;
        return {};
      },
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "unsupported_platform",
      platform: "freebsd",
      arch: "x64",
    });
    assert.equal(imported, false);
  });

  for (const [url, scheme] of [
    ["file:///etc/passwd", "file:"],
    ["data:text/plain,hello", "data:"],
    ["not a url", null],
  ]) {
    it(`blocks ${url} before importing cloakbrowser`, async () => {
      let imported = false;

      const result = await stealthFetch(url, {
        _import: async () => {
          imported = true;
          return {};
        },
      });

      assert.deepEqual(result, { ok: false, reason: "blocked_scheme", scheme });
      assert.equal(imported, false);
    });
  }

  it("returns html/text/status/finalUrl and closes the browser on success", async () => {
    let closed = false;
    const result = await stealthFetch("https://example.com/start", {
      _import: async () => ({
        launch: async () => ({
          newPage: async () => ({
            goto: async (url, options) => {
              assert.equal(url, "https://example.com/start");
              assert.deepEqual(options, { waitUntil: "load", timeout: 30000 });
              return {
                status: () => 204,
                url: () => "https://example.com/final",
              };
            },
            content: async () =>
              "<html><body><h1>Hello</h1><p>Stealth fetch</p></body></html>",
          }),
          close: async () => {
            closed = true;
          },
        }),
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.engine, "cloakbrowser");
    assert.equal(result.url, "https://example.com/start");
    assert.equal(result.finalUrl, "https://example.com/final");
    assert.equal(result.status, 204);
    assert.equal(
      result.html,
      "<html><body><h1>Hello</h1><p>Stealth fetch</p></body></html>",
    );
    assert.equal(result.text, "Hello Stealth fetch");
    assert.equal(closed, true);
  });

  it("returns runtime_error and closes the browser when navigation fails", async () => {
    let closed = false;

    const result = await stealthFetch("https://example.com", {
      _import: async () => ({
        launch: async () => ({
          newPage: async () => ({
            goto: async () => {
              throw new Error("blocked");
            },
            content: async () => "<html></html>",
          }),
          close: async () => {
            closed = true;
          },
        }),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "runtime_error");
    assert.match(result.error, /blocked/);
    assert.equal(closed, true);
  });
});

describe("exitCodeFor", () => {
  it("maps stealth fetch failure reasons to CLI exit codes", () => {
    assert.equal(exitCodeFor({ reason: "not_installed" }), 3);
    assert.equal(exitCodeFor({ reason: "unsupported_platform" }), 4);
    assert.equal(exitCodeFor({ reason: "runtime_error" }), 5);
    assert.equal(exitCodeFor({ reason: "blocked_scheme" }), 6);
    assert.equal(exitCodeFor({ reason: "unknown" }), 5);
    assert.equal(exitCodeFor({}), 5);
  });
});

describe("ensureCloakBrowser", () => {
  it("skips optional install in protected environments", () => {
    let resolved = false;
    let installed = false;
    let warned = false;

    const result = ensureCloakBrowser({
      env: { TFX_SKIP_CLOAKBROWSER_SETUP: "1" },
      requireResolve: () => {
        resolved = true;
      },
      execFileSyncFn: () => {
        installed = true;
      },
      warn: () => {
        warned = true;
      },
    });

    assert.deepEqual(result, {
      ok: true,
      installed: false,
      skipped: true,
      reason: "protected-env",
    });
    assert.equal(resolved, false);
    assert.equal(installed, false);
    assert.equal(warned, false);
  });

  it("skips optional install on unsupported platforms", () => {
    const warnings = [];
    let resolved = false;
    let installed = false;

    const result = ensureCloakBrowser({
      env: {},
      platform: "freebsd",
      arch: "x64",
      requireResolve: () => {
        resolved = true;
      },
      execFileSyncFn: () => {
        installed = true;
      },
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(result, {
      ok: true,
      installed: false,
      skipped: true,
      reason: "unsupported_platform",
    });
    assert.equal(resolved, false);
    assert.equal(installed, false);
    assert.match(warnings.join("\n"), /unsupported_platform/);
  });

  it("does not install when cloakbrowser resolves", () => {
    let installed = false;

    const result = ensureCloakBrowser({
      env: {},
      platform: "darwin",
      arch: "arm64",
      requireResolve: () => "/tmp/node_modules/cloakbrowser/index.js",
      execFileSyncFn: () => {
        installed = true;
      },
    });

    assert.deepEqual(result, {
      ok: true,
      installed: true,
      skipped: false,
      reason: "installed",
    });
    assert.equal(installed, false);
  });

  it("warns when optional install fails", () => {
    const warnings = [];
    let installed = false;

    const result = ensureCloakBrowser({
      env: {},
      platform: "darwin",
      arch: "arm64",
      requireResolve: () => {
        throw new Error("missing");
      },
      execFileSyncFn: () => {
        installed = true;
        throw new Error("npm failed");
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(result.ok, false);
    assert.equal(result.installed, false);
    assert.equal(result.skipped, false);
    assert.equal(result.reason, "install_failed");
    assert.match(result.error, /npm failed/);
    assert.equal(installed, true);
    assert.match(warnings.join("\n"), /optional setup failed/);
  });
});

describe("tfx stealth-fetch", () => {
  it("is listed in top-level help", () => {
    const result = spawnSync(process.execPath, [BIN_PATH, "--help"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /tfx stealth-fetch/);
  });

  it("reuses stealthFetch CLI behavior for blocked schemes", () => {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, "stealth-fetch", "data:text/plain,hello"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 6);
    assert.match(
      result.stderr.trim(),
      /^\[stealth-fetch\] 폴백: blocked_scheme$/,
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      reason: "blocked_scheme",
      scheme: "data:",
    });
  });
});
