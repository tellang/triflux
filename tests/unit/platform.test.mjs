import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IS_LINUX,
  IS_MAC,
  IS_WINDOWS,
  isPathWithin,
  normalizePath,
  PATH_SEP,
  pipePath,
  TEMP_DIR,
} from "../../hub/platform.mjs";

describe("hub/platform.mjs", () => {
  it("IS_WINDOWS/IS_MAC/IS_LINUX should be mutually exclusive", () => {
    const active = [IS_WINDOWS, IS_MAC, IS_LINUX].filter(Boolean);
    assert.equal(active.length, 1);
  });

  it("exports platform-aware TEMP_DIR and PATH_SEP constants", () => {
    assert.equal(typeof TEMP_DIR, "string");
    assert.ok(TEMP_DIR.length > 0);
    assert.equal(typeof PATH_SEP, "string");
    assert.ok(PATH_SEP === "/" || PATH_SEP === "\\");
  });

  it("normalizes Windows paths for comparison-friendly slash output", () => {
    assert.equal(
      normalizePath("C:\\Users\\tellang\\Desktop\\..\\tmp\\file.txt", {
        platform: "win32",
      }),
      "C:/Users/tellang/tmp/file.txt",
    );
  });

  it("normalizes POSIX paths without introducing Windows separators", () => {
    assert.equal(
      normalizePath("/tmp/project/../repo/file.txt", { platform: "linux" }),
      "/tmp/repo/file.txt",
    );
  });

  it("pipePath builds Windows named pipe paths", () => {
    assert.equal(
      pipePath("triflux", 1234, { platform: "win32" }),
      "\\\\.\\pipe\\triflux-1234",
    );
  });

  it("pipePath builds Unix socket paths in the supplied temp dir", () => {
    assert.equal(
      pipePath("triflux", 1234, { platform: "linux", tempDir: "/tmp" }),
      "/tmp/triflux-1234.sock",
    );
  });

  it("isPathWithin handles case-insensitive Windows paths", () => {
    assert.equal(
      isPathWithin("C:\\Work\\Repo\\src\\index.mjs", "c:\\work\\repo", {
        platform: "win32",
      }),
      true,
    );
  });

  it("isPathWithin rejects paths outside the target directory", () => {
    assert.equal(
      isPathWithin("/tmp/repo/../other/file.txt", "/tmp/repo", {
        platform: "linux",
      }),
      false,
    );
  });
});
